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
mkdir -p data/db data/files data/versions config

# Initialize config from defaults
echo "Initializing configuration..."
# Check if we have test configs mounted at /app/data/config (from volume mount)
if [ -d "/app/data/config" ] && [ -n "$(ls -A /app/data/config/*.json 2>/dev/null)" ]; then
    echo "Using test configs from /app/data/config..."
    for config_file in /app/data/config/*.json; do
        if [ -f "$config_file" ]; then
            filename=$(basename "$config_file")
            echo "Copying test $filename..."
            cp "$config_file" "/app/data/db/$filename"
        fi
    done
else
    # Use default configs from image
    for config_file in /app/config/*.json; do
        if [ -f "$config_file" ]; then
            filename=$(basename "$config_file")
            if [ ! -f "/app/data/db/$filename" ]; then
                echo "Copying default $filename..."
                cp "$config_file" "/app/data/db/$filename"
            fi
        fi
    done
fi

# Import data if IMPORT_DATA_PATH is set
if [ -n "$IMPORT_DATA_PATH" ] && [ -f "/app/docker/import-demo-data.sh" ]; then
    echo "Importing data from $IMPORT_DATA_PATH..."
    bash /app/docker/import-demo-data.sh || echo "Warning: Data import failed"
fi

echo "Setting up test fixtures..."
# Copy test fixtures to application directories if they exist
if [ -d "/app/tests/e2e/fixtures/db" ]; then
    echo "Copying test user and role fixtures..."
    cp /app/tests/e2e/fixtures/db/*.json data/db/ 2>/dev/null || true
fi

if [ -d "/app/tests/e2e/fixtures/config" ]; then
    echo "Copying test config fixtures..."
    cp /app/tests/e2e/fixtures/config/*.json config/ 2>/dev/null || true
fi

# Fallback: Create default test user if fixtures don't exist
if [ ! -f "data/db/users.json" ]; then
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

# Create log directory
mkdir -p /app/log

# Start server with single worker for faster startup in tests
# Redirect output to log file but also show startup messages
exec .venv/bin/uvicorn run_fastapi:app \
  --host 0.0.0.0 \
  --port 8000 \
  --log-level info \
  --workers 1 \
  --timeout-graceful-shutdown 5 \
  > /app/log/fastapi-server.log 2>&1 &

# Wait for server to be ready
echo "Waiting for server to start..."
for i in {1..30}; do
  if curl -f http://localhost:8000/health >/dev/null 2>&1; then
    echo "Server is ready!"
    break
  fi
  sleep 1
done

# Keep container running by tailing the log
tail -f /app/log/fastapi-server.log