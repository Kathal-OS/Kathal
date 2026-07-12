// Package filemanager provides file browsing, upload, download, and basic
// file operations for the KATHAL OS web dashboard.
package filemanager

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const (
	// MaxReadSize is the maximum file size for text reads (10 MB).
	MaxReadSize = 10 * 1024 * 1024

	// DefaultRoot is the default root directory when none is specified.
	// On Linux it resolves to /var/lib/kathal, elsewhere to ~/.kathal/data.
	DefaultRoot = "/var/lib/kathal"
)

var (
	// ErrPathTraversal is returned when a path attempts to escape the root.
	ErrPathTraversal = errors.New("path traversal not allowed")
	// ErrEmptyPath is returned when an empty path is provided.
	ErrEmptyPath = errors.New("path must not be empty")
	// ErrFileSizeExceeded is returned when a file exceeds MaxReadSize.
	ErrFileSizeExceeded = errors.New("file size exceeds 10 MB read limit")
	// ErrNotRegularFile is returned when Read is called on a non-regular file.
	ErrNotRegularFile = errors.New("not a regular file")
)

// Manager provides file operations scoped to a root directory.
type Manager struct {
	rootDir string
}

// DirListing represents a directory's contents.
type DirListing struct {
	Path  string      `json:"path"`
	Files []*FileInfo `json:"files"`
}

// FileInfo describes a single file or directory.
type FileInfo struct {
	Name    string      `json:"name"`
	Path    string      `json:"path"`
	Size    int64       `json:"size"`
	IsDir   bool        `json:"isDir"`
	ModTime time.Time   `json:"modTime"`
	Mode    os.FileMode `json:"mode"`
}

// NewManager creates a file Manager rooted at the given directory.
// If rootDir is empty, the default root is used.
func NewManager(rootDir string) *Manager {
	if rootDir == "" {
		rootDir = DefaultRoot
	}
	// Clean and resolve to an absolute path.
	abs, err := filepath.Abs(rootDir)
	if err != nil {
		// Fallback to the raw path if Abs fails (shouldn't happen normally).
		abs = rootDir
	}
	return &Manager{rootDir: abs}
}

// RootDir returns the absolute root directory path.
func (m *Manager) RootDir() string {
	return m.rootDir
}

// resolvePath validates and resolves a user-supplied relative path to an
// absolute path under rootDir. Returns ErrPathTraversal if the path escapes
// the root.
func (m *Manager) resolvePath(relPath string) (string, error) {
	if relPath == "" {
		return "", ErrEmptyPath
	}
	// Reject any path containing ".." components.
	// We check both the raw string and the cleaned form to catch encoded variants.
	if strings.Contains(relPath, "..") {
		return "", fmt.Errorf("%w: %s", ErrPathTraversal, relPath)
	}

	// Combine with root and clean.
	abs := filepath.Join(m.rootDir, filepath.Clean(relPath))

	// After cleaning, verify it still lives under rootDir.
	if !strings.HasPrefix(abs, m.rootDir) {
		return "", fmt.Errorf("%w: %s", ErrPathTraversal, relPath)
	}
	return abs, nil
}

// toRelPath converts an absolute path back to a path relative to rootDir.
func (m *Manager) toRelPath(absPath string) string {
	rel, err := filepath.Rel(m.rootDir, absPath)
	if err != nil {
		// If Rel fails, return the cleaned absolute path.
		return filepath.Clean(absPath)
	}
	return filepath.ToSlash(rel)
}

// List returns the contents of the directory at the given relative path.
func (m *Manager) List(relPath string) (*DirListing, error) {
	abs, err := m.resolvePath(relPath)
	if err != nil {
		return nil, err
	}

	info, err := os.Stat(abs)
	if err != nil {
		return nil, fmt.Errorf("stat directory: %w", err)
	}
	if !info.IsDir() {
		return nil, fmt.Errorf("path is not a directory: %s", relPath)
	}

	entries, err := os.ReadDir(abs)
	if err != nil {
		return nil, fmt.Errorf("read directory: %w", err)
	}

	files := make([]*FileInfo, 0, len(entries))
	for _, entry := range entries {
		fi, err := entry.Info()
		if err != nil {
			// Skip entries we can't stat (permissions, broken symlinks, etc.).
			continue
		}
		files = append(files, &FileInfo{
			Name:    fi.Name(),
			Path:    filepath.ToSlash(filepath.Join(relPath, fi.Name())),
			Size:    fi.Size(),
			IsDir:   fi.IsDir(),
			ModTime: fi.ModTime(),
			Mode:    fi.Mode(),
		})
	}

	return &DirListing{
		Path:  filepath.ToSlash(relPath),
		Files: files,
	}, nil
}

// Read returns the contents of a file at the given relative path.
// Only regular files are accepted, and the size must not exceed MaxReadSize.
func (m *Manager) Read(relPath string) ([]byte, error) {
	abs, err := m.resolvePath(relPath)
	if err != nil {
		return nil, err
	}

	info, err := os.Stat(abs)
	if err != nil {
		return nil, fmt.Errorf("stat file: %w", err)
	}
	if info.IsDir() {
		return nil, fmt.Errorf("%w: %s", ErrNotRegularFile, relPath)
	}
	if info.Size() > MaxReadSize {
		return nil, fmt.Errorf("%w: %d bytes", ErrFileSizeExceeded, info.Size())
	}

	data, err := os.ReadFile(abs)
	if err != nil {
		return nil, fmt.Errorf("read file: %w", err)
	}
	return data, nil
}

// Write writes data to the file at the given relative path.
// Intermediate directories are created as needed.
func (m *Manager) Write(relPath string, data []byte) error {
	abs, err := m.resolvePath(relPath)
	if err != nil {
		return err
	}

	// Ensure the parent directory exists.
	dir := filepath.Dir(abs)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("create directory: %w", err)
	}

	if err := os.WriteFile(abs, data, 0o644); err != nil {
		return fmt.Errorf("write file: %w", err)
	}
	return nil
}

// Delete removes the file or directory at the given relative path.
// Directories are removed recursively.
func (m *Manager) Delete(relPath string) error {
	abs, err := m.resolvePath(relPath)
	if err != nil {
		return err
	}

	// Prevent deleting the root itself.
	if abs == m.rootDir {
		return errors.New("cannot delete root directory")
	}

	if err := os.RemoveAll(abs); err != nil {
		return fmt.Errorf("delete: %w", err)
	}
	return nil
}

// Mkdir creates the directory at the given relative path.
// All intermediate directories are created as needed.
func (m *Manager) Mkdir(relPath string) error {
	abs, err := m.resolvePath(relPath)
	if err != nil {
		return err
	}

	if err := os.MkdirAll(abs, 0o755); err != nil {
		return fmt.Errorf("create directory: %w", err)
	}
	return nil
}

// Rename moves or renames a file/directory from oldPath to newPath.
// Both paths must be relative to rootDir.
func (m *Manager) Rename(oldRelPath, newRelPath string) error {
	oldAbs, err := m.resolvePath(oldRelPath)
	if err != nil {
		return fmt.Errorf("old path: %w", err)
	}
	newAbs, err := m.resolvePath(newRelPath)
	if err != nil {
		return fmt.Errorf("new path: %w", err)
	}

	// Ensure the parent directory of the destination exists.
	if err := os.MkdirAll(filepath.Dir(newAbs), 0o755); err != nil {
		return fmt.Errorf("create destination directory: %w", err)
	}

	if err := os.Rename(oldAbs, newAbs); err != nil {
		return fmt.Errorf("rename: %w", err)
	}
	return nil
}

// Stat returns file info for the path at the given relative path.
func (m *Manager) Stat(relPath string) (*FileInfo, error) {
	abs, err := m.resolvePath(relPath)
	if err != nil {
		return nil, err
	}

	info, err := os.Stat(abs)
	if err != nil {
		return nil, fmt.Errorf("stat: %w", err)
	}

	return &FileInfo{
		Name:    info.Name(),
		Path:    filepath.ToSlash(relPath),
		Size:    info.Size(),
		IsDir:   info.IsDir(),
		ModTime: info.ModTime(),
		Mode:    info.Mode(),
	}, nil
}

// GetSize returns the size in bytes of the file at the given relative path.
func (m *Manager) GetSize(relPath string) (int64, error) {
	abs, err := m.resolvePath(relPath)
	if err != nil {
		return 0, err
	}

	info, err := os.Stat(abs)
	if err != nil {
		return 0, fmt.Errorf("stat: %w", err)
	}
	return info.Size(), nil
}

// EnsureRootDir creates the root directory if it doesn't already exist.
// This should be called at startup to initialize the file manager.
func (m *Manager) EnsureRootDir() error {
	if err := os.MkdirAll(m.rootDir, 0o755); err != nil {
		return fmt.Errorf("create root directory: %w", err)
	}
	return nil
}

// Copy copies a file from src to dst, where both are relative to rootDir.
// The destination's parent directory is created if needed.
func (m *Manager) Copy(srcRelPath, dstRelPath string) error {
	srcAbs, err := m.resolvePath(srcRelPath)
	if err != nil {
		return fmt.Errorf("source path: %w", err)
	}
	dstAbs, err := m.resolvePath(dstRelPath)
	if err != nil {
		return fmt.Errorf("destination path: %w", err)
	}

	// Ensure the destination parent directory exists.
	if err := os.MkdirAll(filepath.Dir(dstAbs), 0o755); err != nil {
		return fmt.Errorf("create destination directory: %w", err)
	}

	srcFile, err := os.Open(srcAbs)
	if err != nil {
		return fmt.Errorf("open source: %w", err)
	}
	defer srcFile.Close()

	srcInfo, err := srcFile.Stat()
	if err != nil {
		return fmt.Errorf("stat source: %w", err)
	}
	if srcInfo.IsDir() {
		return fmt.Errorf("source is a directory: %s", srcRelPath)
	}

	dstFile, err := os.OpenFile(dstAbs, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, srcInfo.Mode())
	if err != nil {
		return fmt.Errorf("create destination: %w", err)
	}
	defer func() {
		dstFile.Close()
		// Clean up on copy failure.
		if err != nil {
			os.Remove(dstAbs)
		}
	}()

	if _, err = io.Copy(dstFile, srcFile); err != nil {
		return fmt.Errorf("copy: %w", err)
	}
	return nil
}
