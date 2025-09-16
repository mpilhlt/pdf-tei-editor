#!/bin/bash

# PDF TEI Editor Generic Container Deployment Script
# Usage: ./bin/deploy-container.sh --image <IMAGE> --fqdn <FQDN> [OPTIONS]

set -e

# Color codes for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Logging functions
log_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

log_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

log_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Default values
PORT=8001
CONTAINER_NAME=""
IMAGE=""
FQDN=""
DEPLOYMENT_TYPE="production"
NGINX_ENABLED=true
SSL_ENABLED=true
EMAIL=""
ADMIN_PASSWORD=""
DEMO_PASSWORD=""
LOGIN_MESSAGE=""
GEMINI_API_KEY=""
GROBID_SERVER_URL=""
DATA_DIR=""
CONFIG_DIR=""
DB_DIR=""

# Container command detection
detect_container_cmd() {
    if command -v podman &> /dev/null; then
        echo "podman"
    elif command -v docker &> /dev/null; then
        echo "docker"
    else
        log_error "Neither podman nor docker found"
        exit 1
    fi
}

CONTAINER_CMD=$(detect_container_cmd)

# Usage information
usage() {
    cat << EOF
PDF TEI Editor Generic Container Deployment Script

USAGE:
    $0 --image <IMAGE> --fqdn <FQDN> [OPTIONS]

REQUIRED:
    --image <IMAGE>         Container image to deploy (local or registry)
    --fqdn <FQDN>          Fully qualified domain name

OPTIONS:
    --port <PORT>          Port to bind to (default: 8001)
    --name <NAME>          Container name (default: pdf-tei-editor-<FQDN>)
    --type <TYPE>          Deployment type: production|demo (default: production)
    --no-nginx             Skip nginx configuration
    --no-ssl               Skip SSL certificate setup
    --email <EMAIL>        Email for SSL certificate (default: admin@<FQDN>)
    --admin-password <PWD> Admin user password
    --demo-password <PWD>  Demo user password
    --login-message <MSG>  Custom login message (HTML)
    --gemini-key <KEY>     Gemini API key
    --grobid-url <URL>     Grobid server URL
    --data-dir <DIR>       External data directory (production only)
    --config-dir <DIR>     External config directory (production only)
    --db-dir <DIR>         External database directory (production only)
    --help                 Show this help message

EXAMPLES:
    # Production deployment with external volumes
    $0 --image cboulanger/pdf-tei-editor:latest \\
       --fqdn editor.company.com \\
       --admin-password secure123 \\
       --data-dir /opt/pdf-data \\
       --config-dir /opt/pdf-config \\
       --db-dir /opt/pdf-db

    # Demo deployment (no external volumes)
    $0 --image pdf-tei-editor:latest \\
       --fqdn demo.example.com \\
       --type demo \\
       --admin-password demo123

    # Local image without SSL
    $0 --image pdf-tei-editor:dev \\
       --fqdn local.test \\
       --no-ssl \\
       --port 8080
EOF
}

# Parse command line arguments
parse_args() {
    while [[ $# -gt 0 ]]; do
        case $1 in
            --image)
                IMAGE="$2"
                shift 2
                ;;
            --fqdn)
                FQDN="$2"
                shift 2
                ;;
            --port)
                PORT="$2"
                shift 2
                ;;
            --name)
                CONTAINER_NAME="$2"
                shift 2
                ;;
            --type)
                DEPLOYMENT_TYPE="$2"
                shift 2
                ;;
            --no-nginx)
                NGINX_ENABLED=false
                shift
                ;;
            --no-ssl)
                SSL_ENABLED=false
                shift
                ;;
            --email)
                EMAIL="$2"
                shift 2
                ;;
            --admin-password)
                ADMIN_PASSWORD="$2"
                shift 2
                ;;
            --demo-password)
                DEMO_PASSWORD="$2"
                shift 2
                ;;
            --login-message)
                LOGIN_MESSAGE="$2"
                shift 2
                ;;
            --gemini-key)
                GEMINI_API_KEY="$2"
                shift 2
                ;;
            --grobid-url)
                GROBID_SERVER_URL="$2"
                shift 2
                ;;
            --data-dir)
                DATA_DIR="$2"
                shift 2
                ;;
            --config-dir)
                CONFIG_DIR="$2"
                shift 2
                ;;
            --db-dir)
                DB_DIR="$2"
                shift 2
                ;;
            --help)
                usage
                exit 0
                ;;
            *)
                log_error "Unknown option: $1"
                usage
                exit 1
                ;;
        esac
    done
}

# Validate required arguments
validate_args() {
    if [ -z "$IMAGE" ]; then
        log_error "Image is required. Use --image <IMAGE>"
        exit 1
    fi

    if [ -z "$FQDN" ]; then
        log_error "FQDN is required. Use --fqdn <FQDN>"
        exit 1
    fi

    # Set defaults
    if [ -z "$CONTAINER_NAME" ]; then
        CONTAINER_NAME="pdf-tei-editor-$(echo $FQDN | sed 's/\./-/g')"
    fi

    if [ -z "$EMAIL" ]; then
        EMAIL="admin@$FQDN"
    fi

    # Validate deployment type
    if [[ "$DEPLOYMENT_TYPE" != "production" && "$DEPLOYMENT_TYPE" != "demo" ]]; then
        log_error "Invalid deployment type. Must be 'production' or 'demo'"
        exit 1
    fi

    # For demo deployments, warn about external directories
    if [ "$DEPLOYMENT_TYPE" = "demo" ]; then
        if [ -n "$DATA_DIR" ] || [ -n "$CONFIG_DIR" ] || [ -n "$DB_DIR" ]; then
            log_warning "Demo deployment: ignoring external directories (data will not persist)"
            DATA_DIR=""
            CONFIG_DIR=""
            DB_DIR=""
        fi
    fi
}

# Check if image exists
check_image() {
    log_info "Checking if image exists: $IMAGE"

    if $CONTAINER_CMD image inspect "$IMAGE" &> /dev/null; then
        log_success "Image found: $IMAGE"
    else
        log_error "Image not found: $IMAGE"
        log_info "Available images:"
        $CONTAINER_CMD images
        exit 1
    fi
}

# Stop and remove existing container
stop_existing_container() {
    if $CONTAINER_CMD ps -a --format "{{.Names}}" | grep -q "^${CONTAINER_NAME}$"; then
        log_info "Stopping existing container: $CONTAINER_NAME"
        $CONTAINER_CMD stop "$CONTAINER_NAME" || true
        $CONTAINER_CMD rm "$CONTAINER_NAME" || true
    fi
}

# Deploy container
deploy_container() {
    log_info "Deploying container: $CONTAINER_NAME"

    # Build container run command
    local cmd_args=(
        "run" "-d"
        "--name" "$CONTAINER_NAME"
        "--restart" "unless-stopped"
        "-p" "$PORT:8000"
        "-e" "PORT=8000"
    )

    # Add environment variables
    if [ -n "$ADMIN_PASSWORD" ]; then
        cmd_args+=("-e" "APP_ADMIN_PASSWORD=$ADMIN_PASSWORD")
    fi

    if [ -n "$DEMO_PASSWORD" ]; then
        cmd_args+=("-e" "APP_DEMO_PASSWORD=$DEMO_PASSWORD")
    fi

    if [ -n "$LOGIN_MESSAGE" ]; then
        cmd_args+=("-e" "APP_LOGIN_MESSAGE=$LOGIN_MESSAGE")
    fi

    if [ -n "$GEMINI_API_KEY" ]; then
        cmd_args+=("-e" "GEMINI_API_KEY=$GEMINI_API_KEY")
    fi

    if [ -n "$GROBID_SERVER_URL" ]; then
        cmd_args+=("-e" "GROBID_SERVER_URL=$GROBID_SERVER_URL")
    fi

    # Add volume mounts for production
    if [ "$DEPLOYMENT_TYPE" = "production" ]; then
        if [ -n "$DATA_DIR" ]; then
            mkdir -p "$DATA_DIR"
            cmd_args+=("-v" "$DATA_DIR:/app/data")
            log_info "Mounted data directory: $DATA_DIR"
        fi

        if [ -n "$CONFIG_DIR" ]; then
            mkdir -p "$CONFIG_DIR"
            cmd_args+=("-v" "$CONFIG_DIR:/app/config")
            log_info "Mounted config directory: $CONFIG_DIR"
        fi

        if [ -n "$DB_DIR" ]; then
            mkdir -p "$DB_DIR"
            cmd_args+=("-v" "$DB_DIR:/app/db")
            log_info "Mounted database directory: $DB_DIR"
        fi
    else
        log_info "Demo deployment: using container-internal storage (non-persistent)"
    fi

    # Add image name
    cmd_args+=("$IMAGE")

    # Run container
    $CONTAINER_CMD "${cmd_args[@]}"

    log_success "Container deployed successfully"
}

# Wait for container to be ready
wait_for_container() {
    log_info "Waiting for container to be ready..."

    local max_attempts=30
    local attempt=1

    while [ $attempt -le $max_attempts ]; do
        if curl -s "http://localhost:$PORT" > /dev/null 2>&1; then
            log_success "Container is ready"
            return 0
        fi

        log_info "Attempt $attempt/$max_attempts - waiting for container..."
        sleep 2
        ((attempt++))
    done

    log_warning "Container may not be fully ready yet, but continuing..."
}

# Setup nginx configuration
setup_nginx() {
    if [ "$NGINX_ENABLED" = false ]; then
        log_info "Nginx setup skipped"
        return 0
    fi

    log_info "Setting up nginx configuration..."

    local nginx_config="/etc/nginx/sites-available/pdf-tei-editor-$FQDN"

    cat > "$nginx_config" << EOF
# PDF TEI Editor configuration for $FQDN ($DEPLOYMENT_TYPE)
server {
    server_name $FQDN;

    location / {
        proxy_pass http://127.0.0.1:$PORT;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header X-Forwarded-Host \$host;
        proxy_redirect off;
    }

    # Special handling for Server-Sent Events
    location /sse/ {
        proxy_pass http://127.0.0.1:$PORT;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header X-Forwarded-Host \$host;
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 300;
        proxy_connect_timeout 75;
    }

    listen 80;
}
EOF

    # Enable the site
    ln -sf "$nginx_config" "/etc/nginx/sites-enabled/"

    # Test and reload nginx
    if nginx -t; then
        systemctl reload nginx || systemctl restart nginx
        log_success "Nginx configured and reloaded"
    else
        log_error "Nginx configuration test failed"
        return 1
    fi
}

# Setup SSL certificate
setup_ssl() {
    if [ "$SSL_ENABLED" = false ]; then
        log_info "SSL setup skipped"
        return 0
    fi

    log_info "Setting up SSL certificate with Let's Encrypt..."

    if certbot --nginx -d "$FQDN" --non-interactive --agree-tos --email "$EMAIL"; then
        log_success "SSL certificate configured successfully"
    else
        log_error "SSL setup failed"
        return 1
    fi
}

# Main function
main() {
    log_info "PDF TEI Editor Container Deployment"
    log_info "===================================="
    echo

    # Parse arguments
    parse_args "$@"
    validate_args

    # Check if running with appropriate permissions for nginx/ssl
    if [ "$NGINX_ENABLED" = true ] || [ "$SSL_ENABLED" = true ]; then
        if [ "$EUID" -ne 0 ]; then
            log_error "This script needs to be run with sudo for nginx/SSL configuration"
            log_info "Usage: sudo $0 [options]"
            exit 1
        fi
    fi

    # Display configuration
    log_info "Configuration:"
    log_info "  Image: $IMAGE"
    log_info "  FQDN: $FQDN"
    log_info "  Port: $PORT"
    log_info "  Container: $CONTAINER_NAME"
    log_info "  Type: $DEPLOYMENT_TYPE"
    log_info "  Nginx: $NGINX_ENABLED"
    log_info "  SSL: $SSL_ENABLED"

    if [ "$DEPLOYMENT_TYPE" = "production" ]; then
        log_info "  Data directory: ${DATA_DIR:-'(container internal)'}"
        log_info "  Config directory: ${CONFIG_DIR:-'(container internal)'}"
        log_info "  Database directory: ${DB_DIR:-'(container internal)'}"
    fi
    echo

    # Execute deployment
    check_image
    stop_existing_container
    deploy_container
    wait_for_container

    if [ "$NGINX_ENABLED" = true ]; then
        setup_nginx
    fi

    if [ "$SSL_ENABLED" = true ]; then
        setup_ssl
    fi

    # Final status
    echo
    log_success "Deployment completed successfully!"

    local url_scheme="http"
    if [ "$SSL_ENABLED" = true ]; then
        url_scheme="https"
    fi

    log_info "📍 Application URL: $url_scheme://$FQDN"
    log_info "🐳 Container: $CONTAINER_NAME"
    log_info "📊 Monitor logs: $CONTAINER_CMD logs -f $CONTAINER_NAME"
    log_info "🛑 Stop container: $CONTAINER_CMD stop $CONTAINER_NAME"

    if [ "$DEPLOYMENT_TYPE" = "demo" ]; then
        log_info "🔄 Note: Demo deployment - data will not persist across container restarts"
    fi
}

# Run main function
main "$@"