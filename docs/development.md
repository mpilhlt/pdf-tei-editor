# Development Guide

This guide covers the application architecture, development workflow, and best practices for contributing to the PDF-TEI Editor.

## Application Architecture

The PDF-TEI Editor uses a **plugin-based architecture** with immutable state management and reactive updates.

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

### Key Technologies

- **Backend**: Flask, Python 3.13+, uv for dependency management
- **Frontend**: ES6 modules, CodeMirror 6, PDF.js, Shoelace UI components
- **Build**: Rollup for bundling, importmap for development
- **Schema validation**: TEI/XML schema validation with RelaxNG

## Plugin System Architecture

The application uses a sophisticated dual-architecture plugin system supporting both legacy and modern patterns.

### Architecture Overview

- **Central Management**: `PluginManager` handles registration, dependency resolution, and endpoint invocation
- **State Orchestration**: `Application` class coordinates between plugins and state management
- **Immutable State**: All state updates create new objects, maintaining history for debugging
- **Dependency Resolution**: Automatic topological sorting ensures plugins load in correct order

### Plugin Types

**Plugin Objects**:

The object-based style is compatible with the original implementation of the plugin system. It is less involved, but requires manual management of state updates.

```javascript
import { app } from '../app.js';

const plugin = {
  name: "my-plugin",
  deps: ['dependency1'],
  install,
  onStateUpdate
};

function install(initialState) {
  // ... setup UI
}

let currentState
async function onStateUpdate(changes, state) {
  currentState = state
  // ... react to state changes
}


// Use app API for state changes
async function handleEvent() {
  await app.updateState({ someProperty: 'new value' });
}
```

**Plugin Classes**:

Plugin classes offer automatic state management (it can be accesses as the `state` property of the plugin).

```javascript
class MyPlugin extends Plugin {
  constructor(context) {
    super(context, { name: 'my-plugin', deps: ['dependency1'] });
  }
  
  async install(initialState) { /* setup UI */ }
  async onStateUpdate(changedKeys, fullState) { /* reactive updates */ }
  async dispatchStateChange(changes) { /* trigger state updates */ }
}
```

### Plugin Endpoints System

Plugins expose functionality through endpoints defined in `endpoints.js`:

**Lifecycle Endpoints:**

- `install` - Plugin initialization and DOM setup  
- `start` - Application startup after all plugins installed
- `shutdown` - Cleanup on application exit

**State Management Endpoints:**

- `updateInternalState` - Plugin Classes: Silent state sync for Plugin classes
- `onStateUpdate` - Plugin Classes: Reactive notifications with changed keys

**Custom Endpoints:**

- `validation.validate` - XML/TEI validation
- `log.debug`, `log.info`, etc. - Logging system
- Plugin-specific endpoints via `getEndpoints()` method

## State Management

The application uses **immutable state management** with functional programming principles:

### Core Concepts

- **Immutable Updates**: Each state change creates a new state object, preserving the previous state
- **State History**: The system maintains a history of the last 10 states for debugging and potential undo functionality
- **Change Detection**: Plugins use `hasStateChanged()` instead of manual caching to detect state changes
- **State Snapshots**: Plugins receive immutable state snapshots via function parameters

### State Management Integration

**Plugin Objects:**

```javascript
import { app, hasStateChanged } from '../app.js';

async function someAction(currentState) {
  if (hasStateChanged(currentState, 'user')) {
    // React to user changes
  }
  await app.updateState({ pdf: 'new.pdf' });
}
```

**Plugin Classes:**

```javascript
class MyPlugin extends Plugin {
  async onStateUpdate(changedKeys) {
    if (changedKeys.includes('user')) {
      // React to user changes
    }
  }
  
  async someAction() {
    await this.dispatchStateChange({ pdf: 'new.pdf' });
  }
}
```

## UI Component System

The application uses a typed UI hierarchy system with specific naming and documentation conventions.

### UI Part Naming Convention

- Each UI part typedef follows camelCase naming ending with "Part" (e.g., `toolbarPart`, `dialogPart`)
- UI parts represent singletons in the UI using lowercase naming
- Parts are defined in the plugin that uses/creates them

### UI Part Documentation

UI parts use the `UIPart<T, N>` generic type combining DOM element type `T` with navigation properties type `N`:

```javascript
/**
 * @typedef {object} dialogPart  
 * @property {HTMLSpanElement} message - Direct DOM element (no navigation)
 * @property {SlButton} closeBtn - Direct DOM element (no navigation)
 */

/**
 * @typedef {object} namedElementsTree
 * @property {UIPart<SlDialog, dialogPart>} dialog - Dialog with navigation properties
 */

// Usage in code
ui.dialog.show()                    // Call DOM method directly
ui.dialog.message.innerHTML = text  // Access child element
```

## Template Registration System

The application uses a modern template registration system supporting both development and production modes.

### Overview

- **Development Mode** (`?dev` parameter): Templates loaded dynamically from files for fast iteration
- **Production Mode**: Templates bundled into `templates.json` for optimal performance
- **Synchronous Creation**: Templates pre-loaded during registration, creation is fast and synchronous
- **Parameter Substitution**: Support for `${param}` syntax in templates

### Basic Usage

```javascript
// Register templates at module level
import { registerTemplate, createFromTemplate, createSingleFromTemplate } from '../ui.js';

await registerTemplate('dialog-template', 'dialog.html');
await registerTemplate('button-template', 'button.html');

// Create elements synchronously in install functions
async function install(state) {
  // Create single element (no [0] suffix needed)
  const button = createSingleFromTemplate('button-template');
  
  // Create with parameters
  const customButton = createSingleFromTemplate('button-template', null, {
    text: 'Save Document',
    variant: 'primary'
  });
}
```

## Development Workflow

### Frontend Development

1. **Live Development**: Edit files in `app/src/`, test with `?dev` URL parameter
2. **No Rebuild Required**: The importmap loads source files directly in development mode
3. **Auto-reload**: Flask development server detects backend changes automatically
4. **Building**: Only needed for production, handled by pre-push git hooks

### Backend Development

1. **Auto-restart**: Flask server automatically restarts on backend changes
2. **No Manual Restart**: Never manually restart the development server
3. **Logging**: Development server uses colorized logging for better visibility

### Key Commands

```bash
# Development server (auto-reloads on changes)
./bin/server

# Build for production
npm run build

# Update import map after NPM changes
npm run update-importmap

# Run tests
npm test
```

### Important File Paths

- Entry point: `app/src/app.js`
- Plugin registration: Plugins array in `app/src/app.js:71-76`
- Server startup: `bin/server`
- Build script: `bin/build`

## Plugin Development Guidelines

### Creating New Plugin Classes

```javascript
import { Plugin } from '../modules/plugin-base.js';
import { registerTemplate, createSingleFromTemplate } from '../ui.js';

class MyPlugin extends Plugin {
  constructor(context) {
    super(context, { 
      name: 'my-plugin',
      deps: ['dependency1', 'dependency2'] 
    });
  }

  async install(state) {
    // Call parent to set initial state
    await super.install(state);
    
    // Create UI elements
    await registerTemplate('my-template', 'my-template.html');
    const element = createSingleFromTemplate('my-template');
    document.body.appendChild(element);
    
    // Set up event handlers
    element.addEventListener('click', () => {
      this.handleClick();
    });
  }

  async onStateUpdate(changedKeys) {
    // React to specific state changes
    if (changedKeys.includes('user')) {
      this.updateUI();
    }
  }

  async handleClick() {
    // Dispatch state changes
    await this.dispatchStateChange({ 
      customProperty: 'new value' 
    });
  }

  // Override to expose custom endpoints
  getEndpoints() {
    return {
      ...super.getEndpoints(),
      'custom.action': this.handleCustomAction.bind(this)
    };
  }
}

export default MyPlugin;
```

### Plugin Registration in app.js

```javascript
// Import Plugin class
import MyPlugin from './plugins/my-plugin.js';

// Add to plugins array
const plugins = [
  MyPlugin,  // Plugin class - will be instantiated automatically
  pluginObject,  // Plugin object - used as-is
  // ...
];

// Export singleton API (after registration)
export const myPlugin = MyPlugin.getInstance();
```

## Best Practices and Code Conventions

### Frontend Development

- **Shoelace Component Registration**: When using new Shoelace components, ensure they are properly imported and exported in `app/src/ui.js`
- **Debug Logging**: Use `console.log("DEBUG ...")` for temporary debug statements, prefixed with "DEBUG" for easy removal
- **Template Registration**: Import all UI functions from `ui.js` for consistency

### Python Development

- Always prefer `pathlib Path().as_posix()` over manual path concatenation
- **Never restart** the Flask server - it auto-restarts on changes
- Call `updateUi()` when adding new named elements to DOM

### State Management Best Practices

1. **Never mutate state directly** - always use `dispatchStateChange()` (Plugin Classes) or `app.updateState()` (Plugin Objects)
2. **Use `onStateUpdate()` for reactions** 
3. **Access current state via `this.state`** - read-only property
4. **Store plugin-specific state in `state.ext`** - avoids naming conflicts
5. **Never call updateState() in state update endpoints** - this will raise an exception


## Git Hooks Setup

The project uses a "pre-push" git hook via [Husky](https://typicode.github.io/husky/).

```bash
npx husky init
mkdir -p ~/.config/husky/ && echo "source .venv/bin/activate" > ~/.config/husky/init.sh && chmod +x ~/.config/husky/init.sh
```

## Related Documentation

- [Installation Guide](installation.md) - Setup and installation instructions
- [Deployment Guide](deployment.md) - Production and containerized deployment
- [User Management](user-management.md) - Authentication and user handling
- [XML Validation](xml-validation.md) - Schema validation system
- [Testing Guide](testing.md) - Comprehensive testing infrastructure
