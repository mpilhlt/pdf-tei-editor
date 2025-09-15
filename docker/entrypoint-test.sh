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

# Initialize database and create test user
if [ ! -f "db/users.json" ]; then
    echo "Initializing test database..."
    echo '{}' > db/users.json
fi

echo "Creating test user..."
uv run python bin/manage.py user add testuser --password testpass --fullname "Test User" 2>/dev/null || echo "Test user testuser/testpass ready"

echo "Enabling testing mode..."
uv run python bin/manage.py config set application.mode '"testing"'

# Create test configuration
cat > config/test.json << EOF
{
    "debug": false,
    "host": "0.0.0.0",
    "port": 8000,
    "data_dir": "./data",
    "max_file_size": "100MB",
    "test_mode": true
}
EOF

echo "Starting test server..."

# Start server using the production startup script (waitress)
exec uv run python bin/start-prod 0.0.0.0 8000