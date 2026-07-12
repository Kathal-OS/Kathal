// Package backup provides backup and restore functionality for the KATHAL database and configuration.
package backup

import (
	"archive/zip"
	"bytes"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// Backup represents a backup entry.
type Backup struct {
	ID        string    `json:"id"`
	Name      string    `json:"name"`
	Size      int64     `json:"size"`
	CreatedAt time.Time `json:"createdAt"`
	Path      string    `json:"-"`
}

// Manager handles backup and restore operations.
type Manager struct {
	dataDir string
	dbPath  string
}

// NewManager creates a new backup manager.
func NewManager(dataDir string, dbPath string) *Manager {
	return &Manager{
		dataDir: dataDir,
		dbPath:  dbPath,
	}
}

// backupDir returns the backups directory path, creating it if necessary.
func (m *Manager) backupDir() (string, error) {
	dir := filepath.Join(m.dataDir, "backups")
	if err := os.MkdirAll(dir, 0755); err != nil {
		return "", fmt.Errorf("create backups directory: %w", err)
	}
	return dir, nil
}

// CreateBackup creates a new backup with the given name.
// It copies the database and configuration files to a timestamped .bak file.
func (m *Manager) CreateBackup(name string) (*Backup, error) {
	if name == "" {
		name = "manual"
	}

	dir, err := m.backupDir()
	if err != nil {
		return nil, err
	}

	// Generate filename with timestamp
	timestamp := time.Now().Format("20060102-150405")
	filename := fmt.Sprintf("%s-%s.bak", timestamp, name)
	backupPath := filepath.Join(dir, filename)

	// Create the zip archive
	zipFile, err := os.Create(backupPath)
	if err != nil {
		return nil, fmt.Errorf("create backup file: %w", err)
	}
	defer zipFile.Close()

	zipWriter := zip.NewWriter(zipFile)
	defer zipWriter.Close()

	// Add database file
	if err := addFileToZip(zipWriter, m.dbPath, "kathal.db"); err != nil {
		return nil, fmt.Errorf("backup database: %w", err)
	}

	// Add proxy-routes.json if it exists
	proxyRoutesPath := filepath.Join(m.dataDir, "proxy-routes.json")
	if fileExists(proxyRoutesPath) {
		if err := addFileToZip(zipWriter, proxyRoutesPath, "proxy-routes.json"); err != nil {
			return nil, fmt.Errorf("backup proxy-routes: %w", err)
		}
	}

	// Add databases.json if it exists
	databasesPath := filepath.Join(m.dataDir, "databases.json")
	if fileExists(databasesPath) {
		if err := addFileToZip(zipWriter, databasesPath, "databases.json"); err != nil {
			return nil, fmt.Errorf("backup databases config: %w", err)
		}
	}

	// Get file info for size
	info, err := os.Stat(backupPath)
	if err != nil {
		return nil, fmt.Errorf("get backup info: %w", err)
	}

	// Extract ID from filename (filename without extension)
	id := strings.TrimSuffix(filename, filepath.Ext(filename))

	return &Backup{
		ID:        id,
		Name:      name,
		Size:      info.Size(),
		CreatedAt: info.ModTime(),
		Path:      backupPath,
	}, nil
}

// ListBackups returns all available backups.
func (m *Manager) ListBackups() []*Backup {
	dir, err := m.backupDir()
	if err != nil {
		return nil
	}

	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}

	var backups []*Backup
	for _, entry := range entries {
		if entry.IsDir() || filepath.Ext(entry.Name()) != ".bak" {
			continue
		}

		info, err := entry.Info()
		if err != nil {
			continue
		}

		id := strings.TrimSuffix(entry.Name(), filepath.Ext(entry.Name()))
		// Extract name from ID (remove timestamp prefix)
		name := extractName(id)

		backups = append(backups, &Backup{
			ID:        id,
			Name:      name,
			Size:      info.Size(),
			CreatedAt: info.ModTime(),
			Path:      filepath.Join(dir, entry.Name()),
		})
	}

	return backups
}

// Restore restores a backup by ID.
// It replaces the current database with the backup.
func (m *Manager) Restore(backupID string) error {
	dir, err := m.backupDir()
	if err != nil {
		return err
	}

	// Find the backup file
	backupPath := filepath.Join(dir, backupID+".bak")
	if !fileExists(backupPath) {
		return fmt.Errorf("backup not found: %s", backupID)
	}

	// Open the zip file
	zipFile, err := zip.OpenReader(backupPath)
	if err != nil {
		return fmt.Errorf("open backup: %w", err)
	}
	defer zipFile.Close()

	// Extract and restore files
	for _, file := range zipFile.File {
		switch file.Name {
		case "kathal.db":
			if err := extractFileFromZip(file, m.dbPath); err != nil {
				return fmt.Errorf("restore database: %w", err)
			}
		case "proxy-routes.json":
			destPath := filepath.Join(m.dataDir, "proxy-routes.json")
			if err := extractFileFromZip(file, destPath); err != nil {
				return fmt.Errorf("restore proxy-routes: %w", err)
			}
		case "databases.json":
			destPath := filepath.Join(m.dataDir, "databases.json")
			if err := extractFileFromZip(file, destPath); err != nil {
				return fmt.Errorf("restore databases config: %w", err)
			}
		}
	}

	return nil
}

// DeleteBackup removes a backup file by ID.
func (m *Manager) DeleteBackup(backupID string) error {
	dir, err := m.backupDir()
	if err != nil {
		return err
	}

	backupPath := filepath.Join(dir, backupID+".bak")
	if !fileExists(backupPath) {
		return fmt.Errorf("backup not found: %s", backupID)
	}

	return os.Remove(backupPath)
}

// ExportAll creates a zip archive of all data files.
func (m *Manager) ExportAll() ([]byte, error) {
	var buf bytes.Buffer
	zipWriter := zip.NewWriter(&buf)

	// Add database
	if err := addFileToZip(zipWriter, m.dbPath, "kathal.db"); err != nil {
		return nil, fmt.Errorf("export database: %w", err)
	}

	// Add proxy-routes.json if it exists
	proxyRoutesPath := filepath.Join(m.dataDir, "proxy-routes.json")
	if fileExists(proxyRoutesPath) {
		if err := addFileToZip(zipWriter, proxyRoutesPath, "proxy-routes.json"); err != nil {
			return nil, fmt.Errorf("export proxy-routes: %w", err)
		}
	}

	// Add databases.json if it exists
	databasesPath := filepath.Join(m.dataDir, "databases.json")
	if fileExists(databasesPath) {
		if err := addFileToZip(zipWriter, databasesPath, "databases.json"); err != nil {
			return nil, fmt.Errorf("export databases config: %w", err)
		}
	}

	// Add backups directory if it exists
	backupsDir := filepath.Join(m.dataDir, "backups")
	if dirExists(backupsDir) {
		entries, err := os.ReadDir(backupsDir)
		if err == nil {
			for _, entry := range entries {
				if !entry.IsDir() && filepath.Ext(entry.Name()) == ".bak" {
					backupPath := filepath.Join(backupsDir, entry.Name())
					zipEntry := filepath.Join("backups", entry.Name())
					if err := addFileToZip(zipWriter, backupPath, zipEntry); err != nil {
						return nil, fmt.Errorf("export backup %s: %w", entry.Name(), err)
					}
				}
			}
		}
	}

	if err := zipWriter.Close(); err != nil {
		return nil, fmt.Errorf("close zip writer: %w", err)
	}

	return buf.Bytes(), nil
}

// ImportAll extracts a zip archive to the data directory.
func (m *Manager) ImportAll(data []byte) error {
	zipReader, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return fmt.Errorf("open import archive: %w", err)
	}

	for _, file := range zipReader.File {
		// Determine destination path
		var destPath string
		switch file.Name {
		case "kathal.db":
			destPath = m.dbPath
		case "proxy-routes.json", "databases.json":
			destPath = filepath.Join(m.dataDir, file.Name)
		default:
			// Handle backups directory
			if strings.HasPrefix(file.Name, "backups/") {
				destPath = filepath.Join(m.dataDir, file.Name)
			} else {
				// Skip unknown files
				continue
			}
		}

		// Create directory if needed
		destDir := filepath.Dir(destPath)
		if err := os.MkdirAll(destDir, 0755); err != nil {
			return fmt.Errorf("create directory for %s: %w", file.Name, err)
		}

		if err := extractFileFromZip(file, destPath); err != nil {
			return fmt.Errorf("extract %s: %w", file.Name, err)
		}
	}

	return nil
}

// addFileToZip adds a file to a zip archive.
func addFileToZip(zipWriter *zip.Writer, filePath, archivePath string) error {
	file, err := os.Open(filePath)
	if err != nil {
		return err
	}
	defer file.Close()

	info, err := file.Stat()
	if err != nil {
		return err
	}

	header, err := zip.FileInfoHeader(info)
	if err != nil {
		return err
	}
	header.Name = archivePath
	header.Method = zip.Deflate

	writer, err := zipWriter.CreateHeader(header)
	if err != nil {
		return err
	}

	_, err = io.Copy(writer, file)
	return err
}

// extractFileFromZip extracts a single file from a zip archive.
func extractFileFromZip(file *zip.File, destPath string) error {
	srcFile, err := file.Open()
	if err != nil {
		return err
	}
	defer srcFile.Close()

	destFile, err := os.Create(destPath)
	if err != nil {
		return err
	}
	defer destFile.Close()

	_, err = io.Copy(destFile, srcFile)
	return err
}

// fileExists checks if a file exists.
func fileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

// dirExists checks if a directory exists.
func dirExists(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.IsDir()
}

// extractName extracts the backup name from the ID (removes timestamp prefix).
func extractName(id string) string {
	// ID format: YYYYMMDD-HHMMSS-name
	parts := strings.SplitN(id, "-", 3)
	if len(parts) >= 3 {
		return parts[2]
	}
	return id
}
