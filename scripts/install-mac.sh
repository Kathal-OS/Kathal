#!/bin/bash
# KATHAL OS — macOS Installer
# Installs KATHAL dashboard on macOS.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/Kathal-OS/kathal/master/scripts/install-mac.sh | bash
#   Or: bash scripts/install-mac.sh

set -e

VERSION="0.1.0"
INSTALL_DIR="$HOME/.kathal"
DATA_DIR="$HOME/.kathal/data"
PORT=8080

echo ""
echo "  KATHAL OS Installer (macOS)"
echo "  ============================"
echo ""

# Detect architecture.
ARCH=$(uname -m)
case "$ARCH" in
  arm64) ARCH_NAME="arm64" ;;
  x86_64) ARCH_NAME="amd64" ;;
  *) echo "Unsupported architecture: $ARCH"; exit 1 ;;
esac

echo "[1/5] Checking dependencies..."

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

# Check Homebrew.
HAS_BREW=false
if command -v brew &>/dev/null; then
    HAS_BREW=true
fi

echo "[2/5] Downloading KATHAL v$VERSION..."

mkdir -p "$INSTALL_DIR" "$DATA_DIR"

BINARY="$INSTALL_DIR/kathal"
DOWNLOAD_URL="https://github.com/Kathal-OS/kathal/releases/download/v$VERSION/kathal-$VERSION-darwin-$ARCH_NAME"

if curl -fsSL -o "$BINARY" "$DOWNLOAD_URL" 2>/dev/null; then
    chmod +x "$BINARY"
    echo "  Downloaded pre-built binary"
else
    echo "  Pre-built binary not available, building from source..."

    if ! command -v go &>/dev/null; then
        if [ "$HAS_BREW" = true ]; then
            echo "  Installing Go via Homebrew..."
            brew install go
        else
            echo "  Please install Go 1.22+ from https://go.dev/dl/"
            exit 1
        fi
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

echo "[3/5] Creating LaunchAgent..."

PLIST="$HOME/Library/LaunchAgents/com.kathal.dashboard.plist"

cat > "$PLIST" << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.kathal.dashboard</string>
    <key>ProgramArguments</key>
    <array>
        <string>$BINARY</string>
    </array>
    <key>WorkingDirectory</key>
    <string>$DATA_DIR</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>EnvironmentVariables</key>
    <dict>
        <key>KATHAL_HTTP_ADDR</key>
        <string>:$PORT</string>
        <key>KATHAL_DB_PATH</key>
        <string>$DATA_DIR/kathal.db</string>
    </dict>
    <key>StandardOutPath</key>
    <string>$HOME/.kathal/kathal.log</string>
    <key>StandardErrorPath</key>
    <string>$HOME/.kathal/kathal.error.log</string>
</dict>
</plist>
EOF

launchctl load "$PLIST"
echo "  LaunchAgent loaded"

echo "[4/5] Creating uninstall script..."

cat > "$INSTALL_DIR/uninstall.sh" << 'EOF'
#!/bin/bash
# KATHAL OS — macOS Uninstaller
echo "Stopping KATHAL..."
launchctl unload ~/Library/LaunchAgents/com.kathal.dashboard.plist 2>/dev/null || true
echo "Removing files..."
rm -f ~/Library/LaunchAgents/com.kathal.dashboard.plist
rm -rf ~/.kathal
echo "KATHAL uninstalled."
EOF

chmod +x "$INSTALL_DIR/uninstall.sh"

echo "[5/5] Starting KATHAL..."

launchctl start com.kathal.dashboard

sleep 2

echo ""
echo "  KATHAL OS is running!"
echo ""
echo "  Dashboard: http://localhost:$PORT"
echo "  Login:     admin@kathal.local / kathal"
echo ""
echo "  Commands:"
echo "    Status:  launchctl list | grep kathal"
echo "    Stop:    launchctl stop com.kathal.dashboard"
echo "    Start:   launchctl start com.kathal.dashboard"
echo "    Logs:    tail -f ~/.kathal/kathal.log"
echo "    Uninstall: bash $INSTALL_DIR/uninstall.sh"
echo ""