#!/bin/bash

# Nightly demo reset script for PDF TEI Editor
# This script pulls the latest code from GitHub and restarts the demo
# Add to crontab: 0 2 * * * /path/to/pdf-tei-editor/docker/reset-demo-nightly.sh demo.example.com 8001 >> /var/log/pdf-tei-editor-reset.log 2>&1

set -e

# Configuration
FQDN=${1:-"demo.pdf-tei-editor.example.com"}
PORT=${2:-8001}
REPO_DIR="/opt/pdf-tei-editor"
CONTAINER_NAME="pdf-tei-editor-demo"
LOG_FILE="/var/log/pdf-tei-editor-reset.log"

# Logging function
log() {
    echo "$(date '+%Y-%m-%d %H:%M:%S') $1" | tee -a "$LOG_FILE"
}

log "Starting nightly reset for PDF TEI Editor demo ($FQDN:$PORT)"

# Change to repository directory
cd "$REPO_DIR"

# Stop existing container
log "Stopping existing container..."
podman stop "$CONTAINER_NAME" 2>/dev/null || true
podman rm "$CONTAINER_NAME" 2>/dev/null || true

# Pull latest changes from GitHub
log "Pulling latest changes from GitHub..."
git fetch origin
git reset --hard origin/main
git clean -fd

# Restart the application
log "Starting updated application..."
./bin/start-docker-image.sh "$FQDN" "$PORT"

# Clean up old images to save disk space
log "Cleaning up old Docker images..."
podman image prune -f

log "Nightly reset completed successfully"