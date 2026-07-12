# KATHAL OS 🍈

**Portable, self-hosted OS with a web dashboard — runs on Windows, Linux, and Mac.**

Like CasaOS, but simpler. One binary, one browser tab, manage everything.

## Quick Start

### Docker (any platform)
```bash
docker run -d --name kathal --restart unless-stopped \
  -p 8080:8080 \
  -v /var/run/docker.sock:/var/run/docker.sock \
  ghcr.io/bakeweb/kathal-os:latest
```
Open http://localhost:8080

### Linux (Ubuntu/Debian/Fedora/Arch)
```bash
curl -fsSL https://raw.githubusercontent.com/bakeweb/kathal-os/master/scripts/install.sh | sudo bash
```

### macOS
```bash
curl -fsSL https://raw.githubusercontent.com/bakeweb/kathal-os/master/scripts/install-mac.sh | bash
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

## License

MIT — Built for the community.
