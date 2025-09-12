#!/bin/bash

# Interactive PDF TEI Editor Demo Setup Script
# This script sets up a complete demo deployment with nginx, SSL, and production configuration

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

# Check if running as root for system operations
check_root() {
    if [ "$EUID" -ne 0 ]; then
        log_error "This script needs to be run with sudo for system configuration"
        log_info "Usage: sudo $0"
        exit 1
    fi
}

# Validate FQDN format
validate_fqdn() {
    local fqdn=$1
    if [[ ! $fqdn =~ ^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$ ]]; then
        return 1
    fi
    return 0
}

# Validate port number
validate_port() {
    local port=$1
    if [[ ! $port =~ ^[0-9]+$ ]] || [ "$port" -lt 1024 ] || [ "$port" -gt 65535 ]; then
        return 1
    fi
    return 0
}

# Interactive input with validation
get_fqdn() {
    while true; do
        read -p "Enter FQDN for the demo (e.g., demo.pdf-tei-editor.example.com): " FQDN
        if validate_fqdn "$FQDN"; then
            break
        else
            log_error "Invalid FQDN format. Please try again."
        fi
    done
}

get_port() {
    while true; do
        read -p "Enter port for the application [8001]: " PORT
        PORT=${PORT:-8001}
        if validate_port "$PORT"; then
            break
        else
            log_error "Invalid port. Please enter a number between 1024-65535."
        fi
    done
}

get_admin_password() {
    while true; do
        read -s -p "Enter admin password (minimum 8 characters): " ADMIN_PASSWORD
        echo
        if [ ${#ADMIN_PASSWORD} -ge 8 ]; then
            read -s -p "Confirm admin password: " ADMIN_PASSWORD_CONFIRM
            echo
            if [ "$ADMIN_PASSWORD" = "$ADMIN_PASSWORD_CONFIRM" ]; then
                break
            else
                log_error "Passwords do not match. Please try again."
            fi
        else
            log_error "Password must be at least 8 characters long."
        fi
    done
}

get_demo_user() {
    echo
    read -p "Create demo user? (y/N): " CREATE_DEMO_USER
    if [[ $CREATE_DEMO_USER =~ ^[Yy]$ ]]; then
        read -p "Demo username [demo]: " DEMO_USERNAME
        DEMO_USERNAME=${DEMO_USERNAME:-"demo"}
        
        while true; do
            read -s -p "Enter demo user password (minimum 8 characters): " DEMO_PASSWORD
            echo
            if [ ${#DEMO_PASSWORD} -ge 8 ]; then
                read -s -p "Confirm demo user password: " DEMO_PASSWORD_CONFIRM
                echo
                if [ "$DEMO_PASSWORD" = "$DEMO_PASSWORD_CONFIRM" ]; then
                    break
                else
                    log_error "Passwords do not match. Please try again."
                fi
            else
                log_error "Password must be at least 8 characters long."
            fi
        done
        
        read -p "Demo user full name [Demo User]: " DEMO_FULLNAME
        DEMO_FULLNAME=${DEMO_FULLNAME:-"Demo User"}
    fi
}

get_email() {
    read -p "Enter email for SSL certificate [admin@$FQDN]: " EMAIL
    EMAIL=${EMAIL:-"admin@$FQDN"}
}

get_api_keys() {
    echo
    log_info "API Configuration (optional - leave blank to skip)"
    read -p "Enter Gemini API key (for LLamore extraction) [optional]: " GEMINI_API_KEY
    read -p "Enter Grobid server URL [http://localhost:8070]: " GROBID_SERVER_URL
    GROBID_SERVER_URL=${GROBID_SERVER_URL:-"http://localhost:8070"}
}

# Check if required packages are installed
check_dependencies() {
    log_info "Checking system dependencies..."
    
    local missing_deps=()
    
    if ! command -v podman &> /dev/null && ! command -v docker &> /dev/null; then
        missing_deps+=("podman or docker")
    fi
    
    if ! command -v nginx &> /dev/null; then
        missing_deps+=("nginx")
    fi
    
    if ! command -v certbot &> /dev/null; then
        missing_deps+=("certbot")
    fi
    
    if [ ${#missing_deps[@]} -ne 0 ]; then
        log_error "Missing dependencies: ${missing_deps[*]}"
        log_info "Please install missing dependencies and run this script again."
        exit 1
    fi
    
    log_success "All dependencies are installed"
}

# Hash password using Python
hash_password() {
    local password=$1
    python3 -c "
import hashlib
import secrets
password = '$password'
salt = secrets.token_hex(32)
hashed = hashlib.pbkdf2_hmac('sha256', password.encode('utf-8'), salt.encode('utf-8'), 100000)
print(f'{salt}:{hashed.hex()}')
"
}

# Update application configuration
update_config() {
    local instance_dir="/opt/pdf-tei-editor-data/$FQDN"
    local config_dir="$instance_dir/config"
    local config_file="$config_dir/config.json"
    
    log_info "Setting up persistent configuration directory for $FQDN..."
    
    # Create persistent config directory
    mkdir -p "$config_dir"
    
    # Copy entire config directory if it doesn't exist or is incomplete
    if [ -d "config" ] && [ ! -f "$config_dir/users.json" -o ! -f "$config_dir/prompt.json" ]; then
        log_info "Copying complete configuration structure from repository..."
        cp -r config/* "$config_dir/"
        log_info "Copied configuration directory structure"
    elif [ ! -f "$config_file" ]; then
        # Create minimal config if repo config doesn't exist
        echo '{}' > "$config_file"
        log_info "Created minimal configuration file"
    fi
    
    # Create or update configuration
    python3 -c "
import json
import sys
import os

config_file = '$config_file'
try:
    config = {}
    if os.path.exists(config_file):
        with open(config_file, 'r') as f:
            config = json.load(f)
    
    # Set production mode
    if 'application' not in config:
        config['application'] = {}
    config['application']['mode'] = 'production'
    
    with open(config_file, 'w') as f:
        json.dump(config, f, indent=2)
    
    print('Configuration updated successfully')
except Exception as e:
    print(f'Error updating configuration: {e}', file=sys.stderr)
    sys.exit(1)
"
    
    log_success "Configuration updated in $config_file"
}

# Setup environment configuration
setup_env() {
    local instance_dir="/opt/pdf-tei-editor-data/$FQDN"
    local env_file="$instance_dir/.env"
    
    log_info "Setting up environment configuration..."
    
    # Create .env file
    cat > "$env_file" << EOF
# PDF TEI Editor Environment Configuration for $FQDN
# Generated on $(date)

EOF

    if [ -n "$GEMINI_API_KEY" ]; then
        echo "GEMINI_API_KEY=$GEMINI_API_KEY" >> "$env_file"
        log_info "Added Gemini API key to environment"
    fi
    
    if [ -n "$GROBID_SERVER_URL" ]; then
        echo "GROBID_SERVER_URL=$GROBID_SERVER_URL" >> "$env_file"
        log_info "Added Grobid server URL to environment"
    fi
    
    # Disable WebDAV for demo
    echo "WEBDAV_ENABLED=false" >> "$env_file"
    
    log_success "Environment configuration created at $env_file"
}

# Setup user accounts using manage.js
setup_users() {
    local instance_dir="/opt/pdf-tei-editor-data/$FQDN"
    local db_dir="$instance_dir/db"
    
    log_info "Setting up user accounts for $FQDN..."
    
    # Create persistent db directory
    mkdir -p "$db_dir"
    
    # Copy default user database if it doesn't exist
    if [ ! -f "$db_dir/users.json" ] && [ -f "db/users.json" ]; then
        cp "db/users.json" "$db_dir/"
        log_info "Copied default user database"
    fi
    
    # Wait a moment to ensure container is fully ready
    sleep 5
    
    # Remove default admin user and create new one with specified password
    log_info "Creating admin user..."
    podman exec pdf-tei-editor-demo .venv/bin/python bin/manage.py user remove admin 2>/dev/null || true
    podman exec pdf-tei-editor-demo .venv/bin/python bin/manage.py user add admin --password "$ADMIN_PASSWORD" --fullname "Administrator" --email "$EMAIL"
    podman exec pdf-tei-editor-demo .venv/bin/python bin/manage.py user add-role admin admin
    
    # Create demo user if requested
    if [[ $CREATE_DEMO_USER =~ ^[Yy]$ ]]; then
        log_info "Creating demo user: $DEMO_USERNAME..."
        podman exec pdf-tei-editor-demo .venv/bin/python bin/manage.py user remove "$DEMO_USERNAME" 2>/dev/null || true
        podman exec pdf-tei-editor-demo .venv/bin/python bin/manage.py user add "$DEMO_USERNAME" --password "$DEMO_PASSWORD" --fullname "$DEMO_FULLNAME" --email "demo@$FQDN"
        podman exec pdf-tei-editor-demo .venv/bin/python bin/manage.py user add-role "$DEMO_USERNAME" user
    fi
    
    log_success "User accounts configured"
}

# Fix ownership of persistent data directories
fix_ownership() {
    local instance_dir="/opt/pdf-tei-editor-data/$FQDN"
    
    log_info "Setting correct ownership for persistent data directories..."
    
    # Create the instance directory with proper ownership
    mkdir -p "$instance_dir"
    chown -R "$REAL_UID:$REAL_GID" "$instance_dir"
    
    # Set permissions to be readable/writable by owner and group
    chmod -R 755 "$instance_dir"
    find "$instance_dir" -type f -exec chmod 644 {} \;
    
    log_success "Ownership set to $REAL_USER ($REAL_UID:$REAL_GID)"
}

# Initialize data directory with repo contents
setup_data_directory() {
    local instance_dir="/opt/pdf-tei-editor-data/$FQDN"
    local data_dir="$instance_dir/data"
    
    log_info "Setting up data directory for $FQDN..."
    
    # Create data directory
    mkdir -p "$data_dir"
    
    # Copy sample data from repo if data directory is empty
    if [ -d "data" ] && [ -z "$(ls -A "$data_dir" 2>/dev/null)" ]; then
        cp -r data/* "$data_dir/" 2>/dev/null || true
        log_info "Copied sample data from repository"
    fi
    
    log_success "Data directory initialized at $data_dir"
}

# Generate and install nginx configuration
setup_nginx() {
    log_info "Setting up nginx configuration..."
    
    local nginx_config="/etc/nginx/sites-available/pdf-tei-editor-$FQDN"
    
    cat > "$nginx_config" << EOF
# PDF TEI Editor demo configuration for $FQDN
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
    
    # Test nginx configuration
    if nginx -t; then
        log_success "Nginx configuration is valid"
        
        # Handle nginx service properly - ensure it's managed by systemd
        if systemctl is-active --quiet nginx; then
            log_info "Reloading nginx configuration..."
            systemctl reload nginx
        else
            log_info "Nginx service not active, checking for rogue processes..."
            if pgrep nginx > /dev/null; then
                log_info "Stopping unmanaged nginx processes..."
                pkill nginx
                sleep 2
            fi
            log_info "Starting nginx service..."
            systemctl start nginx
        fi
        log_success "Nginx configured and running"
    else
        log_error "Nginx configuration test failed"
        exit 1
    fi
}

# Setup SSL certificate
setup_ssl() {
    log_info "Setting up SSL certificate with Let's Encrypt..."
    
    # Stop nginx temporarily for standalone authentication
    systemctl stop nginx
    
    # Request certificate
    if certbot certonly --standalone --non-interactive --agree-tos --email "$EMAIL" -d "$FQDN"; then
        log_success "SSL certificate obtained"
        
        # Update nginx configuration for HTTPS
        if certbot --nginx -d "$FQDN" --non-interactive; then
            log_success "Nginx configured for HTTPS"
        else
            log_warning "SSL configuration completed but nginx restart failed"
            log_info "This is usually not a problem - checking nginx status..."
        fi
        
        # Handle nginx restart more gracefully
        if systemctl is-active --quiet nginx; then
            log_success "Nginx is already running and serving HTTPS"
        else
            log_info "Attempting to start nginx..."
            if systemctl start nginx; then
                log_success "Nginx started successfully"
            else
                log_warning "Nginx systemd service failed, but checking if it's actually running..."
                if pgrep nginx > /dev/null; then
                    log_success "Nginx process is running despite systemd error"
                else
                    log_error "Nginx is not running - there may be a configuration issue"
                    return 1
                fi
            fi
        fi
    else
        log_error "Failed to obtain SSL certificate"
        systemctl start nginx 2>/dev/null || true
        return 1
    fi
}

# Deploy the application
deploy_application() {
    log_info "Deploying PDF TEI Editor application..."
    
    # Use podman if available, otherwise docker
    local container_cmd="podman"
    if ! command -v podman &> /dev/null; then
        container_cmd="docker"
    fi
    
    # Stop existing container
    $container_cmd stop pdf-tei-editor-demo 2>/dev/null || true
    $container_cmd rm pdf-tei-editor-demo 2>/dev/null || true
    
    # Build the image
    log_info "Building Docker image..."
    $container_cmd build -t pdf-tei-editor .
    
    # Set up instance-specific directories
    local instance_dir="/opt/pdf-tei-editor-data/$FQDN"
    local data_dir="$instance_dir/data"
    local config_dir="$instance_dir/config"
    local db_dir="$instance_dir/db"
    local env_file="$instance_dir/.env"
    
    # Ensure all directories exist before mounting
    log_info "Ensuring all mount directories exist..."
    mkdir -p "$data_dir" "$config_dir" "$db_dir"
    
    # Ensure .env file exists (create empty if missing)
    if [ ! -f "$env_file" ]; then
        touch "$env_file"
        log_info "Created empty .env file"
    fi
    
    # Run the container with per-instance volumes
    log_info "Starting application container for $FQDN..."
    $container_cmd run -d \
        --name pdf-tei-editor-demo \
        --restart unless-stopped \
        -p "$PORT:8000" \
        -e PORT=8000 \
        -v "$data_dir:/app/data" \
        -v "$config_dir:/app/config" \
        -v "$db_dir:/app/db" \
        -v "$env_file:/app/.env" \
        pdf-tei-editor
    
    log_success "Application deployed successfully"
}

# Wait for application to be ready
wait_for_application() {
    log_info "Waiting for application to be ready..."
    
    local max_attempts=30
    local attempt=1
    
    while [ $attempt -le $max_attempts ]; do
        if curl -s "http://localhost:$PORT" > /dev/null 2>&1; then
            log_success "Application is ready"
            return 0
        fi
        
        log_info "Attempt $attempt/$max_attempts - waiting for application..."
        sleep 2
        ((attempt++))
    done
    
    log_warning "Application may not be fully ready yet, but continuing..."
}

# Main setup function
main() {
    log_info "PDF TEI Editor Demo Setup"
    log_info "========================="
    echo
    
    # Check if running as root
    check_root
    
    # Get the user who invoked sudo (for file ownership)
    REAL_USER=${SUDO_USER:-$(whoami)}
    REAL_UID=${SUDO_UID:-$(id -u)}
    REAL_GID=${SUDO_GID:-$(id -g)}
    
    # Check dependencies
    check_dependencies
    
    # Get configuration from user
    log_info "Please provide the following information:"
    echo
    get_fqdn
    get_port
    get_admin_password
    get_demo_user
    get_email
    get_api_keys
    echo
    
    # Confirm settings
    log_info "Configuration Summary:"
    log_info "FQDN: $FQDN"
    log_info "Port: $PORT"
    log_info "Email: $EMAIL"
    echo
    read -p "Continue with this configuration? (y/N): " confirm
    if [[ ! $confirm =~ ^[Yy]$ ]]; then
        log_info "Setup cancelled"
        exit 0
    fi
    
    echo
    log_info "Starting setup process..."
    
    # Setup application configuration and fix ownership
    update_config
    setup_env
    setup_data_directory
    fix_ownership
    
    # Setup nginx
    setup_nginx
    
    # Deploy application
    deploy_application
    
    # Wait for application to start
    wait_for_application
    
    # Setup user accounts after container is running
    setup_users
    
    # Fix ownership after container has created initial files
    fix_ownership
    
    # Setup SSL
    setup_ssl
    
    echo
    log_success "Setup completed successfully!"
    
    # Test if the site is actually accessible
    log_info "Testing site accessibility..."
    if curl -s -k "https://$FQDN" > /dev/null; then
        log_success "✅ Your PDF TEI Editor demo is now available at: https://$FQDN"
    elif pgrep nginx > /dev/null; then
        log_success "🔄 Your PDF TEI Editor demo should be available at: https://$FQDN"
        log_info "(Nginx is running but may need a moment to fully initialize)"
    else
        log_warning "⚠️  Setup completed but site may not be accessible yet"
        log_info "Try: sudo systemctl start nginx"
    fi
    
    echo
    log_info "👤 Login credentials:"
    log_info "  Admin: admin / [your admin password]"
    if [[ $CREATE_DEMO_USER =~ ^[Yy]$ ]]; then
        log_info "  Demo: $DEMO_USERNAME / [your demo password]"
    fi
    
    echo
    log_info "📊 Management commands:"
    log_info "  Monitor logs: sudo podman logs -f pdf-tei-editor-demo"
    log_info "  Stop demo: sudo podman stop pdf-tei-editor-demo"
    log_info "  Fix file ownership: sudo chown -R $REAL_UID:$REAL_GID /opt/pdf-tei-editor-data/$FQDN/"
    log_info "  Data location: /opt/pdf-tei-editor-data/$FQDN/"
}

# Run main function
main "$@"