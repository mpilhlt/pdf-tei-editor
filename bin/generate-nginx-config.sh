#!/bin/bash

# Generate nginx configuration for PDF TEI Editor subdomain
# Usage: ./generate-nginx-config.sh <FQDN> <PORT> [OUTPUT_FILE]

set -e

if [ $# -lt 2 ]; then
    echo "Usage: $0 <FQDN> <PORT> [OUTPUT_FILE]"
    echo "Example: $0 demo.pdf-tei-editor.example.com 8001 /etc/nginx/sites-available/pdf-tei-editor-demo"
    exit 1
fi

FQDN=$1
PORT=$2
OUTPUT_FILE=${3:-"/etc/nginx/sites-available/pdf-tei-editor-${FQDN}"}

echo "Generating nginx configuration for $FQDN -> localhost:$PORT"

cat > "$OUTPUT_FILE" << EOF
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

echo "Nginx configuration created at: $OUTPUT_FILE"
echo ""
echo "To enable this configuration:"
echo "1. sudo ln -sf '$OUTPUT_FILE' /etc/nginx/sites-enabled/"
echo "2. sudo nginx -t"
echo "3. sudo systemctl reload nginx"
echo ""
echo "To add SSL with certbot:"
echo "sudo certbot --nginx -d $FQDN"