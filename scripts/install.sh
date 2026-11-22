#!/usr/bin/env bash
set -euo pipefail

# KATHAL OS — Self-Hosted Linux Installer (No Docker, No Cloud Required)

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${PORT:-3000}"
DATA_DIR="${KATHAL_DATA_DIR:-$ROOT_DIR/data}"
APPS_DIR="${KATHAL_APPS_DIR:-$DATA_DIR/apps}"

echo "=== KATHAL OS Self-Hosted Linux Installer ==="
echo "Install root : $ROOT_DIR"
echo "Data dir     : $DATA_DIR"
echo "Apps dir     : $APPS_DIR"

if ! command -v node >/dev/null 2>&1; then
  echo "Error: Node.js 20+ is required. Install Node.js from your distribution or https://nodejs.org/" >&2
  exit 1
fi

NODE_MAJOR="$(node -p "parseInt(process.versions.node.split('.')[0], 10)")"
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "Error: Node.js 20+ required (detected v$(node -v))." >&2
  exit 1
fi

mkdir -p "$DATA_DIR" "$APPS_DIR"
cd "$ROOT_DIR"

echo "[1/3] Installing npm dependencies locally..."
npm install

echo "[2/3] Building frontend & checking TypeScript types..."
npm run build

echo "[3/3] Setup complete!"
echo ""
echo "Start KATHAL OS locally (zero Docker / zero cloud):"
echo "  PORT=$PORT KATHAL_DATA_DIR=\"$DATA_DIR\" npm run dev"
echo ""
echo "Or launch the desktop window:"
echo "  npm run desktop"
echo ""
echo "Optional systemd service (run as root/sudo):"
echo "  cat <<EOF | sudo tee /etc/systemd/system/kathal.service"
echo "  [Unit]"
echo "  Description=KATHAL OS Self-Hosted Control Panel"
echo "  After=network.target"
echo ""
echo "  [Service]"
echo "  Type=simple"
echo "  WorkingDirectory=$ROOT_DIR"
echo "  Environment=PORT=$PORT"
echo "  Environment=NODE_ENV=production"
echo "  Environment=KATHAL_DATA_DIR=$DATA_DIR"
echo "  Environment=KATHAL_APPS_DIR=$APPS_DIR"
echo "  ExecStart=$(command -v npx) tsx server.ts"
echo "  Restart=on-failure"
echo ""
echo "  [Install]"
echo "  WantedBy=multi-user.target"
echo "  EOF"
echo "  sudo systemctl enable --now kathal"
