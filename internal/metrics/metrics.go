// Package metrics collects system and Docker metrics (cross-platform).
package metrics

import (
	"context"
	"fmt"
	"runtime"
	"sync"
	"time"

	"github.com/bakeweb/kathal-os/internal/docker"
	"github.com/shirou/gopsutil/v3/cpu"
	"github.com/shirou/gopsutil/v3/disk"
	"github.com/shirou/gopsutil/v3/load"
	"github.com/shirou/gopsutil/v3/mem"
	"github.com/shirou/gopsutil/v3/net"
	"github.com/shirou/gopsutil/v3/host"
)

// Collector gathers system and Docker metrics.
type Collector struct {
	docker *docker.Client
	cache  *Metrics
	mu     sync.RWMutex
}

// SystemMetrics holds system resource usage.
type SystemMetrics struct {
	CPU       float64       `json:"cpu"`
	CPUCores  int           `json:"cpuCores"`
	Memory    MemoryMetrics `json:"memory"`
	Disk      DiskMetrics   `json:"disk"`
	Network   NetworkMetrics `json:"network"`
	Load      LoadMetrics   `json:"load"`
	Uptime    uint64        `json:"uptime"`
	GoVersion string        `json:"goVersion"`
	Platform  string        `json:"platform"`
}

// MemoryMetrics holds memory usage.
type MemoryMetrics struct {
	Total     uint64  `json:"total"`
	Used      uint64  `json:"used"`
	Available uint64  `json:"available"`
	Percent   float64 `json:"percent"`
}

// DiskMetrics holds disk usage.
type DiskMetrics struct {
	Total   uint64  `json:"total"`
	Used    uint64  `json:"used"`
	Free    uint64  `json:"free"`
	Percent float64 `json:"percent"`
	Path    string  `json:"path"`
}

// NetworkMetrics holds network I/O.
type NetworkMetrics struct {
	BytesSent   uint64 `json:"bytesSent"`
	BytesRecv   uint64 `json:"bytesRecv"`
	PacketsSent uint64 `json:"packetsSent"`
	PacketsRecv uint64 `json:"packetsRecv"`
}

// LoadMetrics holds system load averages.
type LoadMetrics struct {
	Load1  float64 `json:"load1"`
	Load5  float64 `json:"load5"`
	Load15 float64 `json:"load15"`
}

// Metrics is the complete metrics snapshot.
type Metrics struct {
	System    *SystemMetrics `json:"system"`
	Docker    *DockerMetrics `json:"docker"`
	Timestamp int64          `json:"timestamp"`
}

// DockerMetrics holds Docker-specific metrics.
type DockerMetrics struct {
	ContainersRunning int `json:"containersRunning"`
	ContainersStopped int `json:"containersStopped"`
	ImagesCount       int `json:"imagesCount"`
}

// New creates a new metrics collector.
func New(dockerClient *docker.Client) *Collector {
	return &Collector{
		docker: dockerClient,
	}
}

// Collect gathers all metrics and caches the result.
func (c *Collector) Collect() (*Metrics, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	m := &Metrics{
		Timestamp: time.Now().Unix(),
	}

	// System metrics.
	sys, err := c.collectSystem(ctx)
	if err != nil {
		return nil, fmt.Errorf("system metrics: %w", err)
	}
	m.System = sys

	// Docker metrics (if available).
	if c.docker != nil && c.docker.IsAvailable() {
		dm, err := c.collectDocker(ctx)
		if err == nil {
			m.Docker = dm
		}
	}

	// Cache.
	c.mu.Lock()
	c.cache = m
	c.mu.Unlock()

	return m, nil
}

// GetCached returns the last collected metrics (fast, no I/O).
func (c *Collector) GetCached() *Metrics {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.cache
}

func (c *Collector) collectSystem(ctx context.Context) (*SystemMetrics, error) {
	m := &SystemMetrics{
		CPUCores:  runtime.NumCPU(),
		GoVersion: runtime.Version(),
		Platform:  runtime.GOOS,
	}

	// CPU usage.
	if cpuPcts, err := cpu.PercentWithContext(ctx, 100*time.Millisecond, false); err == nil && len(cpuPcts) > 0 {
		m.CPU = cpuPcts[0]
	}

	// Memory.
	if v, err := mem.VirtualMemoryWithContext(ctx); err == nil {
		m.Memory = MemoryMetrics{
			Total:     v.Total,
			Used:      v.Used,
			Available: v.Available,
			Percent:   v.UsedPercent,
		}
	}

	// Disk — cross-platform path.
	diskPath := diskPath()
	if d, err := disk.UsageWithContext(ctx, diskPath); err == nil {
		m.Disk = DiskMetrics{
			Total:   d.Total,
			Used:    d.Used,
			Free:    d.Free,
			Percent: d.UsedPercent,
			Path:    diskPath,
		}
	}

	// Network.
	if nets, err := net.IOCountersWithContext(ctx, false); err == nil && len(nets) > 0 {
		n := nets[0]
		m.Network = NetworkMetrics{
			BytesSent:   n.BytesSent,
			BytesRecv:   n.BytesRecv,
			PacketsSent: n.PacketsSent,
			PacketsRecv: n.PacketsRecv,
		}
	}

	// Load — available on Linux/Mac, not Windows.
	if l, err := load.AvgWithContext(ctx); err == nil {
		m.Load = LoadMetrics{
			Load1:  l.Load1,
			Load5:  l.Load5,
			Load15: l.Load15,
		}
	}

	// Uptime — cross-platform.
	if u, err := host.UptimeWithContext(ctx); err == nil {
		m.Uptime = u
	}

	return m, nil
}

func (c *Collector) collectDocker(ctx context.Context) (*DockerMetrics, error) {
	info, err := c.docker.GetSystemInfo(ctx)
	if err != nil {
		return nil, err
	}
	return &DockerMetrics{
		ContainersRunning: info.ContainersRunning,
		ContainersStopped: info.ContainersStopped,
		ImagesCount:       info.Images,
	}, nil
}

// diskPath returns the root path for disk metrics based on the OS.
func diskPath() string {
	switch runtime.GOOS {
	case "windows":
		return "C:\\"
	case "darwin":
		return "/"
	case "linux":
		return "/"
	default:
		return "/"
	}
}
