# Application Architecture

Quick reference for understanding the application structure.

For comprehensive architecture details, see [development/architecture.md](../development/architecture.md).

## Backend (Python/FastAPI)

- **Main application**: `fastapi_app/main.py` - FastAPI application with router registration
- **API routes**: `fastapi_app/routers/` - Each file defines route handlers (files_*.py, users.py, etc.)
- **Business logic**: `fastapi_app/lib/` - Server-side utilities and core logic
- **Data storage**: `data/` directory for PDFs and TEI/XML files
- **Configuration**: `config/` (defaults) and `data/db/` (runtime) for app settings and user data
- **Database**: `data/db/metadata.db` - SQLite database for file metadata

## Frontend (JavaScript/ES Modules)

- **Plugin architecture**: All functionality implemented as plugins in `app/src/plugins/`
- **Core files**:
  - `app/src/app.js` - Main application bootstrap and plugin registration
  - `app/src/endpoints.js` - Defines plugin extension points
  - `app/src/ui.js` - UI element management and DOM structure
  - `app/src/state.js` - Application state object definition
- **Templates**: `app/src/templates/` - HTML templates for UI components
- **Build output**: `app/web/` - Compiled/bundled frontend assets

## Plugin System

The application uses two independent plugin systems - one for frontend (JavaScript) and one for backend (Python). See [../development/plugin-system.md](../development/plugin-system.md) for overview.

### Frontend Plugins

Frontend plugins extend the browser UI using a class or object-based architecture with dependency resolution, state management, and lifecycle hooks.

For detailed information:
- [Frontend Plugin System Architecture](../development/plugin-system-frontend.md)
- [Frontend Plugin Development Guide](./plugin-development.md)

### Backend Plugins

Backend plugins provide server-side functionality and API endpoints with role-based access control.

For detailed information:
- [Backend Plugin System Architecture](../development/plugin-system-backend.md)
- [Backend Plugin Development Guide](./backend-plugins.md)

## UI Component System

The application uses a typed UI hierarchy system:

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

### Example

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

The application uses a modern template registration system supporting both development and production modes:

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

### Build System Integration

- **Development**: Templates loaded via fetch from `app/src/templates/`
- **Production**: `bin/bundle-templates.js` analyzes code and generates `templates.json`
- **Build process**: Template bundling runs automatically during `npm run build`
