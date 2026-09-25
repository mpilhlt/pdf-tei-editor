#!/bin/bash

# Setup cron job for nightly demo reset
# Usage: ./bin/setup-cron.sh --image <IMAGE> --fqdn <FQDN> [OPTIONS]
# Example: ./bin/setup-cron.sh --image cboulanger/pdf-tei-editor:latest --fqdn demo.example.com

set -e

# Default values
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_SCRIPT="$SCRIPT_DIR/deploy-container.sh"
IMAGE=""
FQDN=""
DEPLOY_ARGS=()
CRON_TIME=""

# Usage information
usage() {
    cat << EOF
Setup Cron Job for Nightly Demo Reset

USAGE:
    $0 --image <IMAGE> --fqdn <FQDN> [OPTIONS]

REQUIRED:
    --image <IMAGE>        Container image to use for reset
    --fqdn <FQDN>         Fully qualified domain name of demo

OPTIONS:
    --port <PORT>         Port number (default: 8001)
    --time <TIME>         Cron time specification (default: "0 2 * * *" for 2 AM)
    --admin-password <PWD> Admin password (default: demo123)
    --demo-password <PWD>  Demo password (default: demo123)
    --help                Show this help message

EXAMPLES:
    # Setup nightly reset at 2 AM with default demo passwords
    $0 --image cboulanger/pdf-tei-editor:latest --fqdn demo.example.com

    # Custom time and passwords
    $0 --image pdf-tei-editor:latest --fqdn demo.example.com --time "0 3 * * *" --admin-password mypassword

NOTE:
    This creates a cron job that redeploys the demo container nightly using deploy-container.sh.
    Demo deployments use container-internal storage (non-persistent).
EOF
}

# Parse command line arguments
parse_args() {
    while [[ $# -gt 0 ]]; do
        case $1 in
            --image)
                IMAGE="$2"
                DEPLOY_ARGS+=("--image" "$2")
                shift 2
                ;;
            --fqdn)
                FQDN="$2"
                DEPLOY_ARGS+=("--fqdn" "$2")
                shift 2
                ;;
            --port)
                DEPLOY_ARGS+=("--port" "$2")
                shift 2
                ;;
            --admin-password)
                DEPLOY_ARGS+=("--admin-password" "$2")
                shift 2
                ;;
            --demo-password)
                DEPLOY_ARGS+=("--demo-password" "$2")
                shift 2
                ;;
            --time)
                CRON_TIME="$2"
                shift 2
                ;;
            --help)
                usage
                exit 0
                ;;
            *)
                echo "Unknown option: $1"
                usage
                exit 1
                ;;
        esac
    done
}

# Validate arguments
validate_args() {
    if [ -z "$IMAGE" ]; then
        echo "Error: Image is required. Use --image <IMAGE>"
        exit 1
    fi

    if [ -z "$FQDN" ]; then
        echo "Error: FQDN is required. Use --fqdn <FQDN>"
        exit 1
    fi

    if [ -z "$CRON_TIME" ]; then
        CRON_TIME="0 2 * * *"  # Default: 2 AM daily
    fi
}

# Check dependencies
check_dependencies() {
    if [ ! -f "$DEPLOY_SCRIPT" ]; then
        echo "Error: Deploy script not found: $DEPLOY_SCRIPT"
        exit 1
    fi

    if [ ! -x "$DEPLOY_SCRIPT" ]; then
        echo "Error: Deploy script is not executable: $DEPLOY_SCRIPT"
        exit 1
    fi
}

# Main function
main() {
    echo "PDF TEI Editor - Setup Nightly Demo Reset"
    echo "========================================"

    # Parse and validate arguments
    parse_args "$@"
    validate_args
    check_dependencies

    echo "Configuration:"
    echo "  Image: $IMAGE"
    echo "  FQDN: $FQDN"
    echo "  Schedule: $CRON_TIME"
    echo ""

    # Create log file
    echo "Setting up log file..."
    sudo mkdir -p /var/log
    sudo touch /var/log/pdf-tei-editor-reset.log
    sudo chmod 644 /var/log/pdf-tei-editor-reset.log

    # Add default demo settings if not specified
    local final_args=("${DEPLOY_ARGS[@]}")

    # Add demo type and default passwords if not specified
    local has_type=false
    local has_admin_pwd=false
    local has_demo_pwd=false

    for arg in "${DEPLOY_ARGS[@]}"; do
        case $arg in
            --type) has_type=true ;;
            --admin-password) has_admin_pwd=true ;;
            --demo-password) has_demo_pwd=true ;;
        esac
    done

    if [ "$has_type" = false ]; then
        final_args+=("--type" "demo")
    fi

    if [ "$has_admin_pwd" = false ]; then
        final_args+=("--admin-password" "demo123")
    fi

    if [ "$has_demo_pwd" = false ]; then
        final_args+=("--demo-password" "demo123")
    fi

    # Build cron command
    local cron_cmd="$CRON_TIME $DEPLOY_SCRIPT ${final_args[*]} >> /var/log/pdf-tei-editor-reset.log 2>&1"

    echo "Setting up cron job..."

    # Remove existing cron jobs for this demo
    if crontab -l 2>/dev/null | grep -q "deploy-container.sh.*--fqdn $FQDN"; then
        echo "Removing existing cron job for $FQDN..."
        (crontab -l 2>/dev/null | grep -v "deploy-container.sh.*--fqdn $FQDN") | crontab -
    fi

    # Add new cron job
    echo "Adding new cron job..."
    (crontab -l 2>/dev/null; echo "$cron_cmd") | crontab -

    echo ""
    echo "✅ Cron job setup completed successfully!"
    echo ""
    echo "The demo '$FQDN' will reset automatically using schedule: $CRON_TIME"
    echo ""
    echo "Management commands:"
    echo "  View current cron jobs: crontab -l"
    echo "  View reset logs: tail -f /var/log/pdf-tei-editor-reset.log"
    echo "  Remove cron job: crontab -l | grep -v 'deploy-container.sh.*--fqdn $FQDN' | crontab -"
    echo "  Manual reset: $DEPLOY_SCRIPT ${final_args[*]}"
}

# Run main function
main "$@"