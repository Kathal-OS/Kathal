package env

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/client"
)

// Manager handles environment variables for containers and global scope
type Manager struct {
	cli       *client.Client
	mu        sync.RWMutex
	dataDir   string
	globalEnv map[string]string // Global environment variables
}

// EnvScope defines the scope of environment variables
type EnvScope string

const (
	ScopeGlobal    EnvScope = "global"
	ScopeContainer EnvScope = "container"
	ScopeService   EnvScope = "service"
)

// EnvVar represents an environment variable with metadata
type EnvVar struct {
	Key         string    `json:"key"`
	Value       string    `json:"value"`
	Scope       EnvScope  `json:"scope"`
	Target      string    `json:"target"`       // container ID or service name
	Description string    `json:"description"`
	Secret      bool      `json:"secret"`       // If true, value is hidden in UI
	CreatedAt   time.Time `json:"created_at"`
	UpdatedAt   time.Time `json:"updated_at"`
}

// NewManager creates a new environment manager
func NewManager(dataDir string) *Manager {
	cli, err := client.NewClientWithOpts(client.FromEnv, client.WithAPIVersionNegotiation())
	if err != nil {
		slog.Warn("env: docker client unavailable", "err", err)
	}

	m := &Manager{
		cli:       cli,
		dataDir:   filepath.Join(dataDir, "env"),
		globalEnv: make(map[string]string),
	}

	if err := os.MkdirAll(m.dataDir, 0755); err == nil {
		m.load()
	}

	return m
}

// SetGlobal sets a global environment variable
func (m *Manager) SetGlobal(key, value, description string, secret bool) {
	m.mu.Lock()
	defer m.mu.Unlock()

	m.globalEnv[key] = value
	m.persist()
}

// GetGlobal returns a global environment variable
func (m *Manager) GetGlobal(key string) (string, bool) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	v, ok := m.globalEnv[key]
	return v, ok
}

// DeleteGlobal removes a global environment variable
func (m *Manager) DeleteGlobal(key string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.globalEnv, key)
	m.persist()
}

// ListGlobal returns all global environment variables
func (m *Manager) ListGlobal() []EnvVar {
	m.mu.RLock()
	defer m.mu.RUnlock()

	result := make([]EnvVar, 0, len(m.globalEnv))
	for k, v := range m.globalEnv {
		result = append(result, EnvVar{
			Key:    k,
			Value:  v,
			Scope:  ScopeGlobal,
			Target: "global",
		})
	}
	return result
}

// SetContainerEnv sets environment variables for a container
func (m *Manager) SetContainerEnv(containerID string, env map[string]string) error {
	if m.cli == nil {
		return fmt.Errorf("docker client not available")
	}

	// Note: Docker doesn't allow changing env vars of running containers.
	// This would require recreating the container.
	// For now, we store the desired state for next deploy.
	return m.storeContainerEnv(containerID, env)
}

// GetContainerEnv returns environment variables for a container
func (m *Manager) GetContainerEnv(containerID string) (map[string]string, error) {
	if m.cli == nil {
		return nil, fmt.Errorf("docker client not available")
	}

	ctx := context.Background()
	inspect, err := m.cli.ContainerInspect(ctx, containerID)
	if err != nil {
		return nil, err
	}

	env := make(map[string]string)
	for _, e := range inspect.Config.Env {
		// Parse KEY=VALUE
		for i := 0; i < len(e); i++ {
			if e[i] == '=' {
				key := e[:i]
				value := e[i+1:]
				env[key] = value
				break
			}
		}
	}
	return env, nil
}

// ApplyGlobalToContainer applies global env vars to a container config
func (m *Manager) ApplyGlobalToContainer(config *container.Config) {
	m.mu.RLock()
	defer m.mu.RUnlock()

	for k, v := range m.globalEnv {
		config.Env = append(config.Env, fmt.Sprintf("%s=%s", k, v))
	}
}

// ListAll returns all environment variables across scopes
func (m *Manager) ListAll() []EnvVar {
	result := m.ListGlobal()

	// Add container-scoped env vars
	m.mu.RLock()
	for _, v := range m.globalEnv {
		result = append(result, EnvVar{
			Key:   v,
			Value: v,
			Scope: ScopeGlobal,
		})
	}
	m.mu.RUnlock()

	return result
}

func (m *Manager) persist() {
	// Save global env to file
	data, _ := json.MarshalIndent(m.globalEnv, "", "  ")
	os.WriteFile(filepath.Join(m.dataDir, "global.json"), data, 0644)
}

func (m *Manager) load() {
	data, err := os.ReadFile(filepath.Join(m.dataDir, "global.json"))
	if err == nil {
		json.Unmarshal(data, &m.globalEnv)
	}
}

func (m *Manager) storeContainerEnv(containerID string, env map[string]string) error {
	data, _ := json.MarshalIndent(env, "", "  ")
	return os.WriteFile(filepath.Join(m.dataDir, "container_"+containerID+".json"), data, 0644)
}

// ExportEnvFile exports all global env vars to a .env file
func (m *Manager) ExportEnvFile(path string) error {
	m.mu.RLock()
	defer m.mu.RUnlock()

	var lines []string
	for k, v := range m.globalEnv {
		lines = append(lines, fmt.Sprintf("%s=%s", k, v))
	}
	return os.WriteFile(path, []byte(fmt.Sprintf("%s\n", lines)), 0644)
}

// ImportEnvFile imports environment variables from a .env file
func (m *Manager) ImportEnvFile(path string) error {
	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}

	lines := string(data)
	for _, line := range splitLines(lines) {
		line = trimSpace(line)
		if line == "" || line[0] == '#' {
			continue
		}
		for i := 0; i < len(line); i++ {
			if line[i] == '=' {
				key := line[:i]
				value := line[i+1:]
				m.SetGlobal(key, value, "imported", false)
				break
			}
		}
	}
	return nil
}

func splitLines(s string) []string {
	var result []string
	start := 0
	for i := 0; i < len(s); i++ {
		if s[i] == '\n' {
			result = append(result, s[start:i])
			start = i + 1
		}
	}
	if start < len(s) {
		result = append(result, s[start:])
	}
	return result
}

func trimSpace(s string) string {
	start := 0
	for start < len(s) && (s[start] == ' ' || s[start] == '\t') {
		start++
	}
	end := len(s)
	for end > start && (s[end-1] == ' ' || s[end-1] == '\t' || s[end-1] == '\r') {
		end--
	}
	return s[start:end]
}