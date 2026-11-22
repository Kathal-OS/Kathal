#!/usr/bin/env bash
set -euo pipefail

# KATHAL OS — Self-Hosted macOS Installer (No Docker, No Cloud Required)

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${PORT:-3000}"
DATA_DIR="${KATHAL_DATA_DIR:-$ROOT_DIR/data}"
APPS_DIR="${KATHAL_APPS_DIR:-$DATA_DIR/apps}"

echo "=== KATHAL OS Self-Hosted macOS Installer ==="
echo "Install root : $ROOT_DIR"
echo "Data dir     : $DATA_DIR"
echo "Apps dir     : $APPS_DIR"

if ! command -v node >/dev/null 2>&1; then
  if command -v brew >/dev/null 2>&1; then
    echo "Installing Node.js 22 via Homebrew..."
    brew install node@22 python git
  else
    echo "Error: Node.js 20+ is required. Install via Homebrew (brew install node) or https://nodejs.org/" >&2
    exit 1
  fi
fi

NODE_MAJOR="$(node -p "parseInt(process.versions.node.split('.')[0], 10)")"
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "Error: Node.js 20+ required (detected $(node -v))." >&2
  exit 1
fi

mkdir -p "$DATA_DIR" "$APPS_DIR"
cd "$ROOT_DIR"

echo "[1/3] Installing npm dependencies locally..."
npm install

echo "[2/3] Building frontend & verifying TypeScript..."
npm run build

PLIST_PATH="$HOME/Library/LaunchAgents/com.kathal.dashboard.plist"
if [ "${KATHAL_INSTALL_LAUNCHD:-0}" = "1" ]; then
  mkdir -p "$HOME/Library/LaunchAgents"
  cat > "$PLIST_PATH" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.kathal.dashboard</string>
  <key>WorkingDirectory</key><string>$ROOT_DIR</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(command -v node)</string>
    <string>$ROOT_DIR/node_modules/tsx/dist/cli.mjs</string>
    <string>$ROOT_DIR/server.ts</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PORT</key><string>$PORT</string>
    <key>NODE_ENV</key><string>production</string>
    <key>KATHAL_DATA_DIR</key><string>$DATA_DIR</string>
    <key>KATHAL_APPS_DIR</key><string>$APPS_DIR</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict>
</plist>
EOF
  launchctl unload "$PLIST_PATH" >/dev/null 2>&1 || true
  launchctl load "$PLIST_PATH"
  echo "launchd LaunchAgent installed and started: $PLIST_PATH"
fi

echo "[3/3] Setup complete!"
echo ""
echo "Start KATHAL OS locally:"
echo "  npm run dev"
echo "Or launch native macOS desktop app:"
echo "  npm run desktop"
echo "Or enable launchd background auto-start:"
echo "  KATHAL_INSTALL_LAUNCHD=1 bash scripts/install-mac.sh"
