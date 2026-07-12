#!/bin/bash
# KATHAL OS — Linux Installer
# Installs KATHAL dashboard on Ubuntu/Debian/Fedora/Arch.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/Kathal-OS/kathal/master/scripts/install.sh | sudo bash
#   Or: sudo bash scripts/install.sh

set -e

VERSION="0.1.0"
INSTALL_DIR="/opt/kathal"
DATA_DIR="/var/lib/kathal"
PORT=8080

echo ""
echo "  KATHAL OS Installer (Linux)"
echo "  ============================"
echo ""

# Detect distro.
if [ -f /etc/os-release ]; then
    DISTRO=$(grep ^ID= /etc/os-release | cut -d= -f2 | tr -d '"')
else
    DISTRO="unknown"
fi

echo "  Detected: $DISTRO"

echo ""
echo "[1/6] Checking dependencies..."

# Check Docker (optional).
DOCKER_AVAILABLE=false
if command -v docker &>/dev/null; then
    DOCKER_VERSION=$(docker version --format '{{.Server.Version}}' 2>/dev/null || true)
    if [ -n "$DOCKER_VERSION" ]; then
        DOCKER_AVAILABLE=true
        echo "  Docker found: v$DOCKER_VERSION"
    fi
fi

if [ "$DOCKER_AVAILABLE" = false ]; then
    echo "  Docker not found — running in system-only mode (Docker optional)"
fi

echo ""
echo "[2/6] Downloading KATHAL v$VERSION..."

mkdir -p "$INSTALL_DIR" "$DATA_DIR"

# Detect architecture.
ARCH=$(uname -m)
case "$ARCH" in
    x86_64)  ARCH_NAME="amd64" ;;
    aarch64) ARCH_NAME="arm64" ;;
    armv7l)  ARCH_NAME="armv7" ;;
    *) echo "Unsupported architecture: $ARCH"; exit 1 ;;
esac

BINARY="$INSTALL_DIR/kathal"
DOWNLOAD_URL="https://github.com/Kathal-OS/kathal/releases/download/v$VERSION/kathal-$VERSION-linux-$ARCH_NAME"

if curl -fsSL -o "$BINARY" "$DOWNLOAD_URL" 2>/dev/null; then
    chmod +x "$BINARY"
    echo "  Downloaded pre-built binary"
else
    echo "  Pre-built binary not available, building from source..."

    if ! command -v go &>/dev/null; then
        echo "  Installing Go..."
        curl -fsSL https://go.dev/dl/go1.22.5.linux-${ARCH_NAME}.tar.gz | sudo tar -C /usr/local -xz
        export PATH=$PATH:/usr/local/go/bin
        echo 'export PATH=$PATH:/usr/local/go/bin' >> /etc/profile.d/kathal.sh
    fi

    TMPDIR=$(mktemp -d)
    cd "$TMPDIR"
    curl -fsSL "https://github.com/Kathal-OS/kathal/archive/refs/heads/main.tar.gz" | tar xz
    cd kathal-*
    go build -o "$BINARY" ./cmd/kathal
    cd /
    rm -rf "$TMPDIR"
    echo "  Built from source"
fi

echo ""
echo "[3/6] Creating configuration..."

# No config file needed — KATHAL reads env vars directly.

echo ""
echo "[4/6] Creating systemd service..."

cat > /etc/systemd/system/kathal.service << EOF
[Unit]
Description=KATHAL OS Dashboard
After=network.target

[Service]
Type=simple
ExecStart=$BINARY
WorkingDirectory=$DATA_DIR
Restart=always
RestartSec=5
Environment=KATHAL_HTTP_ADDR=:$PORT
Environment=KATHAL_DB_PATH=$DATA_DIR/kathal.db

# Security hardening.
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=$DATA_DIR
ProtectHome=true

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
echo "  Service created"

echo ""
echo "[5/6] Setting permissions..."

chown -R root:root "$DATA_DIR" 2>/dev/null || true

echo ""
echo "[6/6] Starting KATHAL..."

systemctl enable kathal
systemctl start kathal

# Wait for startup.
sleep 2

if systemctl is-active --quiet kathal; then
    echo ""
    echo "  KATHAL OS is running!"
    echo ""
    echo "  Dashboard: http://localhost:$PORT"
    echo "  Login:     admin@kathal.local / kathal"
    echo ""
    echo "  Commands:"
    echo "    Status:  systemctl status kathal"
    echo "    Start:   systemctl start kathal"
    echo "    Stop:    systemctl stop kathal"
    echo "    Restart: systemctl restart kathal"
    echo "    Logs:    journalctl -u kathal -f"
    echo "    Uninstall: sudo bash $INSTALL_DIR/uninstall.sh"
    echo ""
else
    echo ""
    echo "  KATHAL failed to start. Check logs:"
    echo "    journalctl -u kathal -n 50"
    echo ""
fi