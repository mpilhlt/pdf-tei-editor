# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Essential Development Commands

### Setup and Installation
```bash
# Install Python dependencies
uv sync

# Install Node.js dependencies  
npm install

# On Windows, use:
npm --ignore-scripts install
uv run python bin\download-pdfjs
```

### Development Server
```bash
# Start development server (Python/Flask backend + JS frontend)
./bin/server
# On Windows: uv run python bin\server
# Access at http://localhost:3001

# Development mode with source files (append ?dev to URL)
# http://localhost:3001?dev
```

### Build System
```bash
# Full build process
npm run build
# Equivalent to: ./bin/build

# Update import map after changing NPM dependencies
npm run update-importmap
```

### Testing and Validation
```bash
# Run all tests
npm test

# Run specific test suite (e.g., synchronization algorithm tests)
npm run test:sync

# The application includes XML validation through TEI schema validation
```

### User Management
```bash
# Manage users via CLI
./bin/manage.py user add <username> --password <password> --fullname "<Full Name>"
./bin/manage.py user list
./bin/manage.py user remove <username>
```

## Application Architecture

### Backend (Python/Flask)
- **Main server**: `server/flask_app.py` - Flask application with dynamic blueprint registration
- **API routes**: `server/api/` - Each file defines a blueprint (auth.py, files.py, etc.)
- **Utilities**: `server/lib/` - Server-side utilities and helpers
- **Data storage**: `data/` directory for PDFs and TEI/XML files
- **Configuration**: `config/` and `db/` directories for app settings and user data

### Frontend (JavaScript/ES Modules)
- **Plugin architecture**: All functionality implemented as plugins in `app/src/plugins/`
- **Core files**:
  - `app/src/app.js` - Main application bootstrap and plugin registration
  - `app/src/endpoints.js` - Defines plugin extension points
  - `app/src/ui.js` - UI element management and DOM structure
- **Templates**: `app/src/templates/` - HTML templates for UI components
- **Build output**: `app/web/` - Compiled/bundled frontend assets

### Plugin System
- Plugins implement endpoints defined in `endpoints.js`:
  - `install` - Plugin initialization and DOM setup
  - `start` - Application startup after all plugins installed
  - `state.update` - React to application state changes
- State is managed centrally and passed to all plugins
- UI built with Shoelace WebComponents (`@shoelace-style/shoelace`)

### Key Technologies
- **Backend**: Flask, Python 3.13+, uv for dependency management
- **Frontend**: ES6 modules, CodeMirror 6, PDF.js, Shoelace UI components
- **Build**: Rollup for bundling, importmap for development
- **Schema validation**: TEI/XML schema validation with RelaxNG

### Development Workflow
1. Frontend changes: Edit files in `app/src/`, test with `?dev` URL parameter
2. **DO NOT rebuild after frontend changes** - The importmap loads source files directly in development mode
3. Backend changes: Server auto-reloads automatically (Flask dev server detects changes)
4. **DO NOT restart the server** - Flask development server auto-restarts on backend changes
5. Schema updates: Delete `schema/cache/` to refresh XSD cache
6. Building is only needed for production and is handled by pre-push git hooks

### Debugging and Logging
- Development server uses colorized logging for better visibility
- WARNING messages appear in orange/yellow for timeouts and issues
- ERROR messages appear in red for critical problems

### Important File Paths
- Entry point: `app/src/app.js`
- Plugin registration: Plugins array in `app/src/app.js:71-76`
- Server startup: `bin/server` 
- Build script: `bin/build`
- User management: `bin/manage.py`