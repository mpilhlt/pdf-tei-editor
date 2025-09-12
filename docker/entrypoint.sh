#!/bin/bash
set -e

echo "Starting PDF TEI Editor application..."

# Set default port if not provided
PORT=${PORT:-8000}

# Change to app directory
cd /app

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

# Start the PDF TEI Editor application bound to all interfaces for Docker
exec .venv/bin/python bin/start-prod 0.0.0.0 $PORT