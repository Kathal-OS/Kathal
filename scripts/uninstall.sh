#!/bin/bash
# KATHAL OS — Linux Uninstaller
# Removes KATHAL dashboard and all associated files.
#
# Usage: sudo bash uninstall.sh

set -e

echo ""
echo "  KATHAL OS Uninstaller"
echo "  ======================="
echo ""

# Stop and disable service.
if systemctl is-active --quiet kathal 2>/dev/null; then
    echo "Stopping KATHAL service..."
    systemctl stop kathal
fi

if systemctl is-enabled --quiet kathal 2>/dev/null; then
    echo "Disabling KATHAL service..."
    systemctl disable kathal
fi

# Remove service file.
if [ -f /etc/systemd/system/kathal.service ]; then
    echo "Removing systemd service..."
    rm -f /etc/systemd/system/kathal.service
    systemctl daemon-reload
fi

# Remove binaries.
if [ -f /opt/kathal/kathal ]; then
    echo "Removing binary..."
    rm -f /opt/kathal/kathal
fi

# Remove data (ask first).
if [ -d /var/lib/kathal ]; then
    read -p "  Remove database and data files? [y/N] " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        rm -rf /var/lib/kathal
        echo "  Data removed"
    else
        echo "  Data kept at /var/lib/kathal"
    fi
fi

# Remove install dir.
if [ -d /opt/kathal ]; then
    rm -rf /opt/kathal
fi

echo ""
echo "  KATHAL OS uninstalled."
echo ""