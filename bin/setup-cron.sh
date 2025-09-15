#!/bin/bash

# Setup cron job for nightly demo reset
# Usage: ./setup-cron.sh <FQDN> <PORT> <REPO_PATH>
# Example: ./setup-cron.sh demo.pdf-tei-editor.example.com 8001 /opt/pdf-tei-editor

set -e

if [ $# -lt 3 ]; then
    echo "Usage: $0 <FQDN> <PORT> <REPO_PATH>"
    echo "Example: $0 demo.pdf-tei-editor.example.com 8001 /opt/pdf-tei-editor"
    exit 1
fi

FQDN=$1
PORT=$2
REPO_PATH=$3

echo "Setting up cron job for nightly reset..."

# Create log directory
sudo mkdir -p /var/log
sudo touch /var/log/pdf-tei-editor-reset.log
sudo chmod 644 /var/log/pdf-tei-editor-reset.log

# Add cron job (runs at 2 AM every night)
CRON_JOB="0 2 * * * $REPO_PATH/docker/reset-demo-nightly.sh $FQDN $PORT >> /var/log/pdf-tei-editor-reset.log 2>&1"

# Check if cron job already exists
if crontab -l 2>/dev/null | grep -q "reset-demo-nightly.sh"; then
    echo "Cron job already exists, updating..."
    (crontab -l 2>/dev/null | grep -v "reset-demo-nightly.sh"; echo "$CRON_JOB") | crontab -
else
    echo "Adding new cron job..."
    (crontab -l 2>/dev/null; echo "$CRON_JOB") | crontab -
fi

echo "Cron job added successfully!"
echo "The demo will reset every night at 2:00 AM"
echo ""
echo "To view current cron jobs:"
echo "  crontab -l"
echo ""
echo "To view reset logs:"
echo "  tail -f /var/log/pdf-tei-editor-reset.log"
echo ""
echo "To remove the cron job:"
echo "  crontab -l | grep -v reset-demo-nightly.sh | crontab -"