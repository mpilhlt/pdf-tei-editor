#!/bin/bash
set -e

echo "Starting PDF TEI Editor application..."

# Set default port if not provided
PORT=${PORT:-8000}

# Change to app directory
cd /app

# Initialize database directory if it doesn't exist
if [ ! -d "/app/data/db" ]; then
    echo "Initializing database directory..."
    mkdir -p /app/data/db
fi

# Copy default config files if they don't exist
for config_file in /app/config/*.json; do
    if [ -f "$config_file" ]; then
        filename=$(basename "$config_file")
        if [ ! -f "/app/data/db/$filename" ]; then
            echo "Copying default $filename..."
            cp "$config_file" "/app/data/db/$filename"
        fi
    fi
done


# Show demo warning and set login message only when neither password is customized
if [ -z "$APP_ADMIN_PASSWORD" ] && [ -z "$APP_DEMO_PASSWORD" ]; then
    echo "No custom passwords provided, setting up default demo accounts..."

    # Set default login message with security warning
    export APP_LOGIN_MESSAGE="<h2>⚠️ Demo Installation</h2><p>Default accounts: <code>admin/admin</code> and <code>demo/demo</code>. For testing purposes only. <a href='https://github.com/mpilhlt/pdf-tei-editor/blob/main/docs/user-manual/testdrive-docker.md' target='_blank'>Configure real passwords in production!</a></p>"
    # Use Python to properly escape the message for JSON
    ESCAPED_DEFAULT_MESSAGE=$(.venv/bin/python -c "import json, os; print(json.dumps(os.environ.get('APP_LOGIN_MESSAGE', '')))")
    .venv/bin/python bin/manage.py config set application.login-message "$ESCAPED_DEFAULT_MESSAGE" 2>/dev/null || echo "Warning: Failed to set default login message"
fi

# Fall back to defaults for any password not explicitly provided
APP_ADMIN_PASSWORD=${APP_ADMIN_PASSWORD:-admin}
APP_DEMO_PASSWORD=${APP_DEMO_PASSWORD:-demo}

# Set login message if APP_LOGIN_MESSAGE is provided
if [ -n "$APP_LOGIN_MESSAGE" ]; then
    echo "Setting login message from environment variable..."
    # Use Python to properly escape the message for JSON
    ESCAPED_MESSAGE=$(.venv/bin/python -c "import json, os; print(json.dumps(os.environ.get('APP_LOGIN_MESSAGE', '')))")
    .venv/bin/python bin/manage.py config set application.login-message "$ESCAPED_MESSAGE" 2>/dev/null || echo "Warning: Failed to set login message"
fi


# Create or update admin user if APP_ADMIN_PASSWORD is set
if [ -n "$APP_ADMIN_PASSWORD" ]; then
    echo "Setting up admin user from environment variable..."
    # Create user if it doesn't exist (ignore failure if already exists)
    .venv/bin/python bin/manage.py \
            --db-path /app/data/db \
            user add admin \
            --password "$APP_ADMIN_PASSWORD" \
            --fullname "Administrator" \
            --roles "admin" \
            --email "admin@localhost" 2>/dev/null || true
    # Always update the password to ensure the env var takes effect even if the user already existed
    if .venv/bin/python bin/manage.py \
            --db-path /app/data/db \
            user update-password admin "$APP_ADMIN_PASSWORD";
    then
        echo "Admin user configured successfully"
    else
        echo "Warning: Failed to configure admin user"
    fi
fi

# Create or update demo user if APP_DEMO_PASSWORD is set
if [ -n "$APP_DEMO_PASSWORD" ]; then
    echo "Setting up demo user from environment variable..."
    # Create user if it doesn't exist (ignore failure if already exists)
    .venv/bin/python bin/manage.py \
            --db-path /app/data/db \
            user add demo \
            --password "$APP_DEMO_PASSWORD" \
            --fullname "Demo User" \
            --roles "user,annotator,reviewer" \
            --email "demo@localhost" 2>/dev/null || true
    # Always update the password to ensure the env var takes effect even if the user already existed
    if .venv/bin/python bin/manage.py \
            --db-path /app/data/db \
            user update-password demo "$APP_DEMO_PASSWORD";
    then
        echo "Demo user configured successfully"
    else
        echo "Warning: Failed to configure demo user"
    fi
fi

# Import demo data if present
if [ -f /app/docker/import-demo-data.sh ]; then
    echo "Importing demo data..."
    /app/docker/import-demo-data.sh
fi

# Start the PDF TEI Editor application bound to all interfaces for Docker
exec .venv/bin/python bin/start-prod 0.0.0.0 $PORT