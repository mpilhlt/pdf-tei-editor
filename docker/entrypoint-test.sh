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
mkdir -p data/pdf data/tei data/versions config db

echo "Setting up test fixtures..."
# Copy test fixtures to application directories if they exist
if [ -d "/app/tests/e2e/fixtures/db" ]; then
    echo "Copying test user and role fixtures..."
    cp /app/tests/e2e/fixtures/db/*.json db/ 2>/dev/null || true
fi

if [ -d "/app/tests/e2e/fixtures/config" ]; then
    echo "Copying test config fixtures..."
    cp /app/tests/e2e/fixtures/config/*.json config/ 2>/dev/null || true
fi

# Fallback: Create default test user if fixtures don't exist
if [ ! -f "db/users.json" ]; then
    echo "Fixtures not found, creating fallback test user..."
    .venv/bin/python bin/manage.py user add testuser --password testpass --fullname "Test User" --roles "annotator" 2>/dev/null || echo "Test user testuser/testpass ready"
else
    echo "Test users loaded from fixtures"
fi

echo "Enabling testing mode..."
.venv/bin/python bin/manage.py config set application.mode '"testing"'

# Set environment variable to enable test-specific features
export TEST_IN_PROGRESS=1
echo "Set TEST_IN_PROGRESS=1 for test environment"

echo "Starting test server..."

# Start server using the production startup script (waitress)
exec .venv/bin/python bin/start-prod 0.0.0.0 8000