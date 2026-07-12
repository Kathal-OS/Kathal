// Package docker provides a cross-platform Docker client using direct HTTP calls.
// Supports Linux (Unix socket), Windows (named pipe), and Mac (Unix socket / Docker Desktop).
package docker

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"runtime"
	"strings"
	"time"
)

// Client wraps the Docker Engine API using direct HTTP calls.
type Client struct {
	httpClient *http.Client
	available  bool
}

// Container represents a simplified Docker container.
type Container struct {
	ID      string            `json:"id"`
	Name    string            `json:"name"`
	Image   string            `json:"image"`
	State   string            `json:"state"` // running, stopped, paused
	Status  string            `json:"status"`
	Ports   []PortMapping     `json:"ports"`
	Created int64             `json:"created"`
	Labels  map[string]string `json:"labels"`
}

// Image represents a Docker image.
type Image struct {
	ID       string   `json:"id"`
	RepoTags []string `json:"repoTags"`
	Size     int64    `json:"size"`
	Created  int64    `json:"created"`
}

// PortMapping maps host port to container port.
type PortMapping struct {
	HostPort      string `json:"hostPort"`
	ContainerPort string `json:"containerPort"`
	Protocol      string `json:"protocol"`
}

// SystemInfo holds Docker system information.
type SystemInfo struct {
	Containers        int    `json:"containers"`
	ContainersRunning int    `json:"containersRunning"`
	ContainersStopped int    `json:"containersStopped"`
	Images            int    `json:"images"`
	ServerVersion     string `json:"serverVersion"`
	StorageDriver     string `json:"storageDriver"`
	OperatingSystem   string `json:"operatingSystem"`
}

// Status holds the full system status (Docker + OS).
type Status struct {
	DockerAvailable bool        `json:"dockerAvailable"`
	DockerVersion   string      `json:"dockerVersion,omitempty"`
	DockerInfo      *SystemInfo `json:"dockerInfo,omitempty"`
	Platform        string      `json:"platform"`
	OSName          string      `json:"osName"`
	Arch            string      `json:"arch"`
}

// Network represents a Docker network
type Network struct {
	ID           string            `json:"Id"`
	Name         string            `json:"Name"`
	Driver       string            `json:"Driver"`
	Scope        string            `json:"Scope"`
	EnableIPv6   bool              `json:"EnableIPv6"`
	IPAM         IPAM              `json:"IPAM"`
	Containers   map[string]NetworkContainer `json:"Containers"`
	Labels       map[string]string `json:"Labels"`
	Created      string            `json:"Created"`
	Internal     bool              `json:"Internal"`
	Attachable   bool              `json:"Attachable"`
	Ingress      bool              `json:"Ingress"`
	ConfigFrom   NetworkConfigRef  `json:"ConfigFrom"`
	ConfigOnly   bool              `json:"ConfigOnly"`
}

type NetworkContainer struct {
	Name        string `json:"Name"`
	EndpointID  string `json:"EndpointID"`
	MacAddress  string `json:"MacAddress"`
	IPv4Address string `json:"IPv4Address"`
	IPv6Address string `json:"IPv6Address"`
}

type IPAM struct {
	Driver  string     `json:"Driver"`
	Options map[string]string `json:"Options"`
	Config  []IPAMConfig `json:"Config"`
}

type IPAMConfig struct {
	Subnet  string `json:"Subnet"`
	Gateway string `json:"Gateway"`
}

type NetworkConfigRef struct {
	Network string `json:"Network"`
}

// Volume represents a Docker volume
type Volume struct {
	Name       string            `json:"Name"`
	Driver     string            `json:"Driver"`
	Mountpoint string            `json:"Mountpoint"`
	Labels     map[string]string `json:"Labels"`
	Scope      string            `json:"Scope"`
	Options    map[string]string `json:"Options"`
	CreatedAt  string            `json:"CreatedAt"`
	UsageData  *VolumeUsageData  `json:"UsageData,omitempty"`
}

type VolumeUsageData struct {
	Size           int64 `json:"Size"`
	RefCount       int   `json:"RefCount"`
}

type VolumeListResponse struct {
	Volumes []Volume `json:"Volumes"`
	Warnings []string `json:"Warnings"`
}

type NetworkListResponse struct {
	Networks []Network `json:"Networks"` // Actually the response is just an array
}

// dockerSocket returns the platform-appropriate Docker socket path.
func dockerSocket() string {
	if host := envOr("DOCKER_HOST", ""); host != "" {
		return host
	}

	switch runtime.GOOS {
	case "linux", "darwin":
		return "unix:///var/run/docker.sock"
	case "windows":
		// Windows named pipe (Docker Desktop).
		return "npipe:////./pipe/docker_engine"
	default:
		return ""
	}
}

// NewClient creates a cross-platform Docker client.
// If Docker is not available, the client still works but IsAvailable() returns false.
func NewClient() *Client {
	socket := dockerSocket()
	if socket == "" {
		slog.Warn("kathal: unsupported platform, Docker integration disabled")
		return &Client{available: false}
	}

	var transport http.RoundTripper

	if strings.HasPrefix(socket, "unix://") || strings.HasPrefix(socket, "unix:") {
		// Linux / Mac: Unix domain socket.
		path := strings.TrimPrefix(socket, "unix://")
		path = strings.TrimPrefix(path, "unix:")
		transport = &http.Transport{
			DialContext: (&net.Dialer{
				Timeout:   5 * time.Second,
				KeepAlive: 30 * time.Second,
			}).DialContext,
			DialTLSContext: nil,
			MaxIdleConns:          100,
			IdleConnTimeout:       90 * time.Second,
			TLSHandshakeTimeout:  5 * time.Second,
			ResponseHeaderTimeout: 10 * time.Second,
			// Custom dialer for Unix socket.
			Dial: func(network, addr string) (net.Conn, error) {
				return net.DialTimeout("unix", path, 5*time.Second)
			},
		}
	} else if strings.HasPrefix(socket, "npipe:") {
		// Windows: Named pipe via TCP fallback (Docker Desktop exposes TCP on localhost:2375).
		// Docker Desktop default TCP endpoint.
		transport = &http.Transport{
			MaxIdleConns:        100,
			IdleConnTimeout:     90 * time.Second,
			TLSHandshakeTimeout: 5 * time.Second,
		}
		// Override socket to TCP for Windows.
		socket = "tcp://localhost:2375"
	} else {
		// TCP connection.
		transport = &http.Transport{
			MaxIdleConns:        100,
			IdleConnTimeout:     90 * time.Second,
			TLSHandshakeTimeout: 5 * time.Second,
		}
	}

	client := &Client{
		httpClient: &http.Client{
			Transport: transport,
			Timeout:   30 * time.Second,
		},
		available: true,
	}

	// Test connection.
	if !client.ping() {
		slog.Warn("kathal: Docker not available, running in system-only mode",
			"platform", runtime.GOOS,
			"socket", socket)
		client.available = false
	} else {
		slog.Info("kathal: Docker connected", "platform", runtime.GOOS, "socket", socket)
	}

	return client
}

// IsAvailable checks if Docker daemon is reachable.
func (c *Client) IsAvailable() bool {
	return c != nil && c.available
}

// GetStatus returns full system status.
func (c *Client) GetStatus(ctx context.Context) *Status {
	status := &Status{
		DockerAvailable: c.IsAvailable(),
		Platform:        runtime.GOOS,
		Arch:            runtime.GOARCH,
		OSName:          runtime.GOOS,
	}

	if status.DockerAvailable {
		info, err := c.GetSystemInfo(ctx)
		if err == nil {
			status.DockerInfo = info
			status.DockerVersion = info.ServerVersion
		}
	}

	return status
}

func (c *Client) ping() bool {
	resp, err := c.get("/_ping")
	if err != nil {
		return false
	}
	resp.Body.Close()
	return resp.StatusCode == http.StatusOK
}

// ListContainers returns all containers.
func (c *Client) ListContainers(ctx context.Context, all bool) ([]Container, error) {
	if !c.IsAvailable() {
		return nil, fmt.Errorf("Docker not available")
	}

	url := "/containers/json"
	if all {
		url += "?all=true"
	}

	resp, err := c.get(url)
	if err != nil {
		return nil, fmt.Errorf("list containers: %w", err)
	}
	defer resp.Body.Close()

	var raw []struct {
		ID      string            `json:"Id"`
		Names   []string          `json:"Names"`
		Image   string            `json:"Image"`
		State   string            `json:"State"`
		Status  string            `json:"Status"`
		Ports   []struct {
			PrivatePort int    `json:"PrivatePort"`
			PublicPort  int    `json:"PublicPort"`
			Type        string `json:"Type"`
		} `json:"Ports"`
		Created int64             `json:"Created"`
		Labels  map[string]string `json:"Labels"`
	}

	if err := json.NewDecoder(resp.Body).Decode(&raw); err != nil {
		return nil, fmt.Errorf("decode containers: %w", err)
	}

	containers := make([]Container, len(raw))
	for i, r := range raw {
		name := ""
		if len(r.Names) > 0 {
			name = strings.TrimPrefix(r.Names[0], "/")
		}
		var ports []PortMapping
		for _, p := range r.Ports {
			if p.PublicPort > 0 {
				ports = append(ports, PortMapping{
					HostPort:      fmt.Sprintf("%d", p.PublicPort),
					ContainerPort: fmt.Sprintf("%d", p.PrivatePort),
					Protocol:      p.Type,
				})
			}
		}
		containers[i] = Container{
			ID:      r.ID[:12],
			Name:    name,
			Image:   r.Image,
			State:   r.State,
			Status:  r.Status,
			Ports:   ports,
			Created: r.Created,
			Labels:  r.Labels,
		}
	}

	return containers, nil
}

// StartContainer starts a stopped container.
func (c *Client) StartContainer(ctx context.Context, id string) error {
	resp, err := c.post(fmt.Sprintf("/containers/%s/start", id), nil)
	if err != nil {
		return fmt.Errorf("start container %s: %w", id, err)
	}
	resp.Body.Close()
	if resp.StatusCode >= 400 {
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("start container %s: %s", id, string(body))
	}
	return nil
}

// StopContainer stops a running container.
func (c *Client) StopContainer(ctx context.Context, id string) error {
	resp, err := c.post(fmt.Sprintf("/containers/%s/stop", id), nil)
	if err != nil {
		return fmt.Errorf("stop container %s: %w", id, err)
	}
	resp.Body.Close()
	return nil
}

// RestartContainer restarts a container.
func (c *Client) RestartContainer(ctx context.Context, id string) error {
	resp, err := c.post(fmt.Sprintf("/containers/%s/restart", id), nil)
	if err != nil {
		return fmt.Errorf("restart container %s: %w", id, err)
	}
	resp.Body.Close()
	return nil
}

// RemoveContainer removes a container.
func (c *Client) RemoveContainer(ctx context.Context, id string, force bool) error {
	url := fmt.Sprintf("/containers/%s?force=%t", id, force)
	resp, err := c.delete(url)
	if err != nil {
		return fmt.Errorf("remove container %s: %w", id, err)
	}
	resp.Body.Close()
	if resp.StatusCode == 404 {
		return nil // already removed
	}
	if resp.StatusCode >= 400 {
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("remove container %s: %s", id, string(body))
	}
	return nil
}

// GetContainerLogs returns container logs.
func (c *Client) GetContainerLogs(ctx context.Context, id string, tail int) (string, error) {
	url := fmt.Sprintf("/containers/%s/logs?stdout=true&stderr=true&tail=%d", id, tail)
	resp, err := c.get(url)
	if err != nil {
		return "", fmt.Errorf("logs container %s: %w", id, err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", fmt.Errorf("read logs: %w", err)
	}

	return stripDockerHeaders(string(body)), nil
}

// ListImages returns all Docker images.
func (c *Client) ListImages(ctx context.Context) ([]Image, error) {
	if !c.IsAvailable() {
		return nil, fmt.Errorf("Docker not available")
	}

	resp, err := c.get("/images/json")
	if err != nil {
		return nil, fmt.Errorf("list images: %w", err)
	}
	defer resp.Body.Close()

	var raw []struct {
		ID       string   `json:"Id"`
		RepoTags []string `json:"RepoTags"`
		Size     int64    `json:"Size"`
		Created  int64    `json:"Created"`
	}

	if err := json.NewDecoder(resp.Body).Decode(&raw); err != nil {
		return nil, fmt.Errorf("decode images: %w", err)
	}

	images := make([]Image, len(raw))
	for i, r := range raw {
		images[i] = Image{
			ID:       r.ID[:12],
			RepoTags: r.RepoTags,
			Size:     r.Size,
			Created:  r.Created,
		}
	}

	return images, nil
}

// GetSystemInfo returns Docker system information.
func (c *Client) GetSystemInfo(ctx context.Context) (*SystemInfo, error) {
	resp, err := c.get("/info")
	if err != nil {
		return nil, fmt.Errorf("docker info: %w", err)
	}
	defer resp.Body.Close()

	var raw struct {
		Containers        int    `json:"Containers"`
		ContainersRunning int    `json:"ContainersRunning"`
		ContainersStopped int    `json:"ContainersStopped"`
		Images            int    `json:"Images"`
		ServerVersion     string `json:"ServerVersion"`
		StorageDriver     string `json:"StorageDriver"`
		OperatingSystem   string `json:"OperatingSystem"`
	}

	if err := json.NewDecoder(resp.Body).Decode(&raw); err != nil {
		return nil, fmt.Errorf("decode info: %w", err)
	}

	return &SystemInfo{
		Containers:        raw.Containers,
		ContainersRunning: raw.ContainersRunning,
		ContainersStopped: raw.ContainersStopped,
		Images:            raw.Images,
		ServerVersion:     raw.ServerVersion,
		StorageDriver:     raw.StorageDriver,
		OperatingSystem:   raw.OperatingSystem,
	}, nil
}

// ListNetworks returns all Docker networks
func (c *Client) ListNetworks(ctx context.Context) ([]Network, error) {
	if !c.IsAvailable() {
		return nil, fmt.Errorf("Docker not available")
	}

	resp, err := c.get("/networks")
	if err != nil {
		return nil, fmt.Errorf("list networks: %w", err)
	}
	defer resp.Body.Close()

	var networks []Network
	if err := json.NewDecoder(resp.Body).Decode(&networks); err != nil {
		return nil, fmt.Errorf("decode networks: %w", err)
	}

	return networks, nil
}

// ListVolumes returns all Docker volumes
func (c *Client) ListVolumes(ctx context.Context) ([]Volume, error) {
	if !c.IsAvailable() {
		return nil, fmt.Errorf("Docker not available")
	}

	resp, err := c.get("/volumes")
	if err != nil {
		return nil, fmt.Errorf("list volumes: %w", err)
	}
	defer resp.Body.Close()

	var volList VolumeListResponse
	if err := json.NewDecoder(resp.Body).Decode(&volList); err != nil {
		return nil, fmt.Errorf("decode volumes: %w", err)
	}

	return volList.Volumes, nil
}

// --- HTTP helpers ---

func (c *Client) get(path string) (*http.Response, error) {
	return c.do("GET", path, nil)
}

func (c *Client) post(path string, body io.Reader) (*http.Response, error) {
	return c.do("POST", path, body)
}

func (c *Client) delete(path string) (*http.Response, error) {
	return c.do("DELETE", path, nil)
}

func (c *Client) do(method, path string, body io.Reader) (*http.Response, error) {
	url := "http://localhost" + path
	req, err := http.NewRequest(method, url, body)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	return c.httpClient.Do(req)
}

// Public HTTP methods for network/volume operations
func (c *Client) Get(path string) (*http.Response, error) {
	return c.get(path)
}

func (c *Client) Post(path string, body io.Reader) (*http.Response, error) {
	return c.post(path, body)
}

func (c *Client) Delete(path string) (*http.Response, error) {
	return c.delete(path)
}

// stripDockerHeaders removes the 8-byte Docker log frame headers.
func stripDockerHeaders(s string) string {
	var result strings.Builder
	lines := strings.Split(s, "\n")
	for _, line := range lines {
		if len(line) > 8 && (line[0] < 32 || line[0] > 126) {
			result.WriteString(line[8:])
		} else {
			result.WriteString(line)
		}
		result.WriteString("\n")
	}
	return result.String()
}

func envOr(key, def string) string {
	if v := strings.TrimSpace(key); v != "" {
		return def
	}
	return def
}