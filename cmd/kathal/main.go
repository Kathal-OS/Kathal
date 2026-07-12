// Command kathal starts the KATHAL OS dashboard server.
package main

import (
	"embed"
	"io/fs"
	"log/slog"
	"net/http"
	"os"

	"github.com/bakeweb/kathal-os/internal/api"
	"github.com/bakeweb/kathal-os/internal/auth"
	"github.com/bakeweb/kathal-os/internal/config"
	"github.com/bakeweb/kathal-os/internal/docker"
	"github.com/bakeweb/kathal-os/internal/metrics"
	"github.com/bakeweb/kathal-os/internal/store"
)

//go:embed web/dist/*
var webDist embed.FS

func main() {
	cfg := config.Load()

	slog.SetDefault(slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{
		Level: cfg.LogLevel,
	})))

	db, err := store.New(cfg.DBPath)
	if err != nil {
		slog.Error("kathal: failed to open store", "err", err)
		os.Exit(1)
	}
	defer db.Close()

	// Persist a random JWT secret on first boot instead of trusting a
	// hardcoded fallback (see internal/config for the default).
	jwtSecret, err := ensureJWTSecret(db, cfg.JWTSecret)
	if err != nil {
		slog.Error("kathal: failed to establish JWT secret", "err", err)
		os.Exit(1)
	}

	if err := ensureAdminUser(db); err != nil {
		slog.Error("kathal: failed to bootstrap admin user", "err", err)
		os.Exit(1)
	}

	dockerClient := docker.NewClient()

	deps := api.Deps{
		Config:  cfg,
		Store:   db,
		Docker:  dockerClient,
		Metrics: metrics.New(dockerClient),
		JWT:     auth.New(jwtSecret),
	}

	router := api.NewRouter(deps)
	// Serve the embedded React dashboard for any non-API routes.
	mux := http.NewServeMux()
	mux.Handle("/api/", router)
	mux.Handle("/", http.FileServer(http.FS(subdirFS(webDist, "web/dist"))))

	slog.Info("kathal: starting server",
		"addr", cfg.HTTPAddr,
		"version", cfg.Version,
		"dockerAvailable", dockerClient.IsAvailable(),
	)

	if err := http.ListenAndServe(cfg.HTTPAddr, mux); err != nil {
		slog.Error("kathal: server exited", "err", err)
		os.Exit(1)
	}
}

// ensureAdminUser creates a default admin account on first boot if no users
// exist yet. The password is either taken from KATHAL_ADMIN_PASSWORD (for
// scripted installs) or randomly generated and printed once — there is no
// hardcoded default credential.
func ensureAdminUser(db *store.DB) error {
	count, err := db.CountUsers()
	if err != nil {
		return err
	}
	if count > 0 {
		return nil
	}

	email := os.Getenv("KATHAL_ADMIN_EMAIL")
	if email == "" {
		email = "admin@kathal.local"
	}

	password := os.Getenv("KATHAL_ADMIN_PASSWORD")
	generated := password == ""
	if generated {
		password = auth.GenerateSecret()[:20]
	}

	hash, err := auth.HashPassword(password)
	if err != nil {
		return err
	}

	if err := db.CreateUser(&store.User{
		ID:           "admin",
		Email:        email,
		PasswordHash: hash,
		Role:         "admin",
	}); err != nil {
		return err
	}

	if generated {
		slog.Warn("kathal: created default admin account with a generated password — save this now, it will not be shown again",
			"email", email, "password", password)
	} else {
		slog.Info("kathal: created default admin account", "email", email)
	}

	return nil
}

// ensureJWTSecret returns the configured JWT secret unless it's still the
// insecure default, in which case it generates (or reuses) a random secret
// persisted in the settings table so tokens survive restarts but never rely
// on the well-known fallback string.
func ensureJWTSecret(db *store.DB, configured string) (string, error) {
	const insecureDefault = "kathal-dev-secret-change-me"
	if configured != insecureDefault {
		return configured, nil
	}

	if existing, err := db.GetSetting("jwt_secret"); err == nil && existing != "" {
		return existing, nil
	}

	secret := auth.GenerateSecret()
	if err := db.SetSetting("jwt_secret", secret); err != nil {
		return "", err
	}

	slog.Warn("kathal: KATHAL_JWT_SECRET not set — generated and persisted a random secret")
	return secret, nil
}

// subdirFS strips a leading directory prefix from an embed.FS so the
// embedded files can be served at the root path.
func subdirFS(fsys embed.FS, dir string) fs.FS {
	sub, err := fs.Sub(fsys, dir)
	if err != nil {
		panic("kathal: embedded web/dist missing: " + err.Error())
	}
	return sub
}
