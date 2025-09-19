#!/bin/bash

# Test-optimized entrypoint script
# - Faster startup
# - Test-specific configuration
# - Health check endpoint

set -e

echo "PDF TEI Editor - Test Environment"
echo "================================"

# Source NVM for Node.js commands
export NVM_DIR="/root/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"

cd /app

# Create data directories
mkdir -p data/pdf data/tei config db

echo "Creating test user..."
exec .venv/bin/python bin/manage.py user add testuser --password testpass --fullname "Test User" 2>/dev/null || echo "Test user testuser/testpass ready"

echo "Enabling testing mode..."
exec .venv/bin/python bin/manage.py config set application.mode '"testing"'

echo "Starting test server..."

# Start server using the production startup script (waitress)
exec .venv/bin/python bin/start-prod 0.0.0.0 8000