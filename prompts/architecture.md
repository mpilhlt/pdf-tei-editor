# Application Architecture

## Backend (Python/Flask)

- **Main server**: `server/flask_app.py` - Flask application with dynamic blueprint registration
- **API routes**: `server/api/` - Each file defines a blueprint (auth.py, files.py, etc.)
- **Utilities**: `server/lib/` - Server-side utilities and helpers
- **Data storage**: `data/` directory for PDFs and TEI/XML files
- **Configuration**: `config/` and `db/` directories for app settings and user data

## Frontend (JavaScript/ES Modules)

- **Plugin architecture**: All functionality implemented as plugins in `app/src/plugins/`
- **Core files**:
  - `app/src/app.js` - Main application bootstrap and plugin registration
  - `app/src/endpoints.js` - Defines plugin extension points
  - `app/src/ui.js` - UI element management and DOM structure
- **Templates**: `app/src/templates/` - HTML templates for UI components
- **Build output**: `app/web/` - Compiled/bundled frontend assets

## Plugin System Architecture

The application uses a sophisticated dual-architecture plugin system supporting both legacy and modern patterns:

### Architecture Overview

- **Central Management**: `PluginManager` handles registration, dependency resolution, and endpoint invocation
- **State Orchestration**: `Application` class coordinates between plugins and state management
- **Immutable State**: All state updates create new objects, maintaining history for debugging
- **Dependency Resolution**: Automatic topological sorting ensures plugins load in correct order

### Plugin Types

**Plugin Objects**:

The object-based style is compatible with the original implementation of the plugin system. It is less involved, but requires manual management of state updates. The legacy endpoint "state.update" (with full state) is being migrated to the "onStateUpdate" endpoint which receives (changedKeys, fullState).

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

Plugin classes offer automatic state management (it can be accessed as the `state` property of the plugin)

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

### Plugin Endpoints System

Plugins expose functionality through endpoints defined in `endpoints.js`:

**Lifecycle Endpoints:**

- `install` - Plugin initialization and DOM setup
- `start` - Application startup after all plugins installed
- `shutdown` - Cleanup on application exit

**State Management Endpoints:**

- `state.update` - Deprecated: React to state changes (full state)
- `updateInternalState` - New: Silent state sync for Plugin classes
- `onStateUpdate` - New: Reactive notifications with changed keys and full state

**Custom Endpoints:**

- Plugin-specific endpoints should be exposed via `getEndpoints()` method

### Dual System Support

The system simultaneously supports both architectures:

1. **Legacy `state.update`** - Called with full state for backward compatibility
2. **New `updateInternalState`** - Silent state sync for Plugin instances
3. **New `onStateUpdate`** - Reactive notifications with changed properties

Plugin objects and PLugin classes both have their use cases:

- Plugin objects are great for simple plugins that do not need to expose an API, but are endpoint-centered. They need to manage state manually by listening to the `updateInternalState`
- Plugin classes are better for more complex plugins, which need to work alot with the application state and profit from the methods inherited from the plugin class.

### Migration Path

1. **Plugin Objects** → Continue working with BC wrappers but should be migrated to not use the `state-update` endpoint any more
2. **New Plugin Classes** → Gradual migration with full feature parity
3. **Singleton Pattern** → Plugin classes use `createInstance()`/`getInstance()`
4. **Controlled Access** → PluginContext facade limits plugin-application coupling
5. **Test Coverage** - Separate tests for legacy and new systems 


## UI Component System

The application uses a typed UI hierarchy system with the following rules:

### UI Part Naming Convention

- Each UI part typedef is called a "part" and follows camelCase naming
- Part names always end with "Part" (e.g., `toolbarPart`, `dialogPart`)
- Since UI parts represent singletons in the UI, they use lowercase naming

### UI Part Location and Documentation

- UI parts are defined in the plugin that uses/creates them
- Each part documents the named element hierarchy from its HTML templates
- UI parts use the `UIPart<T, N>` generic type that combines DOM element type `T` with navigation properties type `N`

### Type Usage Rules

- When a UI part property is a pure HTMLElement with no navigation properties, use the DOM element type directly
- When a UI part has child navigation properties, use `UIPart<DOMElementType, NavigationPropertiesType>`
- Elements serve as both DOM elements and navigation objects - no `self` property needed
- Access DOM methods directly: `ui.dialog.show()` instead of `ui.dialog.self.show()`

### Examples

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

## Template Registration System

The application uses a modern template registration system that supports both development and production modes:

### Overview

- **Development Mode** (`?dev` parameter): Templates loaded dynamically from files for fast iteration
- **Production Mode**: Templates bundled into `templates.json` for optimal performance
- **Synchronous Creation**: Templates pre-loaded during registration, creation is fast and synchronous
- **Parameter Substitution**: Support for `${param}` syntax in templates

### Basic Usage

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

### Template Registration Rules

1. **Import from ui.js**: Always import template functions from `../ui.js` (not ui-system.js directly)
2. **Register at module level**: Use `await registerTemplate()` at the top level of plugin files
3. **Synchronous creation**: Use `createFromTemplate()` or `createSingleFromTemplate()` in install functions
4. **Call updateUi() when needed**: If elements aren't automatically added to DOM with parent node

### Template Functions

- **`registerTemplate(id, path)`**: Pre-loads template content (async)
- **`createFromTemplate(id, parent?, params?)`**: Creates array of elements (sync)
- **`createSingleFromTemplate(id, parent?, params?)`**: Creates single element (sync)
- **`createHtmlElements()`**: Legacy function, still supported

### Parameter Substitution

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

### Build System Integration

- **Development**: Templates loaded via fetch from `app/src/templates/`
- **Production**: `bin/bundle-templates.js` analyzes code and generates `templates.json`
- **Build process**: Template bundling runs automatically during `npm run build`

### Migration from Plugin Objects to Plugin Classes

When converting existing plugins:

1. Replace `createHtmlElements` imports with template registration functions
2. Add `await registerTemplate()` calls at module level
3. Replace `(await createHtmlElements())[0]` with `createSingleFromTemplate()`
4. Update typedefs to remove `self` properties
5. Ensure `updateUi()` is called when needed

### Best Practices

- Use descriptive template IDs that match their purpose
- Keep templates in `app/src/templates/` directory
- Use `createSingleFromTemplate()` when you know template produces one element
- Always await template registration before using templates
- Import all UI functions from `ui.js` for consistency