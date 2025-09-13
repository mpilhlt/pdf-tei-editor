# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## General tone

- Don't be too congratulatory. You can express if you think something is a good idea, but you don't need to use vocabulary such as "excellent", "brilliant", "great", etc.
- If you think there might be a problem with the user's idea, push back. Don't assume the user's ideas are neccessarily correct. Ask if you should go with their idea, but also suggest alternatives.

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

# Run end-to-end tests in containerized environment
npm run test:e2e
npm run test:e2e:firefox    # Test with Firefox
npm run test:e2e:headed     # Show browser UI
npm run test:e2e:debug      # Debug mode
npm run test:e2e:backend    # Backend integration tests only

# Run smart test runner (selects tests based on file changes)
node tests/smart-test-runner.js --changed-files <files>

# The application includes XML validation through TEI schema validation
```

#### Testing Architecture

**Smart Test Runner**: Automatically selects relevant tests based on file dependencies using `@testCovers` annotations. Supports wildcard patterns like `@testCovers app/src/*` for frontend-wide coverage.

**End-to-End Tests**: Unified cross-platform E2E testing using Node.js runner (`tests/e2e-runner.js`) that handles both Playwright browser tests and backend integration tests. Features:
- **Containerized testing**: Docker/Podman with multi-stage builds and layer caching
- **Cross-platform support**: Works on Windows, macOS, and Linux (replaces Linux-only bash script)
- **Dual test modes**: Playwright browser tests (`--playwright` flag) and backend integration tests
- **Automatic cleanup**: Containers cleaned up, images preserved for cache efficiency
- **Environment variables**: `E2E_HOST`, `E2E_PORT`, `E2E_CONTAINER_PORT` for flexible configuration
- **Integration**: Works with smart test runner via `@testCovers` annotations

**UI Testing Guidelines**: E2E tests should use the UI navigation system exposed via `window.ui` (see `app/src/ui.js:103`) to efficiently access UI parts documented via JSDoc. This provides type-safe access to named DOM elements like `ui.toolbar.pdf`, `ui.dialog.message`, etc. For custom selectors, the navigation system helps identify paths to named descendants.

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

### Plugin System Architecture

The application uses a sophisticated dual-architecture plugin system supporting both legacy and modern patterns:

#### Architecture Overview

- **Central Management**: `PluginManager` handles registration, dependency resolution, and endpoint invocation
- **State Orchestration**: `Application` class coordinates between plugins and state management
- **Immutable State**: All state updates create new objects, maintaining history for debugging
- **Dependency Resolution**: Automatic topological sorting ensures plugins load in correct order

#### Plugin Types

**Plugin Objects**:

The object-based style is compatible with the original implementation of the plugin system. It is less involved, but requires manual management of state updates. The legacy enpoint "state.update" (with full state) is being migrated to the "onStateUpdate" endpoint which receives (changedKeys, fullState).

```javascript
const plugin = {
  name: "my-plugin",
  deps: ['dependency1'],
  install: async (state) => { /* setup UI */ },
  state: {
    update: async (state) => { /* react to changes */ }
  }
};
```

**Plugin Classes**:

Plugin classes offer automatic state management (it can be accesses as the `state` property of the plugin)

```javascript
class MyPlugin extends Plugin {
  constructor(context) {
    super(context, { name: 'my-plugin', deps: ['dependency1'] });
  }
  
  async install(state) { /* setup UI */ }
  async onStateUpdate(changedKeys, fullState) { /* reactive updates */ }
  async dispatchStateChange(changes) { /* trigger state updates */ }
}
```

#### Plugin Endpoints System

Plugins expose functionality through endpoints defined in `endpoints.js`:

**Lifecycle Endpoints:**

- `install` - Plugin initialization and DOM setup  
- `start` - Application startup after all plugins installed
- `shutdown` - Cleanup on application exit

**State Management Endpoints:**

- `state.update` - Legacy: React to state changes (full state)
- `updateInternalState` - New: Silent state sync for Plugin classes
- `onStateUpdate` - New: Reactive notifications with changed keys and full state

**Custom Endpoints:**

- `validation.validate` - XML/TEI validation
- `log.debug`, `log.info`, etc. - Logging system
- Plugin-specific endpoints via `getEndpoints()` method

#### State Management Integration

**Plugin Objects:**

This is the old way that should be migrated to use `onStateUpdate` instead

```javascript
import { updateState, hasStateChanged } from '../app.js';

let currentState

async function update(state) {
  currentState = state
}

async function someAction() {
  if (hasStateChanged(currentState, 'user')) {
    // React to user changes
  }
  await updateState({ pdf: 'new.pdf' });
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

#### Dual System Support

The system simultaneously supports both architectures:

1. **Legacy `state.update`** - Called with full state for backward compatibility
2. **New `updateInternalState`** - Silent state sync for Plugin instances  
3. **New `onStateUpdate`** - Reactive notifications with changed properties

#### Migration Path

1. **Legacy Plugin Objects** → Continue working with BC wrappers
2. **New Plugin Classes** → Gradual migration with full feature parity
3. **Singleton Pattern** → Plugin classes use `createInstance()`/`getInstance()`
4. **Controlled Access** → PluginContext facade limits plugin-application coupling
5. **Test Coverage** - Separate tests for legacy and new systems (legacy marked for removal)

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

### Template Registration System

The application uses a modern template registration system that supports both development and production modes:

#### Overview

- **Development Mode** (`?dev` parameter): Templates loaded dynamically from files for fast iteration
- **Production Mode**: Templates bundled into `templates.json` for optimal performance
- **Synchronous Creation**: Templates pre-loaded during registration, creation is fast and synchronous
- **Parameter Substitution**: Support for `${param}` syntax in templates

#### Basic Usage

```javascript
// In plugin files - register templates at module level
import { registerTemplate, createFromTemplate, createSingleFromTemplate } from '../ui.js';

// Register templates (async, happens at module load)
await registerTemplate('dialog-template', 'dialog.html');
await registerTemplate('button-template', 'button.html');

// Create elements in install() function (synchronous)
async function install(state) {
  // Create multiple elements
  const elements = createFromTemplate('dialog-template', document.body);
  
  // Create single element (no [0] suffix needed)
  const button = createSingleFromTemplate('button-template');
  
  // Parameter substitution
  const customButton = createSingleFromTemplate('button-template', null, {
    text: 'Save Document',
    variant: 'primary'
  });
}
```

#### Template Registration Rules

1. **Import from ui.js**: Always import template functions from `../ui.js` (not ui-system.js directly)
2. **Register at module level**: Use `await registerTemplate()` at the top level of plugin files
3. **Synchronous creation**: Use `createFromTemplate()` or `createSingleFromTemplate()` in install functions
4. **Call updateUi() when needed**: If elements aren't automatically added to DOM with parent node

#### Template Functions

- **`registerTemplate(id, path)`**: Pre-loads template content (async)
- **`createFromTemplate(id, parent?, params?)`**: Creates array of elements (sync)
- **`createSingleFromTemplate(id, parent?, params?)`**: Creates single element (sync)
- **`createHtmlElements()`**: Legacy function, still supported

#### Parameter Substitution

Templates support `${param}` syntax for dynamic content:

```html
<!-- Template file: button.html -->
<sl-button variant="${variant}" size="${size}">${text}</sl-button>
```

```javascript
// Usage with parameters
const saveBtn = createSingleFromTemplate('button', null, {
  variant: 'primary',
  size: 'small',
  text: 'Save Document'
});
```

#### Build System Integration

- **Development**: Templates loaded via fetch from `app/src/templates/`
- **Production**: `bin/bundle-templates.js` analyzes code and generates `templates.json`
- **Build process**: Template bundling runs automatically during `npm run build`

#### Migration from Legacy System

When converting existing plugins:

1. Replace `createHtmlElements` imports with template registration functions
2. Add `await registerTemplate()` calls at module level
3. Replace `(await createHtmlElements())[0]` with `createSingleFromTemplate()`
4. Update typedefs to remove `self` properties
5. Ensure `updateUi()` is called when needed

#### Best Practices

- Use descriptive template IDs that match their purpose
- Keep templates in `app/src/templates/` directory
- Use `createSingleFromTemplate()` when you know template produces one element
- Always await template registration before using templates
- Import all UI functions from `ui.js` for consistency

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

- **Shoelace Component Registration**: When using new Shoelace components, ensure they are properly imported and exported in `app/src/ui.js`. Components not properly registered will have `visibility: hidden` due to the `:not(:defined)` CSS rule. Example: if using `sl-tree-item`, import `SlTreeItem` from `@shoelace-style/shoelace/dist/components/tree-item/tree-item.js` and add it to the export list. This is critical for proper component rendering.
- **Shoelace Icon Resources**: When using Shoelace icons programmatically (via `icon` attribute or StatusText widget) where the literal `<sl-icon name="icon-name"></sl-icon>` is not present in the codebase, add a comment with the HTML literal to ensure the build system includes the icon resource: `// <sl-icon name="icon-name"></sl-icon>`. This is not needed when the icon tag already exists verbatim in templates or HTML.
- **Debug Logging**: When adding temporary debug statements, use `console.log("DEBUG ...")` instead of `logger.debug()`. Always prefix the message with "DEBUG" to make them easily searchable and removable. Example: `console.log("DEBUG Collection in options:", options.collection);`. This allows easy filtering with browser dev tools and quick cleanup using search/replace.

### Plugin Development Guidelines

#### Creating New Plugin Classes

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

#### Plugin Registration in app.js

```javascript
// Import Plugin class
import MyPlugin from './plugins/my-plugin.js';

// Add to plugins array
const plugins = [
  MyPlugin,  // Plugin class - will be instantiated automatically
  legacyPluginObject,  // Legacy object - used as-is
  // ...
];

// Export singleton API (after registration)
export const myPlugin = MyPlugin.getInstance();
```

#### State Management in Plugins

- **Never mutate state directly** - always use `dispatchStateChange()`
- **Use `onStateUpdate()` for reactions** - more efficient than legacy `state.update`
- **Access current state via `this.state`** - read-only property
- **Store plugin-specific state in `state.ext`** - avoids naming conflicts
- **Use `hasStateChanged()` for conditional logic** - available via PluginContext

#### Common Patterns

```javascript
// Conditional state updates
async onStateUpdate(changedKeys) {
  if (changedKeys.includes('user') && this.state.user) {
    await this.setupUserUI();
  }
}

// Plugin-specific state
async savePreferences(prefs) {
  await this.dispatchStateChange({
    ext: { 
      [this.name]: { preferences: prefs }
    }
  });
}

// Accessing plugin-specific state  
get preferences() {
  return this.state?.ext?.[this.name]?.preferences || {};
}
```

### State Management

The application uses **immutable state management** with functional programming principles:

#### Core Concepts

- **Immutable Updates**: Each state change creates a new state object, preserving the previous state
- **State History**: The system maintains a history of the last 10 states for debugging and potential undo functionality
- **Change Detection**: Plugins use `hasStateChanged()` instead of manual caching to detect state changes
- **State Snapshots**: Plugins receive immutable state snapshots via function parameters, never import the global state

#### State Management Architecture

State is managed through the `StateManager` class and `Application` orchestrator:

```javascript
// Legacy plugins - BC wrappers in app.js (UPDATED API)
import { updateState, hasStateChanged } from '../app.js';
await updateState({ pdf: 'new-file.pdf', xml: 'new-file.xml' }) // Note: No currentState parameter

// New Plugin classes - via PluginContext
class MyPlugin extends Plugin {
  async someAction() {
    // Dispatch state changes through context
    await this.dispatchStateChange({ pdf: 'new-file.pdf' });
    
    // Check if properties changed (in onStateUpdate)
    if (changedKeys.includes('user')) {
      // Handle changes
    }
    
    // Access current state
    const user = this.state.user;
    
    // Plugin-specific state via extensions
    await this.dispatchStateChange({
      ext: { [this.name]: { customData: 'value' } }
    });
  }
  
  async onStateUpdate(changedKeys) {
    // Reactive updates when state changes
    if (changedKeys.includes('user')) {
      this.handleUserChange();
    }
  }
}
```

**Key Components:**

- `StateManager` - Handles immutable state updates, change detection, history
- `Application.updateState(changes)` - Orchestrates state changes and plugin notifications (single parameter API)
- `PluginContext` - Provides controlled access to state utilities for Plugin classes
- Legacy BC wrappers - `updateState(changes)` and `hasStateChanged()` exported from app.js (updated to single parameter)

#### Plugin State Handling Best Practices

1. **Never import global state**: Plugins should only work with state parameters passed to functions
2. **Use hasStateChanged()**: Replace manual state caching with `hasStateChanged(state, 'property')`
3. **Local storage when needed**: Store local copies only for operations that need them (e.g., API requests)
4. **Access previous state**: Use `state.previousState` to compare with previous values
5. **Use state.ext for plugin-specific state**: Store plugin-specific state in `state.ext` to avoid TypeScript errors
6. **Use updateStateExt()**: For updating extension properties immutably

#### Memory Management

- State history is automatically limited to 10 entries to prevent memory leaks
- Older states are garbage collected when the limit is exceeded
- The `previousState` chain is properly broken to allow garbage collection

#### State Architecture Principles

- **Plugin endpoints are reactive observers, not state mutators**: Plugin `update()` functions receive immutable state snapshots and react to changes by updating UI or internal plugin state. They do not return modified state objects.
- **Only state utilities create new state objects**: Functions like `updateState()` and `updateStateExt()` are responsible for creating new immutable state objects. Plugin endpoints observe and react to state changes.
- **Parallel plugin execution**: Since plugins don't mutate state, multiple plugins can process the same state snapshot concurrently without conflicts.
- **State initialization is sequential**: During app initialization, state operations are chained sequentially to build up the initial state before plugins start reacting to changes.
- **CRITICAL: Never call updateState() in state.update endpoints**: Plugin `update()` functions must never call `updateState()` as this creates infinite loops. They are observers/reactors, not mutators. Consider them "observe" functions rather than "update" functions.
- **State mutation only in event handlers**: Only user event handlers (like button clicks) and async operations (like API responses) should call `updateState()`. The `update()` endpoints should only react to state changes, never create them.
- **Event handlers must use current state**: Event handlers registered during plugin installation receive stale state references. Store the current state in a plugin variable (updated in the `update()` method) and use that in event handlers instead of the installation-time state parameter.

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
