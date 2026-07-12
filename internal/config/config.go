// Package config provides configuration for the KATHAL OS dashboard.
package config

import (
	"log/slog"
	"os"
	"strconv"
)

// Config holds all configuration for the dashboard.
type Config struct {
	Version  string
	HTTPAddr string
	DBPath   string
	DataDir  string
	LogLevel slog.Level

	// Docker socket path.
	DockerSocket string

	// App store URL (for curated app templates).
	AppStoreURL string

	// JWT secret for API auth.
	JWTSecret string
}

// Load reads config from environment with sensible defaults.
func Load() *Config {
	cfg := &Config{
		Version:      getEnv("KATHAL_VERSION", "0.1.0"),
		HTTPAddr:     getEnv("KATHAL_HTTP_ADDR", ":8080"),
		DBPath:       getEnv("KATHAL_DB_PATH", "/data/kathal.db"),
		DataDir:      getEnv("KATHAL_DATA_DIR", "/data"),
		DockerSocket: getEnv("DOCKER_HOST", "unix:///var/run/docker.sock"),
		AppStoreURL:  getEnv("KATHAL_APP_STORE_URL", "https://raw.githubusercontent.com/bakeweb/kathal-os/main/deploy/apps.json"),
		JWTSecret:    getEnv("KATHAL_JWT_SECRET", "kathal-dev-secret-change-me"),
	}

	// Parse log level.
	switch getEnv("KATHAL_LOG_LEVEL", "info") {
	case "debug":
		cfg.LogLevel = slog.LevelDebug
	case "warn":
		cfg.LogLevel = slog.LevelWarn
	case "error":
		cfg.LogLevel = slog.LevelError
	default:
		cfg.LogLevel = slog.LevelInfo
	}

	return cfg
}

func getEnv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func getEnvInt(key string, fallback int) int {
	if v := os.Getenv(key); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return fallback
}
