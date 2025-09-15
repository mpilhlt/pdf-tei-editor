#!/bin/bash

# PDF TEI Editor Docker Deployment Script
# Usage: ./bin/start-docker-image.sh <FQDN> [PORT]
# Example: ./bin/start-docker-image.sh demo.pdf-tei-editor.example.com 8001

set -e

# Check if FQDN is provided
if [ $# -eq 0 ]; then
    echo "Usage: $0 <FQDN> [PORT]"
    echo "Example: $0 demo.pdf-tei-editor.example.com 8001"
    exit 1
fi

FQDN=$1
PORT=${2:-8001}
CONTAINER_NAME="pdf-tei-editor-demo"
IMAGE_NAME="pdf-tei-editor"

echo "Starting PDF TEI Editor demo for domain: $FQDN on port: $PORT"

# Stop and remove existing container if it exists
if podman ps -a --format "{{.Names}}" | grep -q "^${CONTAINER_NAME}$"; then
    echo "Stopping existing container..."
    podman stop $CONTAINER_NAME
    podman rm $CONTAINER_NAME
fi

# Build the Docker image
echo "Building Docker image..."
podman build -t $IMAGE_NAME .

# Create persistent volume for data
echo "Creating persistent volume for application data..."
podman volume create ${CONTAINER_NAME}-data 2>/dev/null || true

# Generate nginx configuration
echo "Generating nginx configuration..."
./docker/generate-nginx-config.sh "$FQDN" "$PORT"

# Run the container
echo "Starting container..."
podman run -d \
    --name $CONTAINER_NAME \
    --restart unless-stopped \
    -p $PORT:8000 \
    -e PORT=8000 \
    -v ${CONTAINER_NAME}-data:/app/data \
    $IMAGE_NAME

echo "Container started successfully!"
echo "The application is running on port $PORT"
echo ""
echo "To enable nginx configuration:"
echo "sudo ln -sf /etc/nginx/sites-available/pdf-tei-editor-$FQDN /etc/nginx/sites-enabled/"
echo "sudo nginx -t"
echo "sudo systemctl reload nginx"
echo ""
echo "To add SSL certificate:"
echo "sudo certbot --nginx -d $FQDN"
echo ""
echo "To monitor logs:"
echo "  podman logs -f $CONTAINER_NAME"
echo ""
echo "To stop the demo:"
echo "  podman stop $CONTAINER_NAME"