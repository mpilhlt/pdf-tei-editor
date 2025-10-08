#!/bin/bash
set -e

echo "Starting PDF TEI Editor application..."

# Set default port if not provided
PORT=${PORT:-8000}

# Change to app directory
cd /app


# Create default accounts if no environment variables are set
if [ -z "$APP_ADMIN_PASSWORD" ] && [ -z "$APP_DEMO_PASSWORD" ]; then
    echo "No custom passwords provided, setting up default demo accounts..."

    # Set default login message with security warning
    export APP_LOGIN_MESSAGE="<h2>⚠️ Demo Installation</h2><p>Default accounts: <code>admin/admin</code> and <code>demo/demo</code>. For testing purposes only. <a href='https://github.com/mpilhlt/pdf-tei-editor/blob/main/docs/testdrive-docker.md' target='_blank'>Configure real passwords in production!</a></p>"
    # Use Python to properly escape the message for JSON
    ESCAPED_DEFAULT_MESSAGE=$(.venv/bin/python -c "import json, os; print(json.dumps(os.environ.get('APP_LOGIN_MESSAGE', '')))")
    .venv/bin/python bin/manage.py config set application.login-message "$ESCAPED_DEFAULT_MESSAGE" 2>/dev/null || echo "Warning: Failed to set default login message"

    # Create default admin and demo user
    export APP_ADMIN_PASSWORD="admin"
    export APP_DEMO_PASSWORD="demo"
fi

# Set login message if APP_LOGIN_MESSAGE is provided
if [ -n "$APP_LOGIN_MESSAGE" ]; then
    echo "Setting login message from environment variable..."
    # Use Python to properly escape the message for JSON
    ESCAPED_MESSAGE=$(.venv/bin/python -c "import json, os; print(json.dumps(os.environ.get('APP_LOGIN_MESSAGE', '')))")
    .venv/bin/python bin/manage.py config set application.login-message "$ESCAPED_MESSAGE" 2>/dev/null || echo "Warning: Failed to set login message"
fi


# Update admin password if APP_ADMIN_PASSWORD is set
if [ -n "$APP_ADMIN_PASSWORD" ]; then
    echo "Setting up admin user from environment variable..."
    if .venv/bin/python bin/manage.py user update-password admin \
        --password "$APP_ADMIN_PASSWORD" 2>/dev/null;
    then
        echo "Admin password updated successfully"
    else
        echo "Warning: Failed to update admin user password"
    fi
fi

# Create or update demo user if APP_DEMO_PASSWORD is set
if [ -n "$APP_DEMO_PASSWORD" ]; then
    echo "Creating new demo user..."
    if .venv/bin/python bin/manage.py user add demo \
            --password "$APP_DEMO_PASSWORD" \
            --fullname "Demo User" \
            --roles "user,annotator,reviewer" \
            --email "demo@localhost" 2>/dev/null;
    then
        echo "Demo user created successfully"
    else
        echo "Warning: Failed to create demo user"
    fi
fi



# Start the PDF TEI Editor application bound to all interfaces for Docker
exec .venv/bin/python bin/start-prod 0.0.0.0 $PORT