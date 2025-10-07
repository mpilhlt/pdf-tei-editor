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

# Create data directories (preserve existing demo data)
mkdir -p data/versions config db
# Only create pdf/tei subdirectories if they don't already exist with data
[ ! -d "data/pdf" ] && mkdir -p data/pdf
[ ! -d "data/tei" ] && mkdir -p data/tei

echo "Checking demo data availability..."
if [ -d "data/tei/example" ] && [ -f "data/tei/example/10.5771__2699-1284-2024-3-149.tei.xml" ]; then
    echo "✓ Demo TEI file found: data/tei/example/10.5771__2699-1284-2024-3-149.tei.xml"
else
    echo "⚠ Demo TEI file NOT found, listing data directory contents:"
    ls -la data/ || echo "data directory does not exist"
    ls -la data/tei/ || echo "data/tei directory does not exist"
fi

if [ -d "data/pdf/example" ] && [ -f "data/pdf/example/10.5771__2699-1284-2024-3-149.pdf" ]; then
    echo "✓ Demo PDF file found: data/pdf/example/10.5771__2699-1284-2024-3-149.pdf"
else
    echo "⚠ Demo PDF file NOT found"
fi

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