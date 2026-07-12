//go:build !windows

package monitoring

import (
	"bufio"
	"os"
	"strconv"
	"strings"
	"time"
)

func (c *Collector) readCPU() float64 {
	// Read /proc/stat for CPU usage
	f, err := os.Open("/proc/stat")
	if err != nil {
		return 0
	}
	defer f.Close()

	scanner := bufio.NewScanner(f)
	if scanner.Scan() {
		fields := strings.Fields(scanner.Text())
		if len(fields) >= 5 && fields[0] == "cpu" {
			user, _ := strconv.ParseUint(fields[1], 10, 64)
			nice, _ := strconv.ParseUint(fields[2], 10, 64)
			system, _ := strconv.ParseUint(fields[3], 10, 64)
			idle, _ := strconv.ParseUint(fields[4], 10, 64)
			total := user + nice + system + idle
			if total > 0 {
				cached := c.lastCPU
				if cached.total > 0 {
					dTotal := total - cached.total
					dIdle := idle - cached.idle
					if dTotal > 0 {
						c.lastCPU = cpuSnapshot{total: total, idle: idle}
						return float64(dTotal-dIdle) / float64(dTotal) * 100
					}
				}
				c.lastCPU = cpuSnapshot{total: total, idle: idle}
			}
		}
	}
	return 0
}

func (c *Collector) readMemory() MemMetrics {
	f, err := os.Open("/proc/meminfo")
	if err != nil {
		return MemMetrics{}
	}
	defer f.Close()

	m := MemMetrics{}
	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		line := scanner.Text()
		parts := strings.Fields(line)
		if len(parts) < 2 {
			continue
		}
		val, _ := strconv.ParseUint(parts[1], 10, 64)
		valKB := val / 1024 // Convert to MB

		switch strings.TrimSuffix(parts[0], ":") {
		case "MemTotal":
			m.TotalMB = valKB
		case "MemAvailable":
			m.FreeMB = valKB
		case "MemFree":
			if m.FreeMB == 0 {
				m.FreeMB = valKB
			}
		}
	}

	if m.TotalMB > 0 {
		m.UsedMB = m.TotalMB - m.FreeMB
		m.UsagePercent = float64(m.UsedMB) / float64(m.TotalMB) * 100
	}
	return m
}

func (c *Collector) readDisk() DiskMetrics {
	return readDiskUsage("/")
}

func (c *Collector) readNetwork() NetMetrics {
	f, err := os.Open("/proc/net/dev")
	if err != nil {
		return NetMetrics{}
	}
	defer f.Close()

	m := NetMetrics{}
	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		line := scanner.Text()
		if strings.Contains(line, "lo:") {
			continue
		}
		parts := strings.Fields(line)
		if len(parts) >= 10 {
			rx, _ := strconv.ParseUint(parts[1], 10, 64)
			tx, _ := strconv.ParseUint(parts[9], 10, 64)
			m.BytesReceived += rx
			m.BytesSent += tx
		}
	}
	return m
}

func (c *Collector) readLoad() LoadMetrics {
	data, err := os.ReadFile("/proc/loadavg")
	if err != nil {
		return LoadMetrics{}
	}
	var l LoadMetrics
	parts := strings.Fields(string(data))
	if len(parts) >= 3 {
		l.Load1, _ = strconv.ParseFloat(parts[0], 64)
		l.Load5, _ = strconv.ParseFloat(parts[1], 64)
		l.Load15, _ = strconv.ParseFloat(parts[2], 64)
	}
	return l
}

type cpuSnapshot struct {
	total uint64
	idle  uint64
}
