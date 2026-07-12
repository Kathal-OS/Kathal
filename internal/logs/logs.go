// Package logs provides centralized container log management.
package logs

import (
	"context"
	"sync"
	"time"

	"github.com/bakeweb/kathal-os/internal/docker"
)

type Manager struct {
	cli  *docker.Client
	mu   sync.RWMutex
	logs map[string]*LogBuffer
}

type LogBuffer struct {
	ContainerID    string    `json:"container_id"`
	ContainerName  string    `json:"container_name"`
	Lines          []LogLine `json:"lines"`
	mu             sync.Mutex
}

type LogLine struct {
	Timestamp time.Time `json:"timestamp"`
	Stream    string    `json:"stream"` // stdout/stderr
	Content   string    `json:"content"`
}

type LogQuery struct {
	ContainerID string
	Since       time.Time
	Until       time.Time
	Filter      string
	Tail        int
	Follow      bool
}

func NewManager(cli *docker.Client) *Manager {
	return &Manager{
		cli:  cli,
		logs: make(map[string]*LogBuffer),
	}
}

func (m *Manager) GetLogs(ctx context.Context, q LogQuery) ([]LogLine, error) {
	if m.cli == nil || !m.cli.IsAvailable() {
		return nil, nil
	}
	logStr, err := m.cli.GetContainerLogs(ctx, q.ContainerID, q.Tail)
	if err != nil {
		return nil, err
	}
	return parseLogString(logStr), nil
}

func parseLogString(logStr string) []LogLine {
	var lines []LogLine
	for _, line := range splitLines(logStr) {
		if line == "" {
			continue
		}
		lines = append(lines, LogLine{
			Timestamp: time.Now(),
			Stream:    "stdout",
			Content:   line,
		})
	}
	return lines
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

func (m *Manager) SearchLogs(ctx context.Context, containerID, query string, limit int) ([]LogLine, error) {
	logs, err := m.GetLogs(ctx, LogQuery{ContainerID: containerID, Tail: 1000})
	if err != nil {
		return nil, err
	}

	var results []LogLine
	for _, line := range logs {
		if len(results) >= limit {
			break
		}
		if query == "" || containsIgnoreCase(line.Content, query) {
			results = append(results, line)
		}
	}
	return results, nil
}

func containsIgnoreCase(s, substr string) bool {
	if len(substr) == 0 {
		return true
	}
	// Simple case-insensitive contains
	for i := 0; i <= len(s)-len(substr); i++ {
		match := true
		for j := 0; j < len(substr); j++ {
			c1 := s[i+j]
			c2 := substr[j]
			if c1 >= 'A' && c1 <= 'Z' {
				c1 += 32
			}
			if c2 >= 'A' && c2 <= 'Z' {
				c2 += 32
			}
			if c1 != c2 {
				match = false
				break
			}
		}
		if match {
			return true
		}
	}
	return false
}

func (m *Manager) ListContainers() ([]ContainerLogInfo, error) {
	if m.cli == nil || !m.cli.IsAvailable() {
		return nil, nil
	}
	ctx := context.Background()
	containers, err := m.cli.ListContainers(ctx, true)
	if err != nil {
		return nil, err
	}

	var result []ContainerLogInfo
	for _, c := range containers {
		result = append(result, ContainerLogInfo{
			ID:      c.ID,
			Name:    c.Name,
			Status:  c.State,
			Image:   c.Image,
			Created: c.Created,
		})
	}
	return result, nil
}

type ContainerLogInfo struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Status  string `json:"status"`
	Image   string `json:"image"`
	Created int64  `json:"created"`
}