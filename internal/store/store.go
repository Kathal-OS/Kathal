// Package store provides local persistence using SQLite.
package store

import (
	"database/sql"
	"fmt"
	"time"

	_ "modernc.org/sqlite"
)

// DB wraps the SQLite database.
type DB struct {
	conn *sql.DB
}

// App represents a deployed application.
type App struct {
	ID          string    `json:"id"`
	Name        string    `json:"name"`
	Description string    `json:"description"`
	DockerImage string    `json:"dockerImage"`
	Status      string    `json:"status"`
	Port        int       `json:"port"`
	Domain      string    `json:"domain"`
	Config      string    `json:"config"`
	CreatedAt   time.Time `json:"createdAt"`
	UpdatedAt   time.Time `json:"updatedAt"`
}

// New opens (or creates) the SQLite database and runs migrations.
func New(path string) (*DB, error) {
	conn, err := sql.Open("sqlite", path+"?_journal_mode=WAL&_busy_timeout=5000")
	if err != nil {
		return nil, fmt.Errorf("open database: %w", err)
	}

	db := &DB{conn: conn}
	if err := db.migrate(); err != nil {
		conn.Close()
		return nil, fmt.Errorf("migrate: %w", err)
	}

	return db, nil
}

func (db *DB) migrate() error {
	_, err := db.conn.Exec(`
		CREATE TABLE IF NOT EXISTS apps (
			id          TEXT PRIMARY KEY,
			name        TEXT NOT NULL,
			description TEXT NOT NULL DEFAULT '',
			docker_image TEXT NOT NULL,
			status      TEXT NOT NULL DEFAULT 'stopped',
			port        INTEGER NOT NULL DEFAULT 0,
			domain      TEXT NOT NULL DEFAULT '',
			config      TEXT NOT NULL DEFAULT '{}',
			created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
			updated_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
		);

		CREATE TABLE IF NOT EXISTS settings (
			key   TEXT PRIMARY KEY,
			value TEXT NOT NULL
		);

		CREATE TABLE IF NOT EXISTS users (
			id            TEXT PRIMARY KEY,
			email         TEXT NOT NULL UNIQUE,
			password_hash TEXT NOT NULL,
			role          TEXT NOT NULL DEFAULT 'admin',
			created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
		);
	`)
	return err
}

// User represents a dashboard user.
type User struct {
	ID           string
	Email        string
	PasswordHash string
	Role         string
}

// GetUserByEmail returns a user by email, or an error if none exists.
func (db *DB) GetUserByEmail(email string) (*User, error) {
	var u User
	err := db.conn.QueryRow(`
		SELECT id, email, password_hash, role FROM users WHERE email = ?
	`, email).Scan(&u.ID, &u.Email, &u.PasswordHash, &u.Role)
	if err != nil {
		return nil, err
	}
	return &u, nil
}

// CountUsers returns the number of registered users.
func (db *DB) CountUsers() (int, error) {
	var n int
	err := db.conn.QueryRow(`SELECT COUNT(*) FROM users`).Scan(&n)
	return n, err
}

// CreateUser inserts a new user with an already-hashed password.
func (db *DB) CreateUser(u *User) error {
	_, err := db.conn.Exec(`
		INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, ?)
	`, u.ID, u.Email, u.PasswordHash, u.Role)
	return err
}

// Close closes the database.
func (db *DB) Close() error {
	return db.conn.Close()
}

// ListApps returns all apps.
func (db *DB) ListApps() ([]App, error) {
	rows, err := db.conn.Query(`
		SELECT id, name, description, docker_image, status, port, domain, config, created_at, updated_at
		FROM apps ORDER BY created_at DESC
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var apps []App
	for rows.Next() {
		var a App
		if err := rows.Scan(&a.ID, &a.Name, &a.Description, &a.DockerImage, &a.Status, &a.Port, &a.Domain, &a.Config, &a.CreatedAt, &a.UpdatedAt); err != nil {
			return nil, err
		}
		apps = append(apps, a)
	}
	return apps, nil
}

// GetApp returns an app by ID.
func (db *DB) GetApp(id string) (*App, error) {
	var a App
	err := db.conn.QueryRow(`
		SELECT id, name, description, docker_image, status, port, domain, config, created_at, updated_at
		FROM apps WHERE id = ?
	`, id).Scan(&a.ID, &a.Name, &a.Description, &a.DockerImage, &a.Status, &a.Port, &a.Domain, &a.Config, &a.CreatedAt, &a.UpdatedAt)
	if err != nil {
		return nil, err
	}
	return &a, nil
}

// CreateApp inserts a new app.
func (db *DB) CreateApp(a *App) error {
	_, err := db.conn.Exec(`
		INSERT INTO apps (id, name, description, docker_image, status, port, domain, config)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)
	`, a.ID, a.Name, a.Description, a.DockerImage, a.Status, a.Port, a.Domain, a.Config)
	return err
}

// UpdateApp updates an existing app.
func (db *DB) UpdateApp(a *App) error {
	_, err := db.conn.Exec(`
		UPDATE apps SET name=?, description=?, docker_image=?, status=?, port=?, domain=?, config=?, updated_at=?
		WHERE id=?
	`, a.Name, a.Description, a.DockerImage, a.Status, a.Port, a.Domain, a.Config, time.Now(), a.ID)
	return err
}

// DeleteApp deletes an app.
func (db *DB) DeleteApp(id string) error {
	_, err := db.conn.Exec(`DELETE FROM apps WHERE id = ?`, id)
	return err
}

// GetSetting returns a setting value.
func (db *DB) GetSetting(key string) (string, error) {
	var val string
	err := db.conn.QueryRow(`SELECT value FROM settings WHERE key = ?`, key).Scan(&val)
	return val, err
}

// SetSetting sets a setting value.
func (db *DB) SetSetting(key, value string) error {
	_, err := db.conn.Exec(`INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`, key, value)
	return err
}
