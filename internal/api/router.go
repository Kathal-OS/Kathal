// Package api provides the REST API for the KATHAL OS dashboard.
package api

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/bakeweb/kathal-os/internal/auth"
	"github.com/bakeweb/kathal-os/internal/backup"
	"github.com/bakeweb/kathal-os/internal/compose"
	"github.com/bakeweb/kathal-os/internal/config"
	"github.com/bakeweb/kathal-os/internal/dbmanager"
	"github.com/bakeweb/kathal-os/internal/docker"
	"github.com/bakeweb/kathal-os/internal/env"
	"github.com/bakeweb/kathal-os/internal/filemanager"
	"github.com/bakeweb/kathal-os/internal/gitdeploy"
	"github.com/bakeweb/kathal-os/internal/logs"
	"github.com/bakeweb/kathal-os/internal/metrics"
	"github.com/bakeweb/kathal-os/internal/monitoring"
	"github.com/bakeweb/kathal-os/internal/network"
	"github.com/bakeweb/kathal-os/internal/proxy"
	"github.com/bakeweb/kathal-os/internal/store"
	"github.com/bakeweb/kathal-os/internal/templates"
	"github.com/bakeweb/kathal-os/internal/terminal"
	"github.com/gorilla/mux"
)

// Deps holds all dependencies for the API.
type Deps struct {
	Config     *config.Config
	Store      *store.DB
	Docker     *docker.Client
	Metrics    *metrics.Collector
	JWT        *auth.JWT
	Proxy      *proxy.Manager
	DBManager  *dbmanager.Manager
	Files      *filemanager.Manager
	Backup     *backup.Manager
	Templates  *templates.Manager
	GitDeploy  *gitdeploy.Manager
	Terminal   *terminal.Manager
	Monitoring *monitoring.Manager
	Logs       *logs.Manager
	Compose    *compose.Manager
	Env        *env.Manager
	Network    *network.Manager
}

// NewRouter creates the main HTTP router.
func NewRouter(deps Deps) http.Handler {
	r := mux.NewRouter()

	// API v1.
	api := r.PathPrefix("/api/v1").Subrouter()
	// JWT auth middleware — protects all /api/v1 routes except login/health.
	api.Use(deps.JWT.Middleware)

	// === SYSTEM ===
	api.HandleFunc("/status", handleSystemStatus(deps)).Methods("GET")
	api.HandleFunc("/metrics", handleMetrics(deps)).Methods("GET")
	api.HandleFunc("/system", handleSystemInfo(deps)).Methods("GET")

	// === DOCKER CONTAINERS ===
	api.HandleFunc("/containers", handleListContainers(deps)).Methods("GET")
	api.HandleFunc("/containers/{id}/start", handleStartContainer(deps)).Methods("POST")
	api.HandleFunc("/containers/{id}/stop", handleStopContainer(deps)).Methods("POST")
	api.HandleFunc("/containers/{id}/restart", handleRestartContainer(deps)).Methods("POST")
	api.HandleFunc("/containers/{id}/delete", handleDeleteContainer(deps)).Methods("DELETE")
	api.HandleFunc("/containers/{id}/logs", handleContainerLogs(deps)).Methods("GET")

	// === DOCKER IMAGES ===
	api.HandleFunc("/images", handleListImages(deps)).Methods("GET")

	// === APPS (managed deployments) ===
	api.HandleFunc("/apps", handleListApps(deps)).Methods("GET")
	api.HandleFunc("/apps", handleCreateApp(deps)).Methods("POST")
	api.HandleFunc("/apps/{id}", handleGetApp(deps)).Methods("GET")
	api.HandleFunc("/apps/{id}", handleUpdateApp(deps)).Methods("PUT")
	api.HandleFunc("/apps/{id}", handleDeleteApp(deps)).Methods("DELETE")

	// === REVERSE PROXY ===
	api.HandleFunc("/proxy", handleListProxyRoutes(deps)).Methods("GET")
	api.HandleFunc("/proxy", handleCreateProxyRoute(deps)).Methods("POST")
	api.HandleFunc("/proxy/{id}", handleGetProxyRoute(deps)).Methods("GET")
	api.HandleFunc("/proxy/{id}", handleUpdateProxyRoute(deps)).Methods("PUT")
	api.HandleFunc("/proxy/{id}", handleDeleteProxyRoute(deps)).Methods("DELETE")
	api.HandleFunc("/proxy/{id}/enable", handleEnableProxyRoute(deps)).Methods("POST")
	api.HandleFunc("/proxy/{id}/disable", handleDisableProxyRoute(deps)).Methods("POST")

	// === DATABASE MANAGEMENT ===
	api.HandleFunc("/databases", handleListDatabases(deps)).Methods("GET")
	api.HandleFunc("/databases", handleCreateDatabase(deps)).Methods("POST")
	api.HandleFunc("/databases/{id}", handleGetDatabase(deps)).Methods("GET")
	api.HandleFunc("/databases/{id}", handleDeleteDatabase(deps)).Methods("DELETE")
	api.HandleFunc("/databases/{id}/start", handleStartDatabase(deps)).Methods("POST")
	api.HandleFunc("/databases/{id}/stop", handleStopDatabase(deps)).Methods("POST")
	api.HandleFunc("/databases/{id}/connection", handleDatabaseConnection(deps)).Methods("GET")

	// === FILE MANAGER ===
	api.HandleFunc("/files", handleListFiles(deps)).Methods("GET")
	api.HandleFunc("/files/read", handleReadFile(deps)).Methods("GET")
	api.HandleFunc("/files/write", handleWriteFile(deps)).Methods("POST")
	api.HandleFunc("/files/mkdir", handleMkdir(deps)).Methods("POST")
	api.HandleFunc("/files/delete", handleDeleteFile(deps)).Methods("DELETE")
	api.HandleFunc("/files/rename", handleRenameFile(deps)).Methods("POST")
	api.HandleFunc("/files/upload", handleUploadFile(deps)).Methods("POST")

	// === BACKUP/RESTORE ===
	api.HandleFunc("/backups", handleListBackups(deps)).Methods("GET")
	api.HandleFunc("/backups", handleCreateBackup(deps)).Methods("POST")
	api.HandleFunc("/backups/{id}", handleDeleteBackup(deps)).Methods("DELETE")
	api.HandleFunc("/backups/{id}/restore", handleRestoreBackup(deps)).Methods("POST")
	api.HandleFunc("/backups/export", handleExportAll(deps)).Methods("GET")
	api.HandleFunc("/backups/import", handleImportAll(deps)).Methods("POST")

	// === HEALTH ===
	api.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, map[string]string{"status": "ok"})
	}).Methods("GET")

	// === SERVICE TEMPLATES ===
	api.HandleFunc("/templates", handleListTemplates(deps)).Methods("GET")
	api.HandleFunc("/templates/search", handleSearchTemplates(deps)).Methods("GET")
	api.HandleFunc("/templates/categories", handleTemplateCategories(deps)).Methods("GET")
	api.HandleFunc("/templates/{id}", handleGetTemplate(deps)).Methods("GET")

	// === GIT DEPLOYMENT ===
	api.HandleFunc("/git/repos", handleListGitRepos(deps)).Methods("GET")
	api.HandleFunc("/git/repos", handleAddGitRepo(deps)).Methods("POST")
	api.HandleFunc("/git/repos/{id}/deploy", handleDeployGitRepo(deps)).Methods("POST")
	api.HandleFunc("/git/repos/{id}/history", handleGitDeployHistory(deps)).Methods("GET")
	api.HandleFunc("/git/webhook", handleGitWebhook(deps)).Methods("POST")

	// === WEB TERMINAL ===
	api.HandleFunc("/terminal/sessions", handleCreateTerminalSession(deps)).Methods("POST")
	api.HandleFunc("/terminal/sessions/{id}", handleDeleteTerminalSession(deps)).Methods("DELETE")
	api.HandleFunc("/terminal/ws/{id}", handleTerminalWebSocket(deps)).Methods("GET")

	// === MONITORING ===
	api.HandleFunc("/monitoring/current", handleMonitoringCurrent(deps)).Methods("GET")
	api.HandleFunc("/monitoring/history", handleMonitoringHistory(deps)).Methods("GET")

	// === LOGS ===
	api.HandleFunc("/logs/containers", handleListLogContainers(deps)).Methods("GET")
	api.HandleFunc("/logs", handleGetLogs(deps)).Methods("GET")
	api.HandleFunc("/logs/search", handleSearchLogs(deps)).Methods("POST")

	// === COMPOSE ===
	api.HandleFunc("/compose", handleListComposeProjects(deps)).Methods("GET")
	api.HandleFunc("/compose", handleCreateComposeProject(deps)).Methods("POST")
	api.HandleFunc("/compose/{name}", handleGetComposeProject(deps)).Methods("GET")
	api.HandleFunc("/compose/{name}", handleUpdateComposeProject(deps)).Methods("PUT")
	api.HandleFunc("/compose/{name}", handleDeleteComposeProject(deps)).Methods("DELETE")
	api.HandleFunc("/compose/{name}/deploy", handleDeployComposeProject(deps)).Methods("POST")
	api.HandleFunc("/compose/{name}/stop", handleStopComposeProject(deps)).Methods("POST")
	api.HandleFunc("/compose/validate", handleValidateComposeConfig(deps)).Methods("POST")

	// === ENVIRONMENT ===
	api.HandleFunc("/env", handleListEnv(deps)).Methods("GET")
	api.HandleFunc("/env", handleCreateEnv(deps)).Methods("POST")
	api.HandleFunc("/env/{key}", handleDeleteEnv(deps)).Methods("DELETE")

	// === NETWORK & VOLUMES ===
	api.HandleFunc("/network", handleListNetworks(deps)).Methods("GET")
	api.HandleFunc("/network", handleCreateNetwork(deps)).Methods("POST")
	api.HandleFunc("/network/{name}", handleDeleteNetwork(deps)).Methods("DELETE")
	api.HandleFunc("/network/prune", handlePruneNetworks(deps)).Methods("POST")
	api.HandleFunc("/volumes", handleListVolumes(deps)).Methods("GET")
	api.HandleFunc("/volumes", handleCreateVolume(deps)).Methods("POST")
	api.HandleFunc("/volumes/{name}", handleDeleteVolume(deps)).Methods("DELETE")
	api.HandleFunc("/volumes/prune", handlePruneVolumes(deps)).Methods("POST")

	// Login (public — no JWT required).
	api.HandleFunc("/login", handleLogin(deps)).Methods("POST")

	return r
}

// ==================== SYSTEM HANDLERS ====================

func handleMetrics(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		m, err := deps.Metrics.Collect()
		if err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		writeJSON(w, m)
	}
}

func handleSystemInfo(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		info := map[string]interface{}{
			"version":   deps.Config.Version,
			"docker":    deps.Docker != nil && deps.Docker.IsAvailable(),
			"goVersion": runtime.Version(),
		}
		writeJSON(w, info)
	}
}

func handleSystemStatus(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		status := map[string]interface{}{
			"version":         deps.Config.Version,
			"platform":        runtime.GOOS,
			"arch":            runtime.GOARCH,
			"goVersion":       runtime.Version(),
			"dockerAvailable": deps.Docker != nil && deps.Docker.IsAvailable(),
		}
		if deps.Docker != nil && deps.Docker.IsAvailable() {
			info, err := deps.Docker.GetSystemInfo(r.Context())
			if err == nil {
				status["dockerVersion"] = info.ServerVersion
				status["dockerContainers"] = info.Containers
				status["dockerImages"] = info.Images
			}
		}
		writeJSON(w, status)
	}
}

// ==================== DOCKER CONTAINER HANDLERS ====================

func handleListContainers(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if deps.Docker == nil || !deps.Docker.IsAvailable() {
			writeJSON(w, map[string]interface{}{
				"containers": []interface{}{},
				"message":    "Docker not available",
			})
			return
		}
		all := r.URL.Query().Get("all") == "true"
		containers, err := deps.Docker.ListContainers(r.Context(), all)
		if err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		writeJSON(w, containers)
	}
}

func handleStartContainer(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if deps.Docker == nil || !deps.Docker.IsAvailable() {
			writeError(w, http.StatusServiceUnavailable, "Docker not available")
			return
		}
		id := mux.Vars(r)["id"]
		if err := deps.Docker.StartContainer(r.Context(), id); err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		writeJSON(w, map[string]string{"status": "started"})
	}
}

func handleStopContainer(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if deps.Docker == nil || !deps.Docker.IsAvailable() {
			writeError(w, http.StatusServiceUnavailable, "Docker not available")
			return
		}
		id := mux.Vars(r)["id"]
		if err := deps.Docker.StopContainer(r.Context(), id); err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		writeJSON(w, map[string]string{"status": "stopped"})
	}
}

func handleRestartContainer(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if deps.Docker == nil || !deps.Docker.IsAvailable() {
			writeError(w, http.StatusServiceUnavailable, "Docker not available")
			return
		}
		id := mux.Vars(r)["id"]
		if err := deps.Docker.RestartContainer(r.Context(), id); err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		writeJSON(w, map[string]string{"status": "restarted"})
	}
}

func handleDeleteContainer(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if deps.Docker == nil || !deps.Docker.IsAvailable() {
			writeError(w, http.StatusServiceUnavailable, "Docker not available")
			return
		}
		id := mux.Vars(r)["id"]
		if err := deps.Docker.RemoveContainer(r.Context(), id, true); err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		writeJSON(w, map[string]string{"status": "deleted"})
	}
}

func handleContainerLogs(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if deps.Docker == nil || !deps.Docker.IsAvailable() {
			writeJSON(w, map[string]string{"logs": "Docker not available"})
			return
		}
		id := mux.Vars(r)["id"]
		logs, err := deps.Docker.GetContainerLogs(r.Context(), id, 100)
		if err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		writeJSON(w, map[string]string{"logs": logs})
	}
}

func handleListImages(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if deps.Docker == nil || !deps.Docker.IsAvailable() {
			writeJSON(w, map[string]interface{}{
				"images":  []interface{}{},
				"message": "Docker not available",
			})
			return
		}
		images, err := deps.Docker.ListImages(r.Context())
		if err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		writeJSON(w, images)
	}
}

// ==================== APP HANDLERS ====================

func handleListApps(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		apps, err := deps.Store.ListApps()
		if err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		writeJSON(w, apps)
	}
}

func handleCreateApp(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var app store.App
		if err := json.NewDecoder(r.Body).Decode(&app); err != nil {
			writeError(w, http.StatusBadRequest, "invalid JSON")
			return
		}
		if err := deps.Store.CreateApp(&app); err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		writeJSON(w, app)
	}
}

func handleGetApp(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := mux.Vars(r)["id"]
		app, err := deps.Store.GetApp(id)
		if err != nil {
			writeError(w, http.StatusNotFound, "app not found")
			return
		}
		writeJSON(w, app)
	}
}

func handleUpdateApp(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := mux.Vars(r)["id"]
		var app store.App
		if err := json.NewDecoder(r.Body).Decode(&app); err != nil {
			writeError(w, http.StatusBadRequest, "invalid JSON")
			return
		}
		app.ID = id
		if err := deps.Store.UpdateApp(&app); err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		writeJSON(w, app)
	}
}

func handleDeleteApp(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := mux.Vars(r)["id"]
		if err := deps.Store.DeleteApp(id); err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		writeJSON(w, map[string]string{"status": "deleted"})
	}
}

// ==================== REVERSE PROXY HANDLERS ====================

func handleListProxyRoutes(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if deps.Proxy == nil {
			writeJSON(w, []interface{}{})
			return
		}
		writeJSON(w, deps.Proxy.List())
	}
}

func handleCreateProxyRoute(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if deps.Proxy == nil {
			writeError(w, http.StatusServiceUnavailable, "proxy not available")
			return
		}
		var route proxy.Route
		if err := json.NewDecoder(r.Body).Decode(&route); err != nil {
			writeError(w, http.StatusBadRequest, "invalid JSON")
			return
		}
		if err := deps.Proxy.Add(&route); err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		writeJSON(w, route)
	}
}

func handleGetProxyRoute(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if deps.Proxy == nil {
			writeError(w, http.StatusServiceUnavailable, "proxy not available")
			return
		}
		id := mux.Vars(r)["id"]
		route, ok := deps.Proxy.Get(id)
		if !ok {
			writeError(w, http.StatusNotFound, "route not found")
			return
		}
		writeJSON(w, route)
	}
}

func handleUpdateProxyRoute(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if deps.Proxy == nil {
			writeError(w, http.StatusServiceUnavailable, "proxy not available")
			return
		}
		id := mux.Vars(r)["id"]
		var route proxy.Route
		if err := json.NewDecoder(r.Body).Decode(&route); err != nil {
			writeError(w, http.StatusBadRequest, "invalid JSON")
			return
		}
		route.ID = id
		if err := deps.Proxy.Add(&route); err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		writeJSON(w, route)
	}
}

func handleDeleteProxyRoute(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if deps.Proxy == nil {
			writeError(w, http.StatusServiceUnavailable, "proxy not available")
			return
		}
		id := mux.Vars(r)["id"]
		if err := deps.Proxy.Remove(id); err != nil {
			writeError(w, http.StatusNotFound, err.Error())
			return
		}
		writeJSON(w, map[string]string{"status": "deleted"})
	}
}

func handleEnableProxyRoute(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if deps.Proxy == nil {
			writeError(w, http.StatusServiceUnavailable, "proxy not available")
			return
		}
		id := mux.Vars(r)["id"]
		if err := deps.Proxy.Enable(id); err != nil {
			writeError(w, http.StatusNotFound, err.Error())
			return
		}
		writeJSON(w, map[string]string{"status": "enabled"})
	}
}

func handleDisableProxyRoute(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if deps.Proxy == nil {
			writeError(w, http.StatusServiceUnavailable, "proxy not available")
			return
		}
		id := mux.Vars(r)["id"]
		if err := deps.Proxy.Disable(id); err != nil {
			writeError(w, http.StatusNotFound, err.Error())
			return
		}
		writeJSON(w, map[string]string{"status": "disabled"})
	}
}

// ==================== DATABASE HANDLERS ====================

func handleListDatabases(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if deps.DBManager == nil {
			writeJSON(w, []interface{}{})
			return
		}
		writeJSON(w, deps.DBManager.List())
	}
}

func handleCreateDatabase(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if deps.DBManager == nil {
			writeError(w, http.StatusServiceUnavailable, "database manager not available")
			return
		}
		var req struct {
			Name     string `json:"name"`
			Type     string `json:"type"`
			Password string `json:"password"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeError(w, http.StatusBadRequest, "invalid JSON")
			return
		}
		db, err := deps.DBManager.Create(req.Name, req.Type, req.Password)
		if err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		writeJSON(w, db)
	}
}

func handleGetDatabase(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if deps.DBManager == nil {
			writeError(w, http.StatusServiceUnavailable, "database manager not available")
			return
		}
		id := mux.Vars(r)["id"]
		db, ok := deps.DBManager.Get(id)
		if !ok {
			writeError(w, http.StatusNotFound, "database not found")
			return
		}
		writeJSON(w, db)
	}
}

func handleDeleteDatabase(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if deps.DBManager == nil {
			writeError(w, http.StatusServiceUnavailable, "database manager not available")
			return
		}
		id := mux.Vars(r)["id"]
		if err := deps.DBManager.Delete(id); err != nil {
			writeError(w, http.StatusNotFound, err.Error())
			return
		}
		writeJSON(w, map[string]string{"status": "deleted"})
	}
}

func handleStartDatabase(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if deps.DBManager == nil {
			writeError(w, http.StatusServiceUnavailable, "database manager not available")
			return
		}
		id := mux.Vars(r)["id"]
		if err := deps.DBManager.Start(id); err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		writeJSON(w, map[string]string{"status": "started"})
	}
}

func handleStopDatabase(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if deps.DBManager == nil {
			writeError(w, http.StatusServiceUnavailable, "database manager not available")
			return
		}
		id := mux.Vars(r)["id"]
		if err := deps.DBManager.Stop(id); err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		writeJSON(w, map[string]string{"status": "stopped"})
	}
}

func handleDatabaseConnection(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if deps.DBManager == nil {
			writeError(w, http.StatusServiceUnavailable, "database manager not available")
			return
		}
		id := mux.Vars(r)["id"]
		db, ok := deps.DBManager.Get(id)
		if !ok {
			writeError(w, http.StatusNotFound, "database not found")
			return
		}
		writeJSON(w, map[string]string{
			"connection_string": deps.DBManager.GetConnectionString(db),
		})
	}
}

// ==================== FILE MANAGER HANDLERS ====================

func handleListFiles(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if deps.Files == nil {
			writeError(w, http.StatusServiceUnavailable, "file manager not available")
			return
		}
		path := r.URL.Query().Get("path")
		if path == "" {
			path = "/"
		}
		listing, err := deps.Files.List(path)
		if err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		writeJSON(w, listing)
	}
}

func handleReadFile(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if deps.Files == nil {
			writeError(w, http.StatusServiceUnavailable, "file manager not available")
			return
		}
		path := r.URL.Query().Get("path")
		if path == "" {
			writeError(w, http.StatusBadRequest, "path required")
			return
		}
		data, err := deps.Files.Read(path)
		if err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		w.Header().Set("Content-Type", "application/octet-stream")
		w.Write(data)
	}
}

func handleWriteFile(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if deps.Files == nil {
			writeError(w, http.StatusServiceUnavailable, "file manager not available")
			return
		}
		var req struct {
			Path    string `json:"path"`
			Content string `json:"content"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeError(w, http.StatusBadRequest, "invalid JSON")
			return
		}
		if err := deps.Files.Write(req.Path, []byte(req.Content)); err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		writeJSON(w, map[string]string{"status": "ok"})
	}
}

func handleMkdir(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if deps.Files == nil {
			writeError(w, http.StatusServiceUnavailable, "file manager not available")
			return
		}
		var req struct {
			Path string `json:"path"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeError(w, http.StatusBadRequest, "invalid JSON")
			return
		}
		if err := deps.Files.Mkdir(req.Path); err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		writeJSON(w, map[string]string{"status": "ok"})
	}
}

func handleDeleteFile(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if deps.Files == nil {
			writeError(w, http.StatusServiceUnavailable, "file manager not available")
			return
		}
		path := r.URL.Query().Get("path")
		if path == "" {
			writeError(w, http.StatusBadRequest, "path required")
			return
		}
		if err := deps.Files.Delete(path); err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		writeJSON(w, map[string]string{"status": "deleted"})
	}
}

func handleRenameFile(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if deps.Files == nil {
			writeError(w, http.StatusServiceUnavailable, "file manager not available")
			return
		}
		var req struct {
			OldPath string `json:"old_path"`
			NewPath string `json:"new_path"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeError(w, http.StatusBadRequest, "invalid JSON")
			return
		}
		if err := deps.Files.Rename(req.OldPath, req.NewPath); err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		writeJSON(w, map[string]string{"status": "ok"})
	}
}

func handleUploadFile(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if deps.Files == nil {
			writeError(w, http.StatusServiceUnavailable, "file manager not available")
			return
		}
		// Parse multipart form (max 100MB).
		if err := r.ParseMultipartForm(100 << 20); err != nil {
			writeError(w, http.StatusBadRequest, "invalid form data")
			return
		}
		file, header, err := r.FormFile("file")
		if err != nil {
			writeError(w, http.StatusBadRequest, "no file provided")
			return
		}
		defer file.Close()

		relPath := r.FormValue("path")
		if relPath == "" {
			relPath = header.Filename
		}

		data, err := io.ReadAll(file)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "failed to read upload")
			return
		}

		if err := deps.Files.Write(relPath, data); err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		writeJSON(w, map[string]string{"status": "ok", "filename": header.Filename})
	}
}

// ==================== BACKUP HANDLERS ====================

func handleListBackups(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if deps.Backup == nil {
			writeJSON(w, []interface{}{})
			return
		}
		writeJSON(w, deps.Backup.ListBackups())
	}
}

func handleCreateBackup(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if deps.Backup == nil {
			writeError(w, http.StatusServiceUnavailable, "backup manager not available")
			return
		}
		var req struct {
			Name string `json:"name"`
		}
		json.NewDecoder(r.Body).Decode(&req)
		b, err := deps.Backup.CreateBackup(req.Name)
		if err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		writeJSON(w, b)
	}
}

func handleDeleteBackup(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if deps.Backup == nil {
			writeError(w, http.StatusServiceUnavailable, "backup manager not available")
			return
		}
		id := mux.Vars(r)["id"]
		if err := deps.Backup.DeleteBackup(id); err != nil {
			writeError(w, http.StatusNotFound, err.Error())
			return
		}
		writeJSON(w, map[string]string{"status": "deleted"})
	}
}

func handleRestoreBackup(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if deps.Backup == nil {
			writeError(w, http.StatusServiceUnavailable, "backup manager not available")
			return
		}
		id := mux.Vars(r)["id"]
		if err := deps.Backup.Restore(id); err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		writeJSON(w, map[string]string{"status": "restored", "message": "restart kathal to apply"})
	}
}

func handleExportAll(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if deps.Backup == nil {
			writeError(w, http.StatusServiceUnavailable, "backup manager not available")
			return
		}
		data, err := deps.Backup.ExportAll()
		if err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		w.Header().Set("Content-Type", "application/zip")
		w.Header().Set("Content-Disposition", "attachment; filename=\"kathal-export.zip\"")
		w.Write(data)
	}
}

func handleImportAll(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if deps.Backup == nil {
			writeError(w, http.StatusServiceUnavailable, "backup manager not available")
			return
		}
		file, _, err := r.FormFile("file")
		if err != nil {
			writeError(w, http.StatusBadRequest, "no file provided")
			return
		}
		defer file.Close()
		data, err := io.ReadAll(file)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "failed to read upload")
			return
		}
		if err := deps.Backup.ImportAll(data); err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		writeJSON(w, map[string]string{"status": "imported", "message": "restart kathal to apply"})
	}
}

// ==================== LOGIN HANDLER ====================

func handleLogin(deps Deps) http.HandlerFunc {
	limiter := newLoginLimiter()
	return func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Email    string `json:"email"`
			Password string `json:"password"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeError(w, http.StatusBadRequest, "invalid JSON")
			return
		}

		email := strings.ToLower(strings.TrimSpace(req.Email))
		if email == "" || req.Password == "" {
			writeError(w, http.StatusBadRequest, "email and password are required")
			return
		}

		if !limiter.allow(email) {
			writeError(w, http.StatusTooManyRequests, "too many failed attempts, try again later")
			return
		}

		user, err := deps.Store.GetUserByEmail(email)
		if err != nil {
			auth.VerifyPassword(req.Password, dummyHash)
			limiter.recordFailure(email)
			writeError(w, http.StatusUnauthorized, "invalid credentials")
			return
		}

		if !auth.VerifyPassword(req.Password, user.PasswordHash) {
			limiter.recordFailure(email)
			writeError(w, http.StatusUnauthorized, "invalid credentials")
			return
		}

		limiter.recordSuccess(email)

		token, err := deps.JWT.GenerateToken(user.ID, user.Email, user.Role, 72*time.Hour)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "failed to generate token")
			return
		}

		writeJSON(w, map[string]interface{}{
			"token": token,
			"user": map[string]string{
				"id":    user.ID,
				"email": user.Email,
				"role":  user.Role,
			},
		})
	}
}

const dummyHash = "pbkdf2-sha256$210000$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"

// ==================== RATE LIMITER ====================

type loginLimiter struct {
	mu       sync.Mutex
	attempts map[string]*loginAttempts
}

type loginAttempts struct {
	failures int
	lastFail time.Time
}

const (
	maxLoginFailures = 5
	loginLockout     = 5 * time.Minute
)

func newLoginLimiter() *loginLimiter {
	return &loginLimiter{attempts: make(map[string]*loginAttempts)}
}

func (l *loginLimiter) allow(email string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	a, ok := l.attempts[email]
	if !ok {
		return true
	}
	if a.failures >= maxLoginFailures && time.Since(a.lastFail) < loginLockout {
		return false
	}
	if time.Since(a.lastFail) >= loginLockout {
		delete(l.attempts, email)
	}
	return true
}

func (l *loginLimiter) recordFailure(email string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	a, ok := l.attempts[email]
	if !ok {
		a = &loginAttempts{}
		l.attempts[email] = a
	}
	a.failures++
	a.lastFail = time.Now()
}

func (l *loginLimiter) recordSuccess(email string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	delete(l.attempts, email)
}

// ==================== TEMPLATE HANDLERS ====================

func handleListTemplates(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if deps.Templates == nil {
			writeJSON(w, []interface{}{})
			return
		}
		cat := templates.Category(r.URL.Query().Get("category"))
		writeJSON(w, deps.Templates.List(cat))
	}
}

func handleSearchTemplates(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if deps.Templates == nil {
			writeJSON(w, []interface{}{})
			return
		}
		q := r.URL.Query().Get("q")
		writeJSON(w, deps.Templates.Search(q))
	}
}

func handleTemplateCategories(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if deps.Templates == nil {
			writeJSON(w, map[string]int{})
			return
		}
		writeJSON(w, deps.Templates.Categories())
	}
}

func handleGetTemplate(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if deps.Templates == nil {
			writeError(w, http.StatusServiceUnavailable, "templates not available")
			return
		}
		id := mux.Vars(r)["id"]
		t, ok := deps.Templates.Get(id)
		if !ok {
			writeError(w, http.StatusNotFound, "template not found")
			return
		}
		writeJSON(w, t)
	}
}

// ==================== GIT DEPLOY HANDLERS ====================

func handleListGitRepos(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if deps.GitDeploy == nil {
			writeJSON(w, []interface{}{})
			return
		}
		writeJSON(w, deps.GitDeploy.ListRepos())
	}
}

func handleAddGitRepo(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if deps.GitDeploy == nil {
			writeError(w, http.StatusServiceUnavailable, "git deploy not available")
			return
		}
		var req struct {
			Name      string `json:"name"`
			URL       string `json:"url"`
			Branch    string `json:"branch"`
			DeployCmd string `json:"deploy_cmd"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeError(w, http.StatusBadRequest, "invalid JSON")
			return
		}
		repo, err := deps.GitDeploy.AddRepo(req.Name, req.URL, req.Branch, req.DeployCmd)
		if err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		writeJSON(w, repo)
	}
}

func handleDeployGitRepo(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if deps.GitDeploy == nil {
			writeError(w, http.StatusServiceUnavailable, "git deploy not available")
			return
		}
		id := mux.Vars(r)["id"]
		result, err := deps.GitDeploy.Deploy(id)
		if err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		writeJSON(w, result)
	}
}

func handleGitDeployHistory(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if deps.GitDeploy == nil {
			writeJSON(w, []interface{}{})
			return
		}
		id := mux.Vars(r)["id"]
		writeJSON(w, deps.GitDeploy.GetDeployHistory(id))
	}
}

func handleGitWebhook(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if deps.GitDeploy == nil {
			writeError(w, http.StatusServiceUnavailable, "git deploy not available")
			return
		}
		body, err := io.ReadAll(r.Body)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "failed to read body")
			return
		}
		repoID, err := deps.GitDeploy.HandleWebhook(body)
		if err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		writeJSON(w, map[string]string{"repo_id": repoID, "status": "triggered"})
	}
}

// ==================== WEB TERMINAL HANDLERS ====================

func handleCreateTerminalSession(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if deps.Terminal == nil {
			writeError(w, http.StatusServiceUnavailable, "terminal not available")
			return
		}
		var req struct {
			ID   string `json:"id"`
			Cols uint16 `json:"cols"`
			Rows uint16 `json:"rows"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeError(w, http.StatusBadRequest, "invalid JSON")
			return
		}
		if req.ID == "" {
			req.ID = fmt.Sprintf("term-%d", time.Now().UnixMilli())
		}
		if req.Cols == 0 {
			req.Cols = 80
		}
		if req.Rows == 0 {
			req.Rows = 24
		}
		sess, err := deps.Terminal.CreateSession(req.ID, req.Cols, req.Rows)
		if err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		writeJSON(w, sess)
	}
}

func handleDeleteTerminalSession(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if deps.Terminal == nil {
			writeError(w, http.StatusServiceUnavailable, "terminal not available")
			return
		}
		id := mux.Vars(r)["id"]
		if err := deps.Terminal.CloseSession(id); err != nil {
			writeError(w, http.StatusNotFound, err.Error())
			return
		}
		writeJSON(w, map[string]string{"status": "closed"})
	}
}

func handleTerminalWebSocket(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if deps.Terminal == nil {
			writeError(w, http.StatusServiceUnavailable, "terminal not available")
			return
		}
		id := mux.Vars(r)["id"]
		deps.Terminal.HandleWebSocket(w, r, id)
	}
}

// ==================== MONITORING HANDLERS ====================

func handleMonitoringCurrent(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if deps.Monitoring == nil {
			writeError(w, http.StatusServiceUnavailable, "monitoring not available")
			return
		}
		writeJSON(w, deps.Monitoring.GetCurrent())
	}
}

func handleMonitoringHistory(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if deps.Monitoring == nil {
			writeError(w, http.StatusServiceUnavailable, "monitoring not available")
			return
		}
		writeJSON(w, deps.Monitoring.GetHistory())
	}
}

// ==================== LOGS HANDLERS ====================

func handleListLogContainers(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if deps.Logs == nil {
			writeJSON(w, []interface{}{})
			return
		}
		containers, err := deps.Logs.ListContainers()
		if err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		writeJSON(w, containers)
	}
}

func handleGetLogs(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if deps.Logs == nil {
			writeError(w, http.StatusServiceUnavailable, "logs not available")
			return
		}
		containerID := r.URL.Query().Get("container")
		tail := 100
		if t := r.URL.Query().Get("tail"); t != "" {
			fmt.Sscanf(t, "%d", &tail)
		}
		filter := r.URL.Query().Get("filter")
		
		ctx := r.Context()
		logs, err := deps.Logs.GetLogs(ctx, logs.LogQuery{
			ContainerID: containerID,
			Tail:        tail,
			Filter:      filter,
		})
		if err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		writeJSON(w, logs)
	}
}

func handleSearchLogs(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if deps.Logs == nil {
			writeError(w, http.StatusServiceUnavailable, "logs not available")
			return
		}
		var req struct {
			Container string `json:"container"`
			Query     string `json:"query"`
			Limit     int    `json:"limit"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeError(w, http.StatusBadRequest, "invalid JSON")
			return
		}
		ctx := r.Context()
		logs, err := deps.Logs.SearchLogs(ctx, req.Container, req.Query, req.Limit)
		if err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		writeJSON(w, logs)
	}
}

// ==================== COMPOSE HANDLERS ====================

func handleListComposeProjects(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if deps.Compose == nil {
			writeJSON(w, []interface{}{})
			return
		}
		writeJSON(w, deps.Compose.ListProjects())
	}
}

func handleCreateComposeProject(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if deps.Compose == nil {
			writeError(w, http.StatusServiceUnavailable, "compose not available")
			return
		}
		var req struct {
			Name   string `json:"name"`
			Config string `json:"config"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeError(w, http.StatusBadRequest, "invalid JSON")
			return
		}
		project, err := deps.Compose.CreateProject(req.Name, req.Config)
		if err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		writeJSON(w, project)
	}
}

func handleGetComposeProject(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if deps.Compose == nil {
			writeError(w, http.StatusServiceUnavailable, "compose not available")
			return
		}
		name := mux.Vars(r)["name"]
		project, ok := deps.Compose.GetProject(name)
		if !ok {
			writeError(w, http.StatusNotFound, "project not found")
			return
		}
		writeJSON(w, project)
	}
}

func handleUpdateComposeProject(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if deps.Compose == nil {
			writeError(w, http.StatusServiceUnavailable, "compose not available")
			return
		}
		name := mux.Vars(r)["name"]
		var req struct {
			Config string `json:"config"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeError(w, http.StatusBadRequest, "invalid JSON")
			return
		}
		project, err := deps.Compose.UpdateProject(name, req.Config)
		if err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		writeJSON(w, project)
	}
}

func handleDeleteComposeProject(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if deps.Compose == nil {
			writeError(w, http.StatusServiceUnavailable, "compose not available")
			return
		}
		name := mux.Vars(r)["name"]
		if err := deps.Compose.DeleteProject(name); err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		writeJSON(w, map[string]string{"status": "deleted"})
	}
}

func handleDeployComposeProject(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if deps.Compose == nil {
			writeError(w, http.StatusServiceUnavailable, "compose not available")
			return
		}
		name := mux.Vars(r)["name"]
		project, err := deps.Compose.DeployProject(name)
		if err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		writeJSON(w, project)
	}
}

func handleStopComposeProject(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if deps.Compose == nil {
			writeError(w, http.StatusServiceUnavailable, "compose not available")
			return
		}
		name := mux.Vars(r)["name"]
		if err := deps.Compose.StopProject(name); err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		writeJSON(w, map[string]string{"status": "stopped"})
	}
}

func handleValidateComposeConfig(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if deps.Compose == nil {
			writeError(w, http.StatusServiceUnavailable, "compose not available")
			return
		}
		var req struct {
			Config string `json:"config"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeError(w, http.StatusBadRequest, "invalid JSON")
			return
		}
		config, err := deps.Compose.ValidateConfig(req.Config)
		if err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		writeJSON(w, config)
	}
}

// ==================== ENV HANDLERS ====================

func handleListEnv(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if deps.Env == nil {
			writeJSON(w, []interface{}{})
			return
		}
		writeJSON(w, deps.Env.ListGlobal())
	}
}

func handleCreateEnv(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if deps.Env == nil {
			writeError(w, http.StatusServiceUnavailable, "env not available")
			return
		}
		var req struct {
			Key         string `json:"key"`
			Value       string `json:"value"`
			Description string `json:"description"`
			Secret      bool   `json:"secret"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeError(w, http.StatusBadRequest, "invalid JSON")
			return
		}
		deps.Env.SetGlobal(req.Key, req.Value, req.Description, req.Secret)
		writeJSON(w, map[string]string{"status": "created"})
	}
}

func handleDeleteEnv(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if deps.Env == nil {
			writeError(w, http.StatusServiceUnavailable, "env not available")
			return
		}
		key := mux.Vars(r)["key"]
		deps.Env.DeleteGlobal(key)
		writeJSON(w, map[string]string{"status": "deleted"})
	}
}

// ==================== NETWORK & VOLUME HANDLERS ====================

func handleListNetworks(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if deps.Network == nil {
			writeJSON(w, []interface{}{})
			return
		}
		networks, err := deps.Network.ListNetworks()
		if err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		writeJSON(w, networks)
	}
}

func handleCreateNetwork(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if deps.Network == nil {
			writeError(w, http.StatusServiceUnavailable, "network not available")
			return
		}
		var req network.NetworkCreateRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeError(w, http.StatusBadRequest, "invalid JSON")
			return
		}
		network, err := deps.Network.CreateNetwork(req)
		if err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		writeJSON(w, network)
	}
}

func handleDeleteNetwork(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if deps.Network == nil {
			writeError(w, http.StatusServiceUnavailable, "network not available")
			return
		}
		name := mux.Vars(r)["name"]
		if err := deps.Network.DeleteNetwork(name); err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		writeJSON(w, map[string]string{"status": "deleted"})
	}
}

func handlePruneNetworks(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if deps.Network == nil {
			writeError(w, http.StatusServiceUnavailable, "network not available")
			return
		}
		count, err := deps.Network.PruneNetworks()
		if err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		writeJSON(w, map[string]int64{"networks_deleted": count})
	}
}

func handleListVolumes(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if deps.Network == nil {
			writeJSON(w, []interface{}{})
			return
		}
		volumes, err := deps.Network.ListVolumes()
		if err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		writeJSON(w, volumes)
	}
}

func handleCreateVolume(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if deps.Network == nil {
			writeError(w, http.StatusServiceUnavailable, "network not available")
			return
		}
		var req network.VolumeCreateRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeError(w, http.StatusBadRequest, "invalid JSON")
			return
		}
		volume, err := deps.Network.CreateVolume(req)
		if err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		writeJSON(w, volume)
	}
}

func handleDeleteVolume(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if deps.Network == nil {
			writeError(w, http.StatusServiceUnavailable, "network not available")
			return
		}
		name := mux.Vars(r)["name"]
		if err := deps.Network.DeleteVolume(name, false); err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		writeJSON(w, map[string]string{"status": "deleted"})
	}
}

func handlePruneVolumes(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if deps.Network == nil {
			writeError(w, http.StatusServiceUnavailable, "network not available")
			return
		}
		reclaimed, err := deps.Network.PruneVolumes()
		if err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		writeJSON(w, map[string]int64{"space_reclaimed_bytes": reclaimed})
	}
}

// ==================== HELPERS ====================

func writeJSON(w http.ResponseWriter, data interface{}) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(data)
}

func writeError(w http.ResponseWriter, code int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(map[string]string{"error": msg})
}
