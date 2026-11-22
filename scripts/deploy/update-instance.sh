#!/bin/bash

# Update a git checkout deployment of PDF-TEI-Editor that runs as a systemd service
# (see install-systemd-service.sh): pull the latest code, install dependencies, build,
# restart the service and wait until the server responds again.
# Logged-in users see a maintenance message during the update (requires API_TOKEN in .env).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
SERVICE_NAME="pdf-tei-editor"
PORT=""
TIMEOUT=120

usage() {
    cat << EOF
Update a git checkout deployment of PDF-TEI-Editor

USAGE:
    $0 [OPTIONS]

OPTIONS:
    --name <NAME>          systemd service name (default: $SERVICE_NAME)
    --port <PORT>          Port of the server (default: PORT from .env, or 8000)
    --timeout <SECONDS>    How long to wait for the server to come back (default: $TIMEOUT)
    --help                 Show this help message
EOF
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --name) SERVICE_NAME="$2"; shift 2 ;;
        --port) PORT="$2"; shift 2 ;;
        --timeout) TIMEOUT="$2"; shift 2 ;;
        --help|-h) usage; exit 0 ;;
        *) echo "[ERROR] Unknown option: $1" >&2; usage >&2; exit 1 ;;
    esac
done

cd "$PROJECT_ROOT"

if [[ -z "$PORT" ]]; then
    PORT="$(grep -E '^PORT=' .env 2>/dev/null | tail -n 1 | cut -d= -f2 | tr -d '"'"'"' ' || true)"
    PORT="${PORT:-8000}"
fi

maintenance_on=false
on_exit() {
    local status=$?
    if [[ $status -ne 0 ]]; then
        echo "[ERROR] Update failed (exit code $status)." >&2
        echo "[ERROR] Service log: sudo journalctl -u $SERVICE_NAME -n 50 --no-pager" >&2
        if $maintenance_on; then
            echo "[ERROR] Maintenance mode is still on. Once the server is running, end it with: npm run manage-remote -- maintenance off" >&2
        fi
    fi
}
trap on_exit EXIT

# Show the maintenance message. Not fatal: the server may already be down.
if npm run --silent manage-remote -- maintenance on; then
    maintenance_on=true
else
    echo "[WARN] Could not switch on maintenance mode, continuing" >&2
fi

# Update the source code and dependencies
git stash
git pull --ff-only
uv sync
npm install --no-audit --no-fund
npm run build

# Restart the server and wait until it responds
sudo systemctl reset-failed "$SERVICE_NAME" 2>/dev/null || true
sudo systemctl restart "$SERVICE_NAME"
echo "[INFO] Waiting up to ${TIMEOUT}s for the server on port $PORT..."
deadline=$((SECONDS + TIMEOUT))
until curl -fsS -o /dev/null "http://localhost:$PORT/health"; do
    if (( SECONDS >= deadline )) || systemctl is-failed --quiet "$SERVICE_NAME"; then
        echo "[ERROR] The server did not come back. Last log lines:" >&2
        sudo journalctl -u "$SERVICE_NAME" -n 20 --no-pager >&2
        exit 1
    fi
    sleep 2
done

# Reload the frontend of logged-in users and end maintenance mode
if $maintenance_on; then
    npm run --silent manage-remote -- maintenance reload
    sleep 10
    VERSION=$(node -p "require('./package.json').version")
    npm run --silent manage-remote -- maintenance off --message "The application has been updated to version $VERSION"
fi
echo "[INFO] Update complete"
