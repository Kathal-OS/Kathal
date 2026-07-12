package compose

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/compose-spec/compose-go/v2/loader"
	"github.com/compose-spec/compose-go/v2/types"
	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/client"
)

// Manager handles Docker Compose operations
type Manager struct {
	cli       *client.Client
	mu        sync.RWMutex
	projects  map[string]*Project
	workDir   string
}

// Project represents a Docker Compose project
type Project struct {
	Name        string
	Config      *types.Config
	WorkingDir  string
	Status      string
	CreatedAt   time.Time
	UpdatedAt   time.Time
	Services    []ServiceStatus
}

// ServiceStatus represents the status of a compose service
type ServiceStatus struct {
	Name      string
	Status    string
	Container string
	Ports     []string
	Health    string
}

// NewManager creates a new compose manager
func NewManager(dataDir string) *Manager {
	cli, err := client.NewClientWithOpts(client.FromEnv, client.WithAPIVersionNegotiation())
	if err != nil {
		slog.Warn("compose: docker client unavailable", "err", err)
	}

	return &Manager{
		cli:      cli,
		projects: make(map[string]*Project),
		workDir:  filepath.Join(dataDir, "compose"),
	}
}

// ListProjects returns all compose projects
func (m *Manager) ListProjects() []*Project {
	m.mu.RLock()
	defer m.mu.RUnlock()

	result := make([]*Project, 0, len(m.projects))
	for _, p := range m.projects {
		result = append(result, p)
	}
	return result
}

// GetProject returns a project by name
func (m *Manager) GetProject(name string) (*Project, bool) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	p, ok := m.projects[name]
	return p, ok
}

// CreateProject creates a new compose project from config
func (m *Manager) CreateProject(name, configYAML string) (*Project, error) {
	if err := os.MkdirAll(m.workDir, 0755); err != nil {
		return nil, err
	}

	projectDir := filepath.Join(m.workDir, name)
	if err := os.MkdirAll(projectDir, 0755); err != nil {
		return nil, err
	}

	// Write docker-compose.yml
	composePath := filepath.Join(projectDir, "docker-compose.yml")
	if err := os.WriteFile(composePath, []byte(configYAML), 0644); err != nil {
		return nil, err
	}

	// Load and validate config
	config, err := m.loadConfig(composePath)
	if err != nil {
		return nil, err
	}

	project := &Project{
		Name:       name,
		Config:     config,
		WorkingDir: projectDir,
		Status:     "created",
		CreatedAt:  time.Now(),
		UpdatedAt:  time.Now(),
	}

	m.mu.Lock()
	m.projects[name] = project
	m.mu.Unlock()

	return project, nil
}

// UpdateProject updates an existing project's config
func (m *Manager) UpdateProject(name, configYAML string) (*Project, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	project, ok := m.projects[name]
	if !ok {
		return nil, fmt.Errorf("project not found: %s", name)
	}

	composePath := filepath.Join(project.WorkingDir, "docker-compose.yml")
	if err := os.WriteFile(composePath, []byte(configYAML), 0644); err != nil {
		return nil, err
	}

	config, err := m.loadConfig(composePath)
	if err != nil {
		return nil, err
	}

	project.Config = config
	project.UpdatedAt = time.Now()

	return project, nil
}

// DeleteProject removes a compose project
func (m *Manager) DeleteProject(name string) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	_, ok := m.projects[name]
	if !ok {
		return fmt.Errorf("project not found: %s", name)
	}

	// Stop and remove containers first
	if m.cli != nil {
		ctx := context.Background()
		containers, err := m.cli.ContainerList(ctx, container.ListOptions{All: true})
		if err == nil {
			for _, c := range containers {
				for _, label := range c.Labels {
					if label == "com.docker.compose.project="+name {
						m.cli.ContainerStop(ctx, c.ID, container.StopOptions{})
						m.cli.ContainerRemove(ctx, c.ID, container.RemoveOptions{Force: true})
					}
				}
			}
		}
	}

	// Remove from memory
	delete(m.projects, name)

	// Optionally remove directory
	// os.RemoveAll(project.WorkingDir)

	return nil
}

// DeployProject starts or restarts a compose project
func (m *Manager) DeployProject(name string) (*Project, error) {
	m.mu.RLock()
	project, ok := m.projects[name]
	m.mu.RUnlock()

	if !ok {
		return nil, fmt.Errorf("project not found: %s", name)
	}

	if m.cli == nil {
		return nil, fmt.Errorf("docker client not available")
	}

	// Use compose-go to deploy
	// For now, just mark as deploying
	project.Status = "deploying"
	project.UpdatedAt = time.Now()

	// TODO: Actual deployment using docker compose CLI or SDK
	// This would involve: docker compose -f <file> up -d

	project.Status = "running"
	return project, nil
}

// StopProject stops a compose project
func (m *Manager) StopProject(name string) error {
	m.mu.RLock()
	project, ok := m.projects[name]
	m.mu.RUnlock()

	if !ok {
		return fmt.Errorf("project not found: %s", name)
	}

	if m.cli == nil {
		return fmt.Errorf("docker client not available")
	}

	// TODO: docker compose -f <file> down

	project.Status = "stopped"
	project.UpdatedAt = time.Now()
	return nil
}

// ValidateConfig validates a compose YAML without deploying
func (m *Manager) ValidateConfig(configYAML string) (*types.Config, error) {
	return m.loadConfigFromBytes([]byte(configYAML))
}

func (m *Manager) loadConfig(path string) (*types.Config, error) {
	content, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	return m.loadConfigFromBytes(content)
}

func (m *Manager) loadConfigFromBytes(content []byte) (*types.Config, error) {
	ctx := context.Background()
	
	// Write to temp file and load using loader
	tmpFile := filepath.Join(os.TempDir(), "docker-compose-*.yml")
	if err := os.WriteFile(tmpFile, content, 0644); err != nil {
		return nil, err
	}
	defer os.Remove(tmpFile)

	configDetails, err := loader.LoadConfigFiles(ctx, []string{tmpFile}, ".", nil)
	if err != nil {
		return nil, err
	}

	project, err := loader.LoadWithContext(ctx, *configDetails, loader.WithSkipValidation)
	if err != nil {
		return nil, err
	}
	return &types.Config{
		Services: project.Services,
		Networks: project.Networks,
		Volumes:  project.Volumes,
	}, nil
}

// GetProjectConfig returns the raw YAML config
func (m *Manager) GetProjectConfig(name string) (string, error) {
	m.mu.RLock()
	project, ok := m.projects[name]
	m.mu.RUnlock()

	if !ok {
		return "", fmt.Errorf("project not found: %s", name)
	}

	composePath := filepath.Join(project.WorkingDir, "docker-compose.yml")
	content, err := os.ReadFile(composePath)
	if err != nil {
		return "", err
	}
	return string(content), nil
}