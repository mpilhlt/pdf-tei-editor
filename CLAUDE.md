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

### UI Component System
The application uses a typed UI hierarchy system with the following rules:

#### UI Part Naming Convention
- Each UI part typedef is called a "part" and follows camelCase naming
- Part names always end with "Part" (e.g., `toolbarPart`, `dialogPart`)
- Since UI parts represent singletons in the UI, they use lowercase naming

#### UI Part Location and Documentation
- UI parts are defined in the plugin that uses/creates them
- Each part documents the named element hierarchy from its HTML templates
- UI parts use the `UIPart<T, N>` generic type that combines DOM element type `T` with navigation properties type `N`

#### Type Usage Rules
- When a UI part property is a pure HTMLElement with no navigation properties, use the DOM element type directly
- When a UI part has child navigation properties, use `UIPart<DOMElementType, NavigationPropertiesType>`
- Elements serve as both DOM elements and navigation objects - no `self` property needed
- Access DOM methods directly: `ui.dialog.show()` instead of `ui.dialog.self.show()`

#### Examples
```javascript
// UI part definition
/**
 * @typedef {object} dialogPart  
 * @property {HTMLSpanElement} message - Direct DOM element (no navigation)
 * @property {SlButton} closeBtn - Direct DOM element (no navigation)
 */

// Usage in parent part
/**
 * @typedef {object} namedElementsTree
 * @property {UIPart<SlDialog, dialogPart>} dialog - Dialog with navigation properties
 */

// Usage in code
ui.dialog.show()                    // Call DOM method directly
ui.dialog.message.innerHTML = text  // Access child element
```

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

## Best Practices and Code Conventions

### Python Development
- Always prefer pathlib Path().as_posix() over manually concatenating path strings or os.path.join()
- **NEVER start, restart, or suggest restarting the Flask server** - It is already running and auto-restarts when changes are detected. You cannot access server logs of the running server. If you need output, ask the user to supply it.
- The UI name resolution system allows to lookup dom elements by a chain of nested "name" attribute. In the runtime, it is updated by calling updateUi() from ui.js. Then, elements can be referred to by ui.<top-level-name>.<next-level-name>.... etc. Each time a new element with a name is added to the DOM, `updateUi()` has to be called again. In code, this hierarchy has to be manually added by JSDoc/Typescript `@typedef` definitions in order to get autocompletion. TypeScript errors can indicate that such definitions haven't been added. If so, add them.
- For the moment, do not add API methods to the `@typedef` definitions used for documenting the named html elements hierarchy.

### Frontend Development
- **Shoelace Icon Resources**: When using Shoelace icons programmatically (via `icon` attribute or StatusText widget) where the literal `<sl-icon name="icon-name"></sl-icon>` is not present in the codebase, add a comment with the HTML literal to ensure the build system includes the icon resource: `// <sl-icon name="icon-name"></sl-icon>`. This is not needed when the icon tag already exists verbatim in templates or HTML.

## Browser Automation and Testing

### MCP Browser Integration
The application can be automated using MCP (Model Context Protocol) browser tools for testing and interaction:

- **Login credentials**: Use "user" / "user" for development testing
- **Session persistence**: Check `sessionStorage.getItem("pdf-tei-editor.state")` - if user property is not null, already logged in
- **Application URL**: `http://localhost:3001/index.html?dev` for development mode
- **Shoelace components**: The UI uses Shoelace web components (`@shoelace-style/shoelace`)
  - Form inputs are `<sl-input>` elements, not standard HTML `<input>`
  - Buttons are `<sl-button>` elements
  - Access form values via JavaScript: `document.querySelector('sl-input[name="username"]').value`
  - Login form elements: `sl-input[name="username"]` and `sl-input[name="password"]`
  - Login button: `sl-button[variant="primary"]` with text "Login"

### Browser Automation Best Practices
- Use JavaScript evaluation to interact with Shoelace components rather than standard form filling
- After successful login, application shows information dialog: "Load a PDF from the dropdown on the top left"
- Standard HTML selectors may not work with web components - use component-specific selectors
- **Console monitoring**: The application generates detailed debug logs visible in browser dev tools, including:
  - XML editor navigation issues (`navigatable-xmleditor.js`)
  - TEI validation performance and errors (`tei-validation.js`)
  - Application lifecycle events (`Logger.js`)
  - Heartbeat system for server communication

### Console Capture with MCP Browser
The MCP browser tools can programmatically capture console output for debugging:

```javascript
// Set up console capture (run immediately after page load)
window.consoleLogs = [];
const originalMethods = {};
['log', 'warn', 'error', 'info', 'debug'].forEach(level => {
  originalMethods[level] = console[level];
  console[level] = function(...args) {
    window.consoleLogs.push({
      level,
      timestamp: new Date().toISOString(),
      message: args.map(arg => 
        typeof arg === 'object' ? JSON.stringify(arg) : String(arg)
      ).join(' ')
    });
    originalMethods[level].apply(console, args);
  };
});
```

**Limitations:**
- ❌ Cannot read existing console history (messages logged before capture setup)
- ✅ Can capture new console messages after setup
- ✅ Successfully captures application messages like validation results, performance warnings
- ✅ Eliminates need to copy/paste console output from screenshots

**Typical captured messages:**
- `"Received validation results for document version 1: 3 errors."`
- `"Validation took 22 seconds, disabling it."`
- `"DEBUG Sending heartbeat to server to keep file lock alive"`