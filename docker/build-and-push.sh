#!/bin/bash

# Docker Hub Build and Push Script for PDF TEI Editor
# Usage: ./docker/build-and-push.sh [TAG]
# Example: ./docker/build-and-push.sh v1.0.0

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

# Detect container tool (podman or docker)
detect_container_tool() {
    if command -v podman &> /dev/null; then
        CONTAINER_CMD="podman"
        log_info "Using podman as container tool"
    elif command -v docker &> /dev/null; then
        CONTAINER_CMD="docker"
        log_info "Using docker as container tool"
    else
        log_error "Neither podman nor docker found. Please install one of them."
        exit 1
    fi
}

# Load environment variables from .env file
load_env() {
    if [ -f ".env" ]; then
        log_info "Loading environment variables from .env file..."
        # Export variables while preserving existing environment
        set -a
        source .env
        set +a
        log_success "Environment variables loaded"
    else
        log_warning "No .env file found - you'll need to set environment variables manually"
    fi
}

# Validate required environment variables
validate_env() {
    local missing_vars=()
    
    if [ -z "$DOCKER_HUB_USERNAME" ]; then
        missing_vars+=("DOCKER_HUB_USERNAME")
    fi
    
    if [ -z "$DOCKER_HUB_TOKEN" ]; then
        missing_vars+=("DOCKER_HUB_TOKEN")
    fi
    
    if [ ${#missing_vars[@]} -ne 0 ]; then
        log_error "Missing required environment variables: ${missing_vars[*]}"
        echo
        log_info "Please add these to your .env file:"
        for var in "${missing_vars[@]}"; do
            echo "  $var=your_value_here"
        done
        echo
        log_info "For Docker Hub token, create a Personal Access Token at:"
        log_info "  https://hub.docker.com/settings/security"
        exit 1
    fi
    
    log_success "All required environment variables found"
}

# Get version tag
get_version() {
    # Use provided tag or default to git-based version
    if [ -n "$1" ]; then
        VERSION_TAG="$1"
        log_info "Using provided version tag: $VERSION_TAG"
    else
        # Try to get version from git
        if git rev-parse --git-dir > /dev/null 2>&1; then
            GIT_HASH=$(git rev-parse --short HEAD)
            GIT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
            
            if [ "$GIT_BRANCH" = "main" ] || [ "$GIT_BRANCH" = "master" ]; then
                VERSION_TAG="latest"
            else
                VERSION_TAG="$GIT_BRANCH-$GIT_HASH"
            fi
            log_info "Auto-generated version tag: $VERSION_TAG"
        else
            VERSION_TAG="latest"
            log_warning "Not in a git repository, using 'latest' tag"
        fi
    fi
}

# Build container image
build_image() {
    local image_name="$DOCKER_HUB_USERNAME/pdf-tei-editor"
    local full_tag="$image_name:$VERSION_TAG"
    local latest_tag="$image_name:latest"
    
    log_info "Building container image: $full_tag"
    
    # Build with both version tag and latest
    if $CONTAINER_CMD build -t "$full_tag" -t "$latest_tag" .; then
        log_success "Container image built successfully"
        
        # Show image details
        log_info "Image details:"
        $CONTAINER_CMD images "$image_name" --format "table {{.Repository}}\t{{.Tag}}\t{{.Size}}\t{{.CreatedSince}}"
        
        return 0
    else
        log_error "Container image build failed"
        return 1
    fi
}

# Login to Docker Hub
registry_login() {
    log_info "Logging in to Docker Hub as $DOCKER_HUB_USERNAME..."
    
    if echo "$DOCKER_HUB_TOKEN" | $CONTAINER_CMD login --username "$DOCKER_HUB_USERNAME" --password-stdin docker.io; then
        log_success "Successfully logged in to Docker Hub"
        return 0
    else
        log_error "Docker Hub login failed"
        return 1
    fi
}

# Push image to Docker Hub
push_image() {
    local image_name="$DOCKER_HUB_USERNAME/pdf-tei-editor"
    local full_tag="$image_name:$VERSION_TAG"
    local latest_tag="$image_name:latest"
    
    log_info "Pushing image to Docker Hub..."
    
    # Push version-specific tag
    log_info "Pushing $full_tag..."
    if $CONTAINER_CMD push "$full_tag"; then
        log_success "Successfully pushed $full_tag"
    else
        log_error "Failed to push $full_tag"
        return 1
    fi
    
    # Push latest tag (only if not already latest)
    if [ "$VERSION_TAG" != "latest" ]; then
        log_info "Pushing $latest_tag..."
        if $CONTAINER_CMD push "$latest_tag"; then
            log_success "Successfully pushed $latest_tag"
        else
            log_warning "Failed to push $latest_tag (version tag push succeeded)"
        fi
    fi
    
    log_success "All images pushed successfully!"
    
    # Show final repository info
    echo
    log_info "🐳 Your image is now available at:"
    log_info "  $CONTAINER_CMD pull $full_tag"
    if [ "$VERSION_TAG" != "latest" ]; then
        log_info "  $CONTAINER_CMD pull $latest_tag"
    fi
    log_info "  https://hub.docker.com/r/$DOCKER_HUB_USERNAME/pdf-tei-editor"
}

# Cleanup function
cleanup() {
    log_info "Logging out of Docker Hub..."
    $CONTAINER_CMD logout docker.io 2>/dev/null || true
}

# Main function
main() {
    log_info "PDF TEI Editor - Docker Hub Build & Push"
    log_info "======================================="
    echo
    
    # Detect container tool first
    detect_container_tool
    
    # Set up cleanup on exit
    trap cleanup EXIT
    
    # Load and validate environment
    load_env
    validate_env
    
    # Get version tag
    get_version "$1"
    
    # Confirm before proceeding
    echo
    log_info "Configuration:"
    log_info "  Docker Hub User: $DOCKER_HUB_USERNAME"
    log_info "  Version Tag: $VERSION_TAG"
    log_info "  Image Name: $DOCKER_HUB_USERNAME/pdf-tei-editor:$VERSION_TAG"
    echo
    
    read -p "Continue with build and push? (y/N): " -r
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        log_info "Build cancelled by user"
        exit 0
    fi
    
    echo
    log_info "Starting build and push process..."
    
    # Build the image
    if ! build_image; then
        exit 1
    fi
    
    echo
    # Login to Docker Hub
    if ! registry_login; then
        exit 1
    fi
    
    echo
    # Push to Docker Hub
    if ! push_image; then
        exit 1
    fi
    
    echo
    log_success "🎉 Build and push completed successfully!"
}

# Run main function with all arguments
main "$@"