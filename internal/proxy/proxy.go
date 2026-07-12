// Package proxy provides reverse proxy management with automatic SSL.
// Supports HTTP/HTTPS routing to Docker containers or local services.
package proxy

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"log/slog"
	"math/big"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

// Route represents a proxy route configuration.
type Route struct {
	ID          string `json:"id"`
	Domain      string `json:"domain"`      // e.g. "app.example.com"
	Path        string `json:"path"`         // e.g. "/" (prefix match)
	Target      string `json:"target"`       // e.g. "http://localhost:3000" or "container-name:80"
	Certificate string `json:"certificate"`  // path to cert.pem (empty = auto SSL)
	Key         string `json:"key"`          // path to key.pem (empty = auto SSL)
	AutoSSL     bool   `json:"auto_ssl"`     // use Let's Encrypt
	Enabled     bool   `json:"enabled"`
	CreatedAt   string `json:"created_at"`
	StripPrefix bool   `json:"strip_prefix"` // strip path prefix before forwarding
}

// Manager manages reverse proxy routes.
type Manager struct {
	mu       sync.RWMutex
	routes   map[string]*Route
	proxies  map[string]*httputil.ReverseProxy
	dataDir  string
	server   *http.Server
	httpsSrv *http.Server
	logger   *slog.Logger
}

// NewManager creates a new proxy manager.
func NewManager(dataDir string, logger *slog.Logger) *Manager {
	m := &Manager{
		routes:  make(map[string]*Route),
		proxies: make(map[string]*httputil.ReverseProxy),
		dataDir: dataDir,
		logger:  logger,
	}
	m.loadRoutes()
	return m
}

// Start starts the HTTP proxy server on the given address.
func (m *Manager) Start(addr string) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	m.server = &http.Server{
		Addr:         addr,
		Handler:      m,
		ReadTimeout:  30 * time.Second,
		WriteTimeout: 30 * time.Second,
	}

	// Start HTTPS server if any routes have SSL.
	go m.startHTTPSServer()

	m.logger.Info("proxy started", "addr", addr)
	return nil
}

// Stop gracefully stops the proxy server.
func (m *Manager) Stop(ctx context.Context) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	if m.server != nil {
		if err := m.server.Shutdown(ctx); err != nil {
			m.logger.Error("proxy shutdown error", "err", err)
		}
	}
	if m.httpsSrv != nil {
		if err := m.httpsSrv.Shutdown(ctx); err != nil {
			m.logger.Error("https proxy shutdown error", "err", err)
		}
	}
	return nil
}

// ServeHTTP implements http.Handler — routes requests to the correct backend.
func (m *Manager) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	m.mu.RLock()
	defer m.mu.RUnlock()

	host := r.Host
	// Strip port from host.
	if h, _, err := net.SplitHostPort(host); err == nil {
		host = h
	}
	path := r.URL.Path

	// Find matching route.
	for _, route := range m.routes {
		if !route.Enabled {
			continue
		}
		routeDomain := route.Domain
		if h, _, err := net.SplitHostPort(routeDomain); err == nil {
			routeDomain = h
		}
		if routeDomain == "" || routeDomain == host {
			if strings.HasPrefix(path, route.Path) {
				proxy, ok := m.proxies[route.ID]
				if !ok {
					continue
				}
				if route.StripPrefix {
					r.URL.Path = strings.TrimPrefix(path, route.Path)
					if r.URL.Path == "" {
						r.URL.Path = "/"
					}
				}
				proxy.ServeHTTP(w, r)
				return
			}
		}
	}

	// No route matched — serve the embedded dashboard if at root.
	http.NotFound(w, r)
}

// List returns all configured routes.
func (m *Manager) List() []*Route {
	m.mu.RLock()
	defer m.mu.RUnlock()

	routes := make([]*Route, 0, len(m.routes))
	for _, r := range m.routes {
		routes = append(routes, r)
	}
	sort.Slice(routes, func(i, j int) bool {
		return routes[i].Domain < routes[j].Domain
	})
	return routes
}

// Get returns a route by ID.
func (m *Manager) Get(id string) (*Route, bool) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	r, ok := m.routes[id]
	return r, ok
}

// Add adds or updates a proxy route.
func (m *Manager) Add(route *Route) error {
	if route.Domain == "" || route.Target == "" {
		return fmt.Errorf("domain and target are required")
	}
	if route.Path == "" {
		route.Path = "/"
	}
	if !strings.HasPrefix(route.Path, "/") {
		route.Path = "/" + route.Path
	}
	if route.ID == "" {
		route.ID = sanitizeID(route.Domain + route.Path)
	}
	if route.CreatedAt == "" {
		route.CreatedAt = time.Now().UTC().Format(time.RFC3339)
	}
	route.Enabled = true

	target, err := url.Parse(route.Target)
	if err != nil {
		return fmt.Errorf("invalid target URL: %w", err)
	}

	m.mu.Lock()
	defer m.mu.Unlock()

	// Create reverse proxy.
	proxy := httputil.NewSingleHostReverseProxy(target)
	proxy.Transport = &http.Transport{
		MaxIdleConns:        100,
		MaxIdleConnsPerHost: 20,
		IdleConnTimeout:     90 * time.Second,
		DialContext: (&net.Dialer{
			Timeout:   10 * time.Second,
			KeepAlive: 30 * time.Second,
		}).DialContext,
	}
	proxy.ErrorHandler = func(w http.ResponseWriter, r *http.Request, err error) {
		m.logger.Error("proxy error", "route", route.ID, "err", err)
		http.Error(w, fmt.Sprintf("Bad Gateway: %v", err), http.StatusBadGateway)
	}

	m.routes[route.ID] = route
	m.proxies[route.ID] = proxy

	// Persist.
	if err := m.saveRoutes(); err != nil {
		m.logger.Error("failed to save routes", "err", err)
	}

	m.logger.Info("proxy route added", "id", route.ID, "domain", route.Domain, "target", route.Target)

	// Restart HTTPS server if needed.
	go m.restartHTTPSServer()

	return nil
}

// Remove deletes a proxy route.
func (m *Manager) Remove(id string) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	if _, ok := m.routes[id]; !ok {
		return fmt.Errorf("route %s not found", id)
	}

	delete(m.routes, id)
	delete(m.proxies, id)

	if err := m.saveRoutes(); err != nil {
		m.logger.Error("failed to save routes", "err", err)
	}

	m.logger.Info("proxy route removed", "id", id)
	go m.restartHTTPSServer()
	return nil
}

// Enable enables a proxy route.
func (m *Manager) Enable(id string) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	route, ok := m.routes[id]
	if !ok {
		return fmt.Errorf("route %s not found", id)
	}
	route.Enabled = true
	if err := m.saveRoutes(); err != nil {
		return err
	}
	go m.restartHTTPSServer()
	return nil
}

// Disable disables a proxy route.
func (m *Manager) Disable(id string) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	route, ok := m.routes[id]
	if !ok {
		return fmt.Errorf("route %s not found", id)
	}
	route.Enabled = false
	if err := m.saveRoutes(); err != nil {
		return err
	}
	go m.restartHTTPSServer()
	return nil
}

// GetCertificate attempts to get or create a TLS certificate for a domain.
func (m *Manager) GetCertificate(domain string) (tls.Certificate, error) {
	certDir := filepath.Join(m.dataDir, "certs", domain)
	certFile := filepath.Join(certDir, "cert.pem")
	keyFile := filepath.Join(certDir, "key.pem")

	// Check if cert exists.
	if _, err := os.Stat(certFile); err == nil {
		if _, err := os.Stat(keyFile); err == nil {
			return tls.LoadX509KeyPair(certFile, keyFile)
		}
	}

	// Self-signed cert for development.
	return m.generateSelfSigned(domain)
}

// startHTTPSServer starts the HTTPS server for SSL routes.
func (m *Manager) startHTTPSServer() {
	// Check if any route needs HTTPS.
	hasHTTPS := false
	for _, r := range m.routes {
		if r.Enabled && (r.AutoSSL || r.Certificate != "") {
			hasHTTPS = true
			break
		}
	}
	if !hasHTTPS {
		return
	}

	m.mu.Lock()
	tlsConfig := &tls.Config{
		GetCertificate: func(hello *tls.ClientHelloInfo) (*tls.Certificate, error) {
			cert, err := m.GetCertificate(hello.ServerName)
			if err != nil {
				return nil, err
			}
			return &cert, nil
		},
		MinVersion: tls.VersionTLS12,
	}
	m.httpsSrv = &http.Server{
		Addr:         ":443",
		Handler:      m,
		TLSConfig:    tlsConfig,
		ReadTimeout:  30 * time.Second,
		WriteTimeout: 30 * time.Second,
	}
	m.mu.Unlock()

	m.logger.Info("https proxy started", "addr", ":443")
	if err := m.httpsSrv.ListenAndServeTLS("", ""); err != nil && err != http.ErrServerClosed {
		m.logger.Error("https proxy error", "err", err)
	}
}

// restartHTTPSServer stops and restarts the HTTPS server.
func (m *Manager) restartHTTPSServer() {
	m.mu.Lock()
	if m.httpsSrv != nil {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		m.httpsSrv.Shutdown(ctx)
		m.httpsSrv = nil
	}
	m.mu.Unlock()

	go m.startHTTPSServer()
}

// loadRoutes loads routes from disk.
func (m *Manager) loadRoutes() {
	routesFile := filepath.Join(m.dataDir, "proxy-routes.json")
	data, err := os.ReadFile(routesFile)
	if err != nil {
		if !os.IsNotExist(err) {
			m.logger.Error("failed to load proxy routes", "err", err)
		}
		return
	}

	var routes []*Route
	if err := json.Unmarshal(data, &routes); err != nil {
		m.logger.Error("failed to parse proxy routes", "err", err)
		return
	}

	for _, route := range routes {
		m.routes[route.ID] = route
		if route.Enabled && route.Target != "" {
			target, err := url.Parse(route.Target)
			if err != nil {
				m.logger.Error("invalid target", "route", route.ID, "err", err)
				continue
			}
			proxy := httputil.NewSingleHostReverseProxy(target)
			proxy.ErrorHandler = func(w http.ResponseWriter, r *http.Request, err error) {
				http.Error(w, "Bad Gateway", http.StatusBadGateway)
			}
			m.proxies[route.ID] = proxy
		}
	}

	m.logger.Info("loaded proxy routes", "count", len(m.routes))
}

// saveRoutes persists routes to disk.
func (m *Manager) saveRoutes() error {
	routes := make([]*Route, 0, len(m.routes))
	for _, r := range m.routes {
		routes = append(routes, r)
	}
	sort.Slice(routes, func(i, j int) bool {
		return routes[i].ID < routes[j].ID
	})

	data, err := json.MarshalIndent(routes, "", "  ")
	if err != nil {
		return err
	}

	routesFile := filepath.Join(m.dataDir, "proxy-routes.json")
	return os.WriteFile(routesFile, data, 0644)
}

// sanitizeID creates a safe ID from a string.
func sanitizeID(s string) string {
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
	return s
}

// generateSelfSigned creates a self-signed TLS certificate for development.
func (m *Manager) generateSelfSigned(domain string) (tls.Certificate, error) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return tls.Certificate{}, fmt.Errorf("generate key: %w", err)
	}

	serial, _ := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))

	template := &x509.Certificate{
		SerialNumber: serial,
		Subject: pkix.Name{
			Organization: []string{"KATHAL OS"},
			CommonName:   domain,
		},
		NotBefore:             time.Now(),
		NotAfter:              time.Now().Add(365 * 24 * time.Hour),
		KeyUsage:              x509.KeyUsageDigitalSignature | x509.KeyUsageKeyEncipherment,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		BasicConstraintsValid: true,
		DNSNames:              []string{domain},
	}

	if domain == "" || domain == "*" {
		template.IPAddresses = []net.IP{net.ParseIP("127.0.0.1")}
	}

	certDER, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if err != nil {
		return tls.Certificate{}, fmt.Errorf("create cert: %w", err)
	}

	certPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: certDER})
	keyDER, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		return tls.Certificate{}, fmt.Errorf("marshal key: %w", err)
	}
	keyPEM := pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyDER})

	// Save to disk for reuse.
	certDir := filepath.Join(m.dataDir, "certs", domain)
	os.MkdirAll(certDir, 0700)
	os.WriteFile(filepath.Join(certDir, "cert.pem"), certPEM, 0644)
	os.WriteFile(filepath.Join(certDir, "key.pem"), keyPEM, 0600)

	return tls.Certificate{Certificate: [][]byte{certDER}, PrivateKey: key}, nil
}
