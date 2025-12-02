# Plugin System Architecture

This document provides a comprehensive technical overview of the plugin system architecture in the PDF-TEI Editor. For practical plugin development guidance, see the [Plugin Development Guide](../code-assistant/plugin-development.md) in the code-assistant documentation.

## Overview

The PDF-TEI Editor uses a sophisticated plugin-based architecture that supports both modern class-based plugins and legacy object-based plugins. The system provides:

- **Dependency resolution** - Automatic topological sorting ensures plugins load in correct order
- **Dual architecture** - Supports both Plugin classes and legacy plugin objects
- **Endpoint system** - Flexible extension points for plugin communication
- **Centralized management** - `PluginManager` handles registration and invocation
- **State orchestration** - `Application` class coordinates plugins with immutable state management

## Core Components

### PluginManager

The `PluginManager` ([app/src/modules/plugin-manager.js](../../app/src/modules/plugin-manager.js)) is responsible for:

- **Plugin registration** - Maintains registry of all plugins and their dependencies
- **Dependency resolution** - Uses topological sorting to determine load order
- **Endpoint invocation** - Orchestrates calls to plugin extension points
- **Cache management** - Optimizes endpoint lookups via caching

#### Key Features

**Dependency Resolution:**
```javascript
const manager = new PluginManager();

manager.register({
  name: 'logger',
  install() { /* ... */ }
});

manager.register({
  name: 'database',
  deps: ['logger'],  // Will load after logger
  install() { /* ... */ }
});

// Plugins invoked in dependency order: logger → database
await manager.invoke('install');
```

**Endpoint Invocation Modes:**

The manager supports flexible invocation patterns through flags and options:

- **No-Call Flag** (`!` prefix): Retrieve values without calling functions
  ```javascript
  const configs = await manager.invoke('!config.timeout');  // [undefined, 5000]
  ```

- **Throw Flag** (`!` suffix): Fail fast on errors
  ```javascript
  await manager.invoke('install!');  // Throws on first error
  ```

- **Execution Modes:**
  - `parallel` (default): All plugins execute concurrently
  - `sequential`: Plugins execute in dependency order, one at a time

- **Result Formats:**
  - `first`: Return first fulfilled value
  - `values`: Array of all fulfilled values
  - `full`: Complete `{status, value/reason}` objects

**Plugin Class Conversion:**

The manager automatically converts Plugin class instances into plugin configuration objects using the `getEndpoints()` method, allowing both patterns to coexist seamlessly.

### Plugin Base Class

The `Plugin` base class ([app/src/modules/plugin-base.js](../../app/src/modules/plugin-base.js)) provides:

- **Singleton pattern** - `createInstance()` and `getInstance()` ensure single instance per class
- **State management** - Internal state tracking and update methods
- **Lifecycle hooks** - Standard methods for install, start, shutdown
- **Endpoint mapping** - `getEndpoints()` method for flexible endpoint registration
- **Context access** - `PluginContext` provides controlled access to application services

#### Lifecycle Methods

```javascript
class MyPlugin extends Plugin {
  async install(initialState) {
    // Called during plugin registration
    // Setup UI, register templates
  }

  async initialize() {
    // Called after registration
    // Optional initialization logic
  }

  async start() {
    // Called when app starts
    // Begin plugin operations
  }

  async shutdown() {
    // Called on window.beforeunload
    // Cleanup resources
  }
}
```

#### State Management in Plugin Classes

Plugin classes get automatic state management through the base class:

```javascript
class MyPlugin extends Plugin {
  async onStateUpdate(changedKeys) {
    // React to state changes
    if (changedKeys.includes('user')) {
      this.updateUI();
    }
  }

  async handleAction() {
    // Dispatch state changes
    await this.dispatchStateChange({
      customProperty: 'value'
    });
  }

  get currentUser() {
    // Read-only state access
    return this.state.user;
  }
}
```

### PluginContext

The `PluginContext` ([app/src/modules/plugin-context.js](../../app/src/modules/plugin-context.js)) provides Plugin classes with controlled access to application services:

- `updateState(changes)` - Dispatch state changes
- `hasStateChanged(state, ...keys)` - Check if keys changed
- `getChangedStateKeys(state)` - Get all changed keys

This abstraction prevents direct access to the Application instance and enforces proper encapsulation.

### Application Orchestrator

The `Application` class ([app/src/app.js](../../app/src/app.js)) coordinates between plugins and state management:

- **Plugin registration** - Registers plugins with the PluginManager
- **State updates** - Orchestrates state changes through StateManager
- **Plugin notifications** - Notifies plugins of state changes via endpoints
- **Singleton API** - Exports singleton instance and plugin APIs

```javascript
// app.js simplified structure
export class Application {
  constructor() {
    this.pluginManager = new PluginManager();
    this.stateManager = new StateManager();
  }

  async updateState(changes) {
    // Update state immutably
    const newState = await this.stateManager.updateState(changes);

    // Notify plugins
    await this.pluginManager.invoke('updateInternalState', newState);
    const changedKeys = this.stateManager.getChangedKeys();
    await this.pluginManager.invoke('onStateUpdate', [changedKeys, newState]);

    return newState;
  }
}

// Export singleton API
export const app = Application.getInstance();
```

## Plugin Types

### Plugin Classes (Modern)

Plugin classes extend the `Plugin` base class and receive automatic state management:

```javascript
import { Plugin } from '../modules/plugin-base.js';

class MyPlugin extends Plugin {
  constructor(context) {
    super(context, {
      name: 'my-plugin',
      deps: ['dependency1']
    });
  }

  async install(state) {
    await super.install(state);
    // Setup UI
  }

  async onStateUpdate(changedKeys) {
    if (changedKeys.includes('user')) {
      this.updateUI();
    }
  }

  async handleClick() {
    await this.dispatchStateChange({
      customProperty: 'new value'
    });
  }

  getEndpoints() {
    return {
      ...super.getEndpoints(),
      'custom.action': this.handleCustomAction.bind(this)
    };
  }
}

export default MyPlugin;
```

**Benefits:**
- Automatic state management via `this.state`
- Built-in lifecycle methods
- Singleton pattern enforcement
- Clean endpoint registration

### Plugin Objects (Legacy)

Plugin objects are plain JavaScript objects compatible with the original implementation:

```javascript
import { updateState } from '../app.js';

let currentState;

async function onStateUpdate(changedKeys, state) {
  currentState = state;
  if (changedKeys.includes('user')) {
    // React to changes
  }
}

async function handleAction() {
  await updateState({ customProperty: 'new value' });
}

export const plugin = {
  name: 'my-plugin',
  deps: ['dependency1'],
  install: async (state) => { /* setup */ },
  onStateUpdate
};

export const api = {
  handleAction
};
```

**Characteristics:**
- Manual state management required
- Must track state in closures
- Simpler structure for basic plugins
- Backwards compatible

## Endpoint System

Endpoints are extension points where plugins can provide functionality. Defined in [app/src/endpoints.js](../../app/src/endpoints.js).

### Standard Lifecycle Endpoints

- `install` - Plugin initialization, receives initial state
- `start` - Application startup after all plugins installed
- `ready` - Deferred initialization after page load
- `shutdown` - Cleanup on application exit

### State Management Endpoints

- `updateInternalState` - Silent state sync for Plugin classes
- `onStateUpdate` - Reactive notifications with changed keys
- `state.update` - Legacy endpoint (deprecated)

### Custom Endpoints

Plugins can define custom endpoints for specialized functionality:

```javascript
// endpoints.js
const endpoints = {
  validation: {
    validate: "validation.validate",
    configure: "validation.configure",
    result: "validation.result"
  },
  log: {
    debug: "log.debug",
    info: "log.info",
    warn: "log.warn"
  }
}
```

Plugins expose custom endpoints via `getEndpoints()`:

```javascript
class ValidationPlugin extends Plugin {
  getEndpoints() {
    return {
      ...super.getEndpoints(),
      'validation.validate': this.validate.bind(this),
      'validation.configure': this.configure.bind(this)
    };
  }
}
```

Other plugins can invoke these endpoints:

```javascript
// Invoke validation from another plugin
await app.pluginManager.invoke('validation.validate', {
  type: 'xml',
  text: xmlContent
});
```

## Plugin Registration and Loading

### Registration in app.js

Plugins are registered in the plugins array in [app/src/app.js](../../app/src/app.js):

```javascript
// Import plugins
import MyPlugin from './plugins/my-plugin.js';
import { plugin as legacyPlugin, api as legacyApi } from './plugins/legacy.js';

// Register in array
const plugins = [
  MyPlugin,          // Plugin class - instantiated automatically
  legacyPlugin,      // Plugin object - used as-is
  // ...
];

// Export singleton APIs
export const myPlugin = MyPlugin.getInstance();
export { legacyApi };
```

### Loading Process

1. **Registration** - Plugins registered with PluginManager
2. **Dependency resolution** - Topological sort determines load order
3. **Instantiation** - Plugin classes instantiated via `createInstance()`
4. **Installation** - `install` endpoint invoked sequentially in dependency order
5. **Startup** - `start` endpoint invoked after all installations complete
6. **Ready** - `ready` endpoint invoked after initial page load

### Dependency Order Example

```javascript
const plugins = [
  configPlugin,        // No dependencies - loads first
  urlHashStatePlugin,  // deps: ['config']
  clientPlugin,        // deps: ['config']
  dialogPlugin,        // deps: ['config']
  validationPlugin,    // deps: ['dialog']
  // ...
];

// Resolved order:
// config → urlHashState, client, dialog → validation → ...
```

## State Management Integration

The plugin system is tightly integrated with immutable state management. See [state-management.md](state-management.md) for comprehensive state details.

### Key Principles

1. **Plugin endpoints are observers, not mutators**
   - Functions that receive state (like `onStateUpdate`) react to changes
   - They do not modify or return state objects

2. **State changes only in event handlers**
   - User events (button clicks) trigger state updates
   - Async operations (API responses) trigger state updates
   - Never update state inside `onStateUpdate`

3. **Immutable updates only**
   - Use `dispatchStateChange()` (Plugin classes) or `updateState()` (legacy)
   - Never mutate state properties directly

### State Update Flow

```
User Action → Event Handler → dispatchStateChange()
                                    ↓
                            Application.updateState()
                                    ↓
                            StateManager.updateState()
                                    ↓
                            New immutable state created
                                    ↓
                    Plugins notified via updateInternalState
                                    ↓
                    Plugins notified via onStateUpdate
                                    ↓
                            Plugins react and update UI
```

### Plugin-Specific State

Plugins store custom state in `state.ext` to avoid naming conflicts:

```javascript
class MyPlugin extends Plugin {
  async savePreferences(prefs) {
    await this.dispatchStateChange({
      ext: {
        [this.name]: { preferences: prefs }
      }
    });
  }

  get preferences() {
    return this.state?.ext?.[this.name]?.preferences || {};
  }
}
```

## Template Registration System

Plugins use a modern template registration system supporting both development and production modes. See [architecture.md](architecture.md#template-system) for details.

### Usage in Plugins

```javascript
import { registerTemplate, createSingleFromTemplate } from '../ui.js';

class MyPlugin extends Plugin {
  async install(state) {
    await super.install(state);

    // Register template (async, done once)
    await registerTemplate('my-template', 'my-template.html');

    // Create elements (synchronous)
    const element = createSingleFromTemplate('my-template');
    document.body.appendChild(element);
  }
}
```

**Key Points:**
- `registerTemplate()` is async, called during install
- `createSingleFromTemplate()` is synchronous, fast
- Templates support parameter substitution via `${param}` syntax
- Development mode loads from files, production from bundled JSON

## Memory Management

The plugin system implements several memory management strategies:

- **State history limit** - StateManager keeps only last 10 states
- **Endpoint cache** - PluginManager caches endpoint lookups, cleared on registration changes
- **Singleton instances** - Plugin class instances stored in WeakMap-style registry
- **Proper cleanup** - `shutdown` endpoint allows plugins to clean up resources

## Best Practices

### Plugin Design

- **Single responsibility** - Each plugin handles one feature or concern
- **Minimal dependencies** - Only depend on truly required plugins
- **Explicit endpoints** - Use `getEndpoints()` to document plugin capabilities
- **State extensions** - Use `state.ext[pluginName]` for plugin-specific state

### State Management

- **Never mutate** - Always use `dispatchStateChange()` or `updateState()`
- **React in onStateUpdate** - Use for UI updates and side effects
- **No updates in observers** - Never call state updates inside `onStateUpdate`
- **Check changes** - Use `changedKeys.includes()` to avoid unnecessary work

### Performance

- **Template registration** - Register templates during `install`, create during runtime
- **Conditional updates** - Only update UI for relevant state changes
- **Endpoint caching** - Trust the PluginManager's cache
- **Parallel invocation** - Default parallel mode is fastest for independent operations

## Migration from Legacy to Plugin Classes

To migrate a legacy plugin object to a Plugin class:

1. **Create class extending Plugin**
   ```javascript
   class MyPlugin extends Plugin {
     constructor(context) {
       super(context, { name: 'my-plugin', deps: [] });
     }
   }
   ```

2. **Move endpoint functions to methods**
   ```javascript
   async install(state) {
     await super.install(state);
     // Original install code
   }
   ```

3. **Replace manual state tracking**
   ```javascript
   // Before: let currentState;
   // After: this.state (automatic)
   ```

4. **Update state changes**
   ```javascript
   // Before: await updateState({ ... });
   // After: await this.dispatchStateChange({ ... });
   ```

5. **Implement getEndpoints() for custom endpoints**
   ```javascript
   getEndpoints() {
     return {
       ...super.getEndpoints(),
       'custom.action': this.handleAction.bind(this)
     };
   }
   ```

6. **Export class and update registration**
   ```javascript
   // plugins/my-plugin.js
   export default MyPlugin;

   // app.js
   import MyPlugin from './plugins/my-plugin.js';
   const plugins = [MyPlugin, ...];
   export const myPlugin = MyPlugin.getInstance();
   ```

## Related Documentation

- [Architecture Overview](architecture.md) - Complete system architecture
- [Plugin Development Guide](../code-assistant/plugin-development.md) - Practical plugin development
- [State Management](state-management.md) - Immutable state architecture
- [Coding Standards](../code-assistant/coding-standards.md) - Code quality requirements
