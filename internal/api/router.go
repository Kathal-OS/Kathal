// Package api provides the REST API for the KATHAL OS dashboard.
package api

import (
	"encoding/json"
	"io"
	"net/http"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/bakeweb/kathal-os/internal/auth"
	"github.com/bakeweb/kathal-os/internal/backup"
	"github.com/bakeweb/kathal-os/internal/config"
	"github.com/bakeweb/kathal-os/internal/dbmanager"
	"github.com/bakeweb/kathal-os/internal/docker"
	"github.com/bakeweb/kathal-os/internal/filemanager"
	"github.com/bakeweb/kathal-os/internal/metrics"
	"github.com/bakeweb/kathal-os/internal/proxy"
	"github.com/bakeweb/kathal-os/internal/store"
	"github.com/gorilla/mux"
)

// Deps holds all dependencies for the API.
type Deps struct {
	Config    *config.Config
	Store     *store.DB
	Docker    *docker.Client
	Metrics   *metrics.Collector
	JWT       *auth.JWT
	Proxy     *proxy.Manager
	DBManager *dbmanager.Manager
	Files     *filemanager.Manager
	Backup    *backup.Manager
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

	// Login (public — no JWT required).
	api.HandleFunc("/login", handleLogin(deps)).Methods("POST")

	// Serve static files (React build) — catch-all for frontend routes.
	r.PathPrefix("/").Handler(http.FileServer(http.Dir("web/dist")))

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
