#!/bin/bash

# Install a systemd service that runs PDF-TEI-Editor from this git checkout (non-container deployment).
# Run as the user that owns the checkout, not with sudo: the script resolves node/npm and uv from the
# current PATH (e.g. an nvm installation) and writes it into the unit, which does not inherit any login
# shell PATH. Re-run it after switching to another node version with nvm.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
SERVICE_NAME="pdf-tei-editor"
START_SCRIPT="start-dev"
DRY_RUN=false

usage() {
    cat << EOF
Install a systemd service for a git checkout deployment of PDF-TEI-Editor

USAGE:
    $0 [OPTIONS]

OPTIONS:
    --name <NAME>          Service name (default: $SERVICE_NAME)
    --start <SCRIPT>       Start script in bin/: start-dev or start-prod (default: $START_SCRIPT)
    --dry-run              Print the unit file without installing it
    --help                 Show this help message

The unit runs bin/<SCRIPT> in $PROJECT_ROOT as user $(id -un).
Host and port are read from the .env file in the project root (HOST, PORT).
EOF
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --name) SERVICE_NAME="$2"; shift 2 ;;
        --start) START_SCRIPT="$2"; shift 2 ;;
        --dry-run) DRY_RUN=true; shift ;;
        --help|-h) usage; exit 0 ;;
        *) echo "[ERROR] Unknown option: $1" >&2; usage >&2; exit 1 ;;
    esac
done

if [[ $EUID -eq 0 ]]; then
    echo "[ERROR] Run this script as the user that owns the checkout, not as root. It calls sudo itself." >&2
    exit 1
fi

if [[ ! -x "$PROJECT_ROOT/bin/$START_SCRIPT" ]]; then
    echo "[ERROR] Start script not found or not executable: $PROJECT_ROOT/bin/$START_SCRIPT" >&2
    exit 1
fi

# Directories of the tools the start scripts need. They are written into the unit's PATH because
# systemd does not load nvm or the user's shell profile.
service_path=("$HOME/.local/bin" "$PROJECT_ROOT/.venv/bin")
for tool in node npm uv; do
    tool_path="$(command -v "$tool" || true)"
    if [[ -z "$tool_path" ]]; then
        echo "[ERROR] '$tool' was not found on the PATH. Install it (or activate it, e.g. with 'nvm use') and try again." >&2
        exit 1
    fi
    service_path+=("$(dirname "$tool_path")")
done
service_path+=(/usr/local/bin /usr/bin /bin)

# Remove duplicates while keeping the order
unit_path=""
for dir in "${service_path[@]}"; do
    case ":$unit_path:" in
        *":$dir:"*) ;;
        *) unit_path="${unit_path:+$unit_path:}$dir" ;;
    esac
done

unit_file="/etc/systemd/system/$SERVICE_NAME.service"
unit_content="[Unit]
Description=PDF TEI Editor
After=network.target

[Service]
Type=simple
User=$(id -un)
WorkingDirectory=$PROJECT_ROOT
Environment=PATH=$unit_path
ExecStart=$PROJECT_ROOT/bin/$START_SCRIPT
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target"

if $DRY_RUN; then
    echo "# $unit_file"
    echo "$unit_content"
    exit 0
fi

echo "[INFO] Writing $unit_file"
echo "$unit_content" | sudo tee "$unit_file" > /dev/null
sudo systemctl daemon-reload
sudo systemctl enable "$SERVICE_NAME"
echo "[INFO] Installed and enabled $SERVICE_NAME. Start it with: sudo systemctl restart $SERVICE_NAME"
