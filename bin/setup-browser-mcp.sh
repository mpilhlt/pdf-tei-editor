#!/bin/bash

# Browser MCP Setup Script
# This script installs and configures the ByteDance browser MCP server for Claude Code

set -e  # Exit on any error

echo "🚀 Setting up Browser MCP for Claude Code..."

# Check if claude command is available
if ! command -v claude &> /dev/null; then
    echo "❌ Error: 'claude' command not found. Please install Claude Code first."
    echo "   Visit: https://claude.ai/code"
    exit 1
fi

# Check if npx is available
if ! command -v npx &> /dev/null; then
    echo "❌ Error: 'npx' command not found. Please install Node.js first."
    echo "   Visit: https://nodejs.org/"
    exit 1
fi

echo "✅ Prerequisites check passed"

# Remove existing browser-mcp configuration if it exists
echo "🧹 Cleaning up any existing browser-mcp configuration..."
claude mcp remove browser-mcp 2>/dev/null || true

# Install the browser MCP server
echo "📦 Installing browser MCP server..."
claude mcp add browser-mcp -- npx @agent-infra/mcp-server-browser@latest

# Verify the installation
echo "🔍 Verifying installation..."
if claude mcp list | grep -q "browser-mcp.*✓ Connected"; then
    echo "✅ Browser MCP server successfully installed and connected!"
    echo ""
    echo "🎉 Setup complete! Claude Code now has access to headless browser capabilities:"
    echo "   • Page navigation and interaction"
    echo "   • Element clicking and form filling"
    echo "   • Text extraction and screenshots"
    echo "   • Console output monitoring"
    echo "   • Tab management"
    echo ""
    echo "You can now ask Claude to automate web interactions!"
else
    echo "❌ Installation verification failed. Please check the output above for errors."
    exit 1
fi