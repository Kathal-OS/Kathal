// Package dbmanager provides database instance management via Docker containers.
// Supports PostgreSQL, MySQL, MongoDB, and Redis with automatic credential
// generation, connection string building, and persistent state.
package dbmanager

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"math/rand"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/client"
	"github.com/docker/go-connections/nat"
)

// Database represents a managed database instance running as a Docker container.
type Database struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Type      string `json:"type"`      // postgres, mysql, mongodb, redis
	Status    string `json:"status"`    // running, stopped, unknown
	Port      int    `json:"port"`      // host port
	User      string `json:"user"`
	Password  string `json:"password"`
	CreatedAt string `json:"created_at"`
}

// dbConfig holds per-database-type configuration.
type dbConfig struct {
	Image       string
	DefaultPort int
	DefaultUser string
	EnvBuilder  func(name, user, password string) []string
}

var dbConfigs = map[string]dbConfig{
	"postgres": {
		Image:       "postgres:16-alpine",
		DefaultPort: 5432,
		DefaultUser: "postgres",
		EnvBuilder: func(name, user, password string) []string {
			return []string{
				"POSTGRES_USER=" + user,
				"POSTGRES_PASSWORD=" + password,
				"POSTGRES_DB=" + name,
			}
		},
	},
	"mysql": {
		Image:       "mysql:8",
		DefaultPort: 3306,
		DefaultUser: "root",
		EnvBuilder: func(name, user, password string) []string {
			return []string{
				"MYSQL_ROOT_PASSWORD=" + password,
				"MYSQL_DATABASE=" + name,
				"MYSQL_USER=" + user,
				"MYSQL_PASSWORD=" + password,
			}
		},
	},
	"mongodb": {
		Image:       "mongo:7",
		DefaultPort: 27017,
		DefaultUser: "admin",
		EnvBuilder: func(name, user, password string) []string {
			return []string{
				"MONGO_INITDB_ROOT_USERNAME=" + user,
				"MONGO_INITDB_ROOT_PASSWORD=" + password,
			}
		},
	},
	"redis": {
		Image:       "redis:7-alpine",
		DefaultPort: 6379,
		DefaultUser: "",
		EnvBuilder: func(name, user, password string) []string {
			return []string{
				"REDIS_PASSWORD=" + password,
			}
		},
	},
}

const containerPrefix = "kathal-db-"

// Manager manages database instances running as Docker containers.
type Manager struct {
	mu      sync.RWMutex
	dbs     map[string]*Database
	docker  *client.Client
	dataDir string
	logger  *slog.Logger
}

// NewManager creates a new database manager connected to the given Docker daemon.
// dockerAddr is the Docker host, e.g. "unix:///var/run/docker.sock" or
// "npipe:////./pipe/docker_engine" on Windows, or "tcp://localhost:2375".
func NewManager(dockerAddr string) *Manager {
	logger := slog.Default().With("module", "dbmanager")

	// Ensure data directory exists.
	dataDir := filepath.Join(".", "data")
	if err := os.MkdirAll(dataDir, 0755); err != nil {
		logger.Error("failed to create data directory", "path", dataDir, "err", err)
	}

	// Create Docker client with API version negotiation for compatibility.
	cli, err := client.NewClientWithOpts(
		client.WithHost(dockerAddr),
		client.WithAPIVersionNegotiation(),
	)
	if err != nil {
		logger.Error("failed to create Docker client, database operations will fail", "err", err)
	}

	m := &Manager{
		dbs:     make(map[string]*Database),
		docker:  cli,
		dataDir: dataDir,
		logger:  logger,
	}

	m.loadDatabases()
	return m
}

// Create creates a new database container of the given type.
// If password is empty, a random 16-character password is generated.
// Returns the Database descriptor with connection details.
func (m *Manager) Create(name, dbType, password string) (*Database, error) {
	cfg, ok := dbConfigs[dbType]
	if !ok {
		return nil, fmt.Errorf("unsupported database type: %s (valid: postgres, mysql, mongodb, redis)", dbType)
	}

	if name == "" {
		return nil, fmt.Errorf("database name is required")
	}

	// Generate random password if not provided.
	if password == "" {
		password = generatePassword(16)
	}

	// Determine user.
	user := cfg.DefaultUser

	// Build container name.
	containerName := containerPrefix + sanitizeName(name)

	// Check for name collision.
	m.mu.RLock()
	for _, db := range m.dbs {
		if db.Name == name {
			m.mu.RUnlock()
			return nil, fmt.Errorf("database with name %q already exists", name)
		}
	}
	m.mu.RUnlock()

	// Build environment variables.
	envVars := cfg.EnvBuilder(name, user, password)

	// Configure container.
	ctx := context.Background()
	portStr := fmt.Sprintf("%d", cfg.DefaultPort)
	portProto := nat.Port(portStr + "/tcp")

	config := &container.Config{
		Image: cfg.Image,
		Env:   envVars,
		ExposedPorts: nat.PortSet{
			portProto: {},
		},
	}

	hostConfig := &container.HostConfig{
		PortBindings: nat.PortMap{
			portProto: []nat.PortBinding{
				{
					HostIP:   "0.0.0.0",
					HostPort: "0", // dynamic host port
				},
			},
		},
		RestartPolicy: container.RestartPolicy{
			Name: "unless-stopped",
		},
	}

	// Create the container.
	resp, err := m.docker.ContainerCreate(ctx, config, hostConfig, nil, nil, containerName)
	if err != nil {
		return nil, fmt.Errorf("create container %q: %w", containerName, err)
	}

	containerID := resp.ID

	// Start the container.
	if err := m.docker.ContainerStart(ctx, containerID, container.StartOptions{}); err != nil {
		return nil, fmt.Errorf("start container %q: %w", containerName, err)
	}

	// Inspect to get the actual host port.
	inspect, err := m.docker.ContainerInspect(ctx, containerID)
	if err != nil {
		return nil, fmt.Errorf("inspect container %q: %w", containerName, err)
	}

	hostPort := 0
	if bindings, ok := inspect.NetworkSettings.Ports[portProto]; ok && len(bindings) > 0 {
		fmt.Sscanf(bindings[0].HostPort, "%d", &hostPort)
	}

	db := &Database{
		ID:        containerID[:12],
		Name:      name,
		Type:      dbType,
		Status:    "running",
		Port:      hostPort,
		User:      user,
		Password:  password,
		CreatedAt: time.Now().UTC().Format(time.RFC3339),
	}

	m.mu.Lock()
	m.dbs[db.ID] = db
	m.mu.Unlock()

	if err := m.saveDatabases(); err != nil {
		m.logger.Error("failed to persist databases", "err", err)
	}

	m.logger.Info("database created",
		"id", db.ID,
		"name", name,
		"type", dbType,
		"port", hostPort,
	)

	return db, nil
}

// List returns all managed databases, sorted by name.
func (m *Manager) List() []*Database {
	m.mu.RLock()
	defer m.mu.RUnlock()

	dbs := make([]*Database, 0, len(m.dbs))
	for _, db := range m.dbs {
		dbs = append(dbs, db)
	}
	sort.Slice(dbs, func(i, j int) bool {
		return dbs[i].Name < dbs[j].Name
	})
	return dbs
}

// Delete stops and removes the database container, then removes it from state.
func (m *Manager) Delete(id string) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	db, ok := m.dbs[id]
	if !ok {
		return fmt.Errorf("database %s not found", id)
	}

	ctx := context.Background()
	containerName := containerPrefix + sanitizeName(db.Name)

	// Stop the container (ignore errors — it might already be stopped).
	timeout := 10
	_ = m.docker.ContainerStop(ctx, containerName, container.StopOptions{Timeout: &timeout})

	// Remove the container.
	if err := m.docker.ContainerRemove(ctx, containerName, container.RemoveOptions{
		Force: true,
	}); err != nil {
		m.logger.Warn("failed to remove container",
			"container", containerName,
			"err", err,
		)
	}

	delete(m.dbs, id)

	if err := m.saveDatabases(); err != nil {
		m.logger.Error("failed to persist databases after delete", "err", err)
	}

	m.logger.Info("database deleted", "id", id, "name", db.Name)
	return nil
}

// Get returns a database by its ID.
func (m *Manager) Get(id string) (*Database, bool) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	db, ok := m.dbs[id]
	return db, ok
}

// Start starts the Docker container for the given database.
func (m *Manager) Start(id string) error {
	m.mu.RLock()
	db, ok := m.dbs[id]
	m.mu.RUnlock()

	if !ok {
		return fmt.Errorf("database %s not found", id)
	}

	ctx := context.Background()
	containerName := containerPrefix + sanitizeName(db.Name)

	if err := m.docker.ContainerStart(ctx, containerName, container.StartOptions{}); err != nil {
		return fmt.Errorf("start database %q: %w", db.Name, err)
	}

	m.mu.Lock()
	db.Status = "running"
	m.mu.Unlock()

	if err := m.saveDatabases(); err != nil {
		m.logger.Error("failed to persist databases after start", "err", err)
	}

	m.logger.Info("database started", "id", id, "name", db.Name)
	return nil
}

// Stop stops the Docker container for the given database.
func (m *Manager) Stop(id string) error {
	m.mu.RLock()
	db, ok := m.dbs[id]
	m.mu.RUnlock()

	if !ok {
		return fmt.Errorf("database %s not found", id)
	}

	ctx := context.Background()
	containerName := containerPrefix + sanitizeName(db.Name)

	timeout := 15
	if err := m.docker.ContainerStop(ctx, containerName, container.StopOptions{Timeout: &timeout}); err != nil {
		return fmt.Errorf("stop database %q: %w", db.Name, err)
	}

	m.mu.Lock()
	db.Status = "stopped"
	m.mu.Unlock()

	if err := m.saveDatabases(); err != nil {
		m.logger.Error("failed to persist databases after stop", "err", err)
	}

	m.logger.Info("database stopped", "id", id, "name", db.Name)
	return nil
}

// GetConnectionString returns a connection string appropriate for the database type.
func (m *Manager) GetConnectionString(db *Database) string {
	if db == nil {
		return ""
	}

	host := "localhost"

	switch db.Type {
	case "postgres":
		return fmt.Sprintf(
			"postgres://%s:%s@%s:%d/%s?sslmode=disable",
			db.User, db.Password, host, db.Port, db.Name,
		)
	case "mysql":
		return fmt.Sprintf(
			"%s:%s@tcp(%s:%d)/%s?parseTime=true",
			db.User, db.Password, host, db.Port, db.Name,
		)
	case "mongodb":
		return fmt.Sprintf(
			"mongodb://%s:%s@%s:%d/%s?authSource=admin",
			db.User, db.Password, host, db.Port, db.Name,
		)
	case "redis":
		return fmt.Sprintf(
			"redis://:%s@%s:%d/0",
			db.Password, host, db.Port,
		)
	default:
		return ""
	}
}

// SyncStatus checks Docker for the actual running state of each managed
// container and updates the Status field accordingly.
func (m *Manager) SyncStatus() {
	ctx := context.Background()

	m.mu.Lock()
	defer m.mu.Unlock()

	for _, db := range m.dbs {
		containerName := containerPrefix + sanitizeName(db.Name)
		inspect, err := m.docker.ContainerInspect(ctx, containerName)
		if err != nil {
			db.Status = "unknown"
			continue
		}
		if inspect.State != nil && inspect.State.Running {
			db.Status = "running"
		} else {
			db.Status = "stopped"
		}

		// Update host port in case it changed.
		if cfg, ok := dbConfigs[db.Type]; ok {
			portProto := nat.Port(fmt.Sprintf("%d/tcp", cfg.DefaultPort))
			if bindings, ok := inspect.NetworkSettings.Ports[portProto]; ok && len(bindings) > 0 {
				var p int
				fmt.Sscanf(bindings[0].HostPort, "%d", &p)
				if p > 0 {
					db.Port = p
				}
			}
		}
	}

	if err := m.saveDatabases(); err != nil {
		m.logger.Error("failed to persist databases after sync", "err", err)
	}
}

// --- persistence ---

func (m *Manager) loadDatabases() {
	dbFile := filepath.Join(m.dataDir, "databases.json")
	data, err := os.ReadFile(dbFile)
	if err != nil {
		if !os.IsNotExist(err) {
			m.logger.Error("failed to load databases", "err", err)
		}
		return
	}

	var dbs []*Database
	if err := json.Unmarshal(data, &dbs); err != nil {
		m.logger.Error("failed to parse databases file", "err", err)
		return
	}

	for _, db := range dbs {
		m.dbs[db.ID] = db
	}

	m.logger.Info("loaded databases from disk", "count", len(m.dbs))
}

func (m *Manager) saveDatabases() error {
	dbs := make([]*Database, 0, len(m.dbs))
	for _, db := range m.dbs {
		dbs = append(dbs, db)
	}
	sort.Slice(dbs, func(i, j int) bool {
		return dbs[i].ID < dbs[j].ID
	})

	data, err := json.MarshalIndent(dbs, "", "  ")
	if err != nil {
		return fmt.Errorf("marshal databases: %w", err)
	}

	dbFile := filepath.Join(m.dataDir, "databases.json")
	return os.WriteFile(dbFile, data, 0644)
}

// --- helpers ---

// generatePassword returns a random alphanumeric password of the given length.
func generatePassword(length int) string {
	const charset = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
	b := make([]byte, length)
	for i := range b {
		b[i] = charset[rand.Intn(len(charset))]
	}
	return string(b)
}

// sanitizeName produces a Docker-safe container name segment.
func sanitizeName(s string) string {
	s = strings.ToLower(s)
	s = strings.Map(func(r rune) rune {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || r == '-' || r == '_' {
			return r
		}
		return '-'
	}, s)
	// Collapse multiple dashes.
	for strings.Contains(s, "--") {
		s = strings.ReplaceAll(s, "--", "-")
	}
	s = strings.Trim(s, "-")
	if len(s) > 64 {
		s = s[:64]
	}
	if s == "" {
		s = "db"
	}
	return s
}
