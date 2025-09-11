#!/bin/bash
set -e

echo "Starting PDF TEI Editor application..."

# Set default port if not provided
PORT=${PORT:-8000}

# Change to app directory
cd /app

# Start the PDF TEI Editor application on the specified port
exec .venv/bin/python bin/start-prod