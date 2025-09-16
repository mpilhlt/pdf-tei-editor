#!/bin/bash
set -e

echo "Starting PDF TEI Editor application..."

# Set default port if not provided
PORT=${PORT:-8000}

# Change to app directory
cd /app

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
    if .venv/bin/python bin/manage.py user update-password admin --password "$APP_ADMIN_PASSWORD" 2>/dev/null; then
        echo "Admin password updated successfully"
    else
        echo "Admin user not found, creating new admin user..."
        if .venv/bin/python bin/manage.py user add admin --password "$APP_ADMIN_PASSWORD" --fullname "Administrator" --email "admin@localhost" 2>/dev/null; then
            echo "Admin user created successfully"
            .venv/bin/python bin/manage.py user add-role admin admin 2>/dev/null || true
        else
            echo "Warning: Failed to create admin user"
        fi
    fi
fi

# Create or update demo user if APP_DEMO_PASSWORD is set
if [ -n "$APP_DEMO_PASSWORD" ]; then
    echo "Setting up demo user from environment variable..."
    
    # Try to update existing demo user password first
    if .venv/bin/python bin/manage.py user update-password demo --password "$APP_DEMO_PASSWORD" 2>/dev/null; then
        echo "Demo user password updated successfully"
    else
        # If update failed, try to create the user
        echo "Creating new demo user..."
        if .venv/bin/python bin/manage.py user add demo --password "$APP_DEMO_PASSWORD" --fullname "Demo User" --email "demo@localhost" 2>/dev/null; then
            echo "Demo user created successfully"
            .venv/bin/python bin/manage.py user add-role demo user 2>/dev/null || true
        else
            echo "Warning: Failed to create or update demo user"
        fi
    fi
fi

# Create default accounts if no environment variables are set
if [ -z "$APP_ADMIN_PASSWORD" ] && [ -z "$APP_DEMO_PASSWORD" ]; then
    echo "No custom passwords provided, setting up default demo accounts..."

    # Set default login message with security warning
    export DEFAULT_LOGIN_MESSAGE="<h2>⚠️ Demo Installation</h2><p>Default accounts: <code>admin/admin</code> and <code>demo/demo</code>. For testing purposes only. <a href='https://github.com/mpilhlt/pdf-tei-editor/blob/main/docs/testdrive-docker.md' target='_blank'>Configure real passwords in production!</a></p>"
    # Use Python to properly escape the message for JSON
    ESCAPED_DEFAULT_MESSAGE=$(.venv/bin/python -c "import json, os; print(json.dumps(os.environ.get('DEFAULT_LOGIN_MESSAGE', '')))")
    .venv/bin/python bin/manage.py config set application.login-message "$ESCAPED_DEFAULT_MESSAGE" 2>/dev/null || echo "Warning: Failed to set default login message"

    # Create default admin user
    echo "Creating default admin user (admin/admin)..."
    if .venv/bin/python bin/manage.py user add admin --password "admin" --fullname "Administrator" --email "admin@localhost" 2>/dev/null; then
        echo "Default admin user created successfully"
        .venv/bin/python bin/manage.py user add-role admin admin 2>/dev/null || true
    else
        # Try to update existing admin user
        .venv/bin/python bin/manage.py user update-password admin --password "admin" 2>/dev/null || echo "Warning: Failed to create/update admin user"
    fi

    # Create default demo user
    echo "Creating default demo user (demo/demo)..."
    if .venv/bin/python bin/manage.py user add demo --password "demo" --fullname "Demo User" --email "demo@localhost" 2>/dev/null; then
        echo "Default demo user created successfully"
        .venv/bin/python bin/manage.py user add-role demo user 2>/dev/null || true
    else
        # Try to update existing demo user
        .venv/bin/python bin/manage.py user update-password demo --password "demo" 2>/dev/null || echo "Warning: Failed to create/update demo user"
    fi

    echo "Default setup complete. Remember to configure secure passwords for production use!"
fi

# Start the PDF TEI Editor application bound to all interfaces for Docker
exec .venv/bin/python bin/start-prod 0.0.0.0 $PORT