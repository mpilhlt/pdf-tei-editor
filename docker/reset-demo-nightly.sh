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
DATA_DIR="/opt/pdf-tei-editor-data/$FQDN"

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

# Reset only file data (preserve user data and configuration)
log "Resetting demo file data..."
if [ -d "$DATA_DIR" ]; then
    # Clean only the data directory (uploaded files, processed files, etc.)
    if [ -d "$DATA_DIR/data" ]; then
        rm -rf "$DATA_DIR/data"/*
        log "Cleaned file data directory: $DATA_DIR/data"
        
        # Restore sample data from repository
        if [ -d "data" ]; then
            cp -r data/* "$DATA_DIR/data/" 2>/dev/null || true
            log "Restored sample data from repository"
        fi
    fi
    
    # Keep user database and configuration intact - users and settings persist
    log "Preserved user data and configuration"
else
    log "Data directory not found: $DATA_DIR"
fi

# Restart the application with existing configuration
log "Starting updated application..."
./bin/start-docker-image.sh "$FQDN" "$PORT"

# Clean up old images to save disk space
log "Cleaning up old Docker images..."
podman image prune -f

log "Nightly reset completed successfully"