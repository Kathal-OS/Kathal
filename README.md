# KATHAL OS 🍈

**Portable, self-hosted OS with a web dashboard — runs on Windows, Linux, and Mac.**

Like CasaOS, but simpler. One binary, one browser tab, manage everything.

## Quick Start

### Docker (any platform)
```bash
docker run -d --name kathal --restart unless-stopped \
  -p 8080:8080 \
  -v /var/run/docker.sock:/var/run/docker.sock \
  ghcr.io/Kathal-OS/kathal:latest
```
Open http://localhost:8080

### Linux (Ubuntu/Debian/Fedora/Arch)
```bash
curl -fsSL https://raw.githubusercontent.com/Kathal-OS/kathal/master/scripts/install.sh | sudo bash
```

### macOS
```bash
curl -fsSL https://raw.githubusercontent.com/Kathal-OS/kathal/master/scripts/install-mac.sh | bash
```

### Windows
```powershell
powershell -ExecutionPolicy Bypass -File install.ps1
```

### Login
- Email: `admin@kathal.local`
- Password: `kathal`

## Features

- **Dashboard** — real-time CPU, RAM, disk, network metrics
- **Container Management** — start/stop/restart/delete containers (Docker required)
- **Image Browser** — view all Docker images
- **App Store** — one-click deploy popular apps (Nginx, Postgres, Redis, etc.)
- **JWT Authentication** — secure dashboard access
- **System-Only Mode** — works without Docker for system monitoring
- **Cross-Platform** — Windows, Linux, Mac, Docker
- **Reverse Proxy** — auto SSL with Let's Encrypt + self-signed certs
- **Database Management** — PostgreSQL, MySQL, MongoDB, Redis
- **File Manager** — browse, upload, edit files
- **Backup/Restore** — ZIP backup with export/import
- **Service Templates** — 35+ pre-configured apps
- **Git Deploy** — GitHub/GitLab webhook deployments
- **Web Terminal** — xterm.js PTY terminal in browser
- **Monitoring** — real-time metrics with history
- **Logs** — centralized container log viewer
- **Docker Compose** — visual YAML editor + deploy
- **Environment Variables** — global + per-service
- **Network/Volume Management** — Docker networks & volumes

## Architecture

```
┌─────────────────────────────────────┐
│         React Dashboard             │
│    (Vite + Tailwind + React)        │
├─────────────────────────────────────┤
│         Go Backend                  │
│  ┌──────┐ ┌──────┐ ┌──────────┐    │
│  │ API  │ │ Auth │ │ Metrics  │    │
│  └──┬───┘ └──┬───┘ └────┬─────┘    │
│     └────────┼──────────┘          │
│              │                      │
│  ┌───────────┴────────────┐        │
│  │    SQLite (modernc)    │        │
│  └────────────────────────┘        │
│              │                      │
│  ┌───────────┴────────────┐        │
│  │  Docker (optional)     │        │
│  │  gopsutil (system)     │        │
│  └────────────────────────┘        │
└─────────────────────────────────────┘
```

## Platform Support

| Platform | Docker | System Metrics | Installer | Auto-Start |
|----------|--------|----------------|-----------|------------|
| Linux    | ✅     | ✅              | ✅ bash   | ✅ systemd |
| macOS    | ✅     | ✅              | ✅ bash   | ✅ launchd |
| Windows  | ✅     | ✅              | ✅ PS1    | ⚠️ manual  |
| Docker   | ✅     | ✅              | ✅        | ✅         |

## Development

### Prerequisites
- Go 1.22+
- Node.js 18+
- Docker (optional)

### Build
```bash
# Backend
go build -o kathal ./cmd/kathal

# Frontend
cd web && npm install && npm run build

# Cross-compile
GOOS=linux GOARCH=amd64 go build -o kathal-linux-amd64 ./cmd/kathal
GOOS=darwin GOARCH=arm64 go build -o kathal-darwin-arm64 ./cmd/kathal
GOOS=windows GOARCH=amd64 go build -o kathal.exe ./cmd/kathal
```

### Run
```bash
./kathal
# Open http://localhost:8080
```

## API Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/v1/login` | No | Get JWT token |
| GET | `/api/v1/status` | Yes | Cross-platform system status |
| GET | `/api/v1/metrics` | Yes | CPU, RAM, disk, network metrics |
| GET | `/api/v1/system` | Yes | System info |
| GET | `/api/v1/containers` | Yes | List Docker containers |
| POST | `/api/v1/containers/{id}/start` | Yes | Start container |
| POST | `/api/v1/containers/{id}/stop` | Yes | Stop container |
| POST | `/api/v1/containers/{id}/restart` | Yes | Restart container |
| DELETE | `/api/v1/containers/{id}/delete` | Yes | Delete container |
| GET | `/api/v1/images` | Yes | List Docker images |
| GET | `/api/v1/apps` | Yes | List managed apps |
| POST | `/api/v1/apps` | Yes | Create app |
| GET | `/api/v1/proxy` | Yes | List proxy routes |
| POST | `/api/v1/proxy` | Yes | Create proxy route |
| GET | `/api/v1/databases` | Yes | List databases |
| POST | `/api/v1/databases` | Yes | Create database |
| GET | `/api/v1/files` | Yes | List files |
| GET | `/api/v1/backups` | Yes | List backups |
| POST | `/api/v1/backups` | Yes | Create backup |
| GET | `/api/v1/templates` | Yes | List service templates |
| GET | `/api/v1/git/repos` | Yes | List git repos |
| POST | `/api/v1/git/repos` | Yes | Add git repo |
| GET | `/api/v1/monitoring/current` | Yes | Current metrics |
| GET | `/api/v1/monitoring/history` | Yes | Metrics history |
| GET | `/api/v1/logs/containers` | Yes | List log containers |
| GET | `/api/v1/logs` | Yes | Get container logs |
| GET | `/api/v1/compose` | Yes | List compose projects |
| GET | `/api/v1/env` | Yes | List env vars |
| GET | `/api/v1/network` | Yes | List networks |
| GET | `/api/v1/volumes` | Yes | List volumes |

## Configuration

### Environment Variables
| Variable | Default | Description |
|----------|---------|-------------|
| `KATHAL_PORT` | `8080` | HTTP server port |
| `KATHAL_DB` | `./kathal.db` | SQLite database path |
| `KATHAL_ADDR` | `:8080` | Listen address |

### Config File
Create `config.json`:
```json
{
  "port": 8080,
  "logLevel": "info",
  "dbPath": "./kathal.db"
}
```

## Uninstall

### Linux
```bash
sudo systemctl stop kathal
sudo systemctl disable kathal
sudo rm /etc/systemd/system/kathal.service
sudo rm -rf /opt/kathal /etc/kathal /var/lib/kathal
```

### macOS
```bash
launchctl unload ~/Library/LaunchAgents/com.kathal.dashboard.plist
rm ~/Library/LaunchAgents/com.kathal.dashboard.plist
rm -rf ~/.kathal
```

### Windows
```powershell
Remove-Item -Recurse "$env:LOCALAPPDATA\kathal"
```

## Links

- **Official Repository**: https://github.com/Kathal-OS/kathal
- **Issues**: https://github.com/Kathal-OS/kathal/issues
- **Discussions**: https://github.com/Kathal-OS/kathal/discussions
- **Releases**: https://github.com/Kathal-OS/kathal/releases
- **Docker Images**: https://github.com/Kathal-OS/kathal/pkgs/container/kathal

## License

MIT — Built for the community.