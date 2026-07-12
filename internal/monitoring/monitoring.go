// Package monitoring provides real-time system and container monitoring.
package monitoring

import (
	"context"
	"os/exec"
	"runtime"
	"sync"
	"time"

	"github.com/bakeweb/kathal-os/internal/docker"
	"github.com/shirou/gopsutil/v4/cpu"
	"github.com/shirou/gopsutil/v4/disk"
	"github.com/shirou/gopsutil/v4/mem"
	"github.com/shirou/gopsutil/v4/net"
)

type Manager struct {
	mu         sync.RWMutex
	cli        *docker.Client
	samples    []*SystemSample
	maxSamples int
}

type SystemSample struct {
	Timestamp    time.Time         `json:"timestamp"`
	CPU          *CPUInfo          `json:"cpu"`
	Memory       *MemoryInfo       `json:"memory"`
	Disk         *DiskInfo         `json:"disk"`
	Network      *NetworkInfo      `json:"network"`
	Containers   []*ContainerStats `json:"containers"`
}

type CPUInfo struct {
	Percent float64 `json:"percent"`
	Cores   int     `json:"cores"`
}

type MemoryInfo struct {
	Total     uint64  `json:"total"`
	Used      uint64  `json:"used"`
	Available uint64  `json:"available"`
	Percent   float64 `json:"percent"`
}

type DiskInfo struct {
	Total   uint64  `json:"total"`
	Used    uint64  `json:"used"`
	Free    uint64  `json:"free"`
	Percent float64 `json:"percent"`
}

type NetworkInfo struct {
	BytesSent   uint64 `json:"bytes_sent"`
	BytesRecv   uint64 `json:"bytes_recv"`
	PacketsSent uint64 `json:"packets_sent"`
	PacketsRecv uint64 `json:"packets_recv"`
}

type ContainerStats struct {
	ID          string  `json:"id"`
	Name        string  `json:"name"`
	CPUPercent  float64 `json:"cpu_percent"`
	MemoryUsage uint64  `json:"memory_usage"`
	MemoryLimit uint64  `json:"memory_limit"`
	NetIO       NetIO   `json:"net_io"`
	BlockIO     BlockIO `json:"block_io"`
	PIDs        uint64  `json:"pids"`
}

type NetIO struct {
	RxBytes uint64 `json:"rx_bytes"`
	TxBytes uint64 `json:"tx_bytes"`
}

type BlockIO struct {
	ReadBytes  uint64 `json:"read_bytes"`
	WriteBytes uint64 `json:"write_bytes"`
}

func NewManager(cli *docker.Client) *Manager {
	m := &Manager{
		cli:        cli,
		maxSamples: 60, // Keep 60 samples (1 per second = 1 minute)
		samples:    make([]*SystemSample, 0, 60),
	}
	go m.collectLoop()
	return m
}

func (m *Manager) collectLoop() {
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()

	for range ticker.C {
		sample := m.collect()
		m.mu.Lock()
		m.samples = append(m.samples, sample)
		if len(m.samples) > m.maxSamples {
			m.samples = m.samples[len(m.samples)-m.maxSamples:]
		}
		m.mu.Unlock()
	}
}

func (m *Manager) collect() *SystemSample {
	s := &SystemSample{
		Timestamp:  time.Now(),
		Containers: make([]*ContainerStats, 0),
	}

	// CPU
	if perc, err := cpu.Percent(0, false); err == nil && len(perc) > 0 {
		s.CPU = &CPUInfo{Percent: perc[0], Cores: runtime.NumCPU()}
	}

	// Memory
	if v, err := mem.VirtualMemory(); err == nil {
		s.Memory = &MemoryInfo{
			Total:     v.Total,
			Used:      v.Used,
			Available: v.Available,
			Percent:   v.UsedPercent,
		}
	}

	// Disk
	if v, err := disk.Usage("/"); err == nil {
		s.Disk = &DiskInfo{
			Total:   v.Total,
			Used:    v.Used,
			Free:    v.Free,
			Percent: v.UsedPercent,
		}
	}

	// Network
	if v, err := net.IOCounters(false); err == nil && len(v) > 0 {
		n := v[0]
		s.Network = &NetworkInfo{
			BytesSent:   n.BytesSent,
			BytesRecv:   n.BytesRecv,
			PacketsSent: n.PacketsSent,
			PacketsRecv: n.PacketsRecv,
		}
	}

	// Container stats (if Docker available)
	if m.cli != nil && m.cli.IsAvailable() {
		ctx := context.Background()
		containers, err := m.cli.ListContainers(ctx, true)
		if err == nil {
			for _, c := range containers {
				cs := &ContainerStats{
					ID:   c.ID,
					Name: c.Name,
				}
				s.Containers = append(s.Containers, cs)
			}
		}
	}

	return s
}

func (m *Manager) GetHistory() []*SystemSample {
	m.mu.RLock()
	defer m.mu.RUnlock()
	result := make([]*SystemSample, len(m.samples))
	copy(result, m.samples)
	return result
}

func (m *Manager) GetCurrent() *SystemSample {
	m.mu.RLock()
	defer m.mu.RUnlock()
	if len(m.samples) == 0 {
		return m.collect()
	}
	return m.samples[len(m.samples)-1]
}

func (m *Manager) GetContainerLogs(ctx context.Context, containerID string, tail int) (string, error) {
	if m.cli == nil || !m.cli.IsAvailable() {
		return "", nil
	}
	return m.cli.GetContainerLogs(ctx, containerID, tail)
}

func (m *Manager) ExecCommand(cmd string, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	c := exec.CommandContext(ctx, cmd, args...)
	output, err := c.CombinedOutput()
	return string(output), err
}

func init() {
	// Try to import gopsutil
}