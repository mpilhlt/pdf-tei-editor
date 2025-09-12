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

get_email() {
    read -p "Enter email for SSL certificate [admin@$FQDN]: " EMAIL
    EMAIL=${EMAIL:-"admin@$FQDN"}
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
    local config_file="config/config.json"
    log_info "Updating application configuration..."
    
    if [ -f "$config_file" ]; then
        # Create backup
        cp "$config_file" "${config_file}.backup"
        
        # Update configuration using Python
        python3 -c "
import json
import sys

config_file = '$config_file'
try:
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
    else
        log_warning "Config file not found, creating new one..."
        mkdir -p config
        cat > "$config_file" << EOF
{
  "application": {
    "mode": "production"
  }
}
EOF
    fi
    
    log_success "Configuration updated"
}

# Update users database
update_users() {
    local users_file="db/users.json"
    local hashed_password=$(hash_password "$ADMIN_PASSWORD")
    
    log_info "Updating admin user..."
    
    # Create db directory if it doesn't exist
    mkdir -p db
    
    # Create users.json with admin user
    python3 -c "
import json
import sys

users_file = '$users_file'
hashed_password = '$hashed_password'

try:
    users = {
        'admin': {
            'username': 'admin',
            'fullname': 'Administrator',
            'email': '$EMAIL',
            'password': hashed_password,
            'roles': ['admin', 'user']
        }
    }
    
    with open(users_file, 'w') as f:
        json.dump(users, f, indent=2)
    
    print('Admin user created successfully')
except Exception as e:
    print(f'Error creating admin user: {e}', file=sys.stderr)
    sys.exit(1)
"
    
    log_success "Admin user configured"
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
        certbot --nginx -d "$FQDN" --non-interactive
        log_success "Nginx configured for HTTPS"
        
        # Start nginx
        systemctl start nginx
    else
        log_error "Failed to obtain SSL certificate"
        systemctl start nginx
        exit 1
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
    
    # Create persistent volume
    $container_cmd volume create pdf-tei-editor-demo-data 2>/dev/null || true
    
    # Run the container
    log_info "Starting application container..."
    $container_cmd run -d \
        --name pdf-tei-editor-demo \
        --restart unless-stopped \
        -p "$PORT:8000" \
        -e PORT=8000 \
        -v pdf-tei-editor-demo-data:/app/data \
        -v "$(pwd)/config:/app/config" \
        -v "$(pwd)/db:/app/db" \
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
    
    # Check dependencies
    check_dependencies
    
    # Get configuration from user
    log_info "Please provide the following information:"
    echo
    get_fqdn
    get_port
    get_admin_password
    get_email
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
    
    # Setup application configuration
    update_config
    update_users
    
    # Setup nginx
    setup_nginx
    
    # Deploy application
    deploy_application
    
    # Wait for application to start
    wait_for_application
    
    # Setup SSL
    setup_ssl
    
    echo
    log_success "Setup completed successfully!"
    log_success "Your PDF TEI Editor demo is now available at: https://$FQDN"
    log_info "Admin login: admin"
    log_info "Admin password: [the password you entered]"
    echo
    log_info "To monitor the application:"
    log_info "  sudo podman logs -f pdf-tei-editor-demo"
    echo
    log_info "To stop the demo:"
    log_info "  sudo podman stop pdf-tei-editor-demo"
}

# Run main function
main "$@"