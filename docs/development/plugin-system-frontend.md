# Frontend Plugin System Architecture

This document provides a comprehensive technical overview of the frontend plugin system architecture in the PDF-TEI Editor. For practical plugin development guidance, see the [Plugin Development Guide](../code-assistant/plugin-development.md) in the code-assistant documentation.

## Overview

The PDF-TEI Editor uses a plugin-based architecture that supports both class-based plugins and object-based plugins. The system provides:

- **Dependency resolution** - Automatic topological sorting ensures plugins load in correct order
- **Dual architecture** - Supports both Plugin classes and object-based plugin descriptors
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

The `Plugin` base class ([app/src/modules/plugin-base.js](../../app/src/modules/plugin-base.js)) is implemented on top of the object-based plugin pattern. It converts a class instance into a plugin descriptor object by auto-mounting class methods as extension points via `getExtensionPoints()`.

**Auto-mounted extension points** — methods recognized by name convention, no declaration needed:

- Lifecycle methods: `install`, `ready`, `start`, `shutdown`, `updateInternalState`, `onStateUpdate`
- Per-key state handlers: any method matching `on<Key>Change` (e.g. `onXmlChange` → `onStateUpdate.xml`)

**Manually mounted extension points** — require explicit registration:

- `static extensionPoints = [ep.path]` with `get [ep.path]() { return fn }` — computed getter; key is the full EP path string, conflict-free (primary pattern)
- `static extensionPoints = ['ns.method']` with `this.method()` — deprecated fallback; last path segment maps to a method name, can conflict if two EPs share the same last segment
- `getExtensionPoints()` override — for arbitrary path→function mappings

See [plugin-communication.md](../code-assistant/plugin-communication.md) for when and how to use each mechanism.

Additional features:

- **Singleton pattern** — `createInstance()` and `getInstance()` ensure one instance per class
- **State management** — `this.state` (read-only), `this.dispatchStateChange()`, `this.hasStateChanged()`
- **Context access** — `PluginContext` provides controlled access to application services
- **Dependency injection** — `getDependency(name)` returns another plugin's public API

Use private getter properties to access dependencies lazily rather than assigning them in the constructor. This avoids circular dependency issues and keeps `deps` declarations minimal:

```javascript
class MyPlugin extends Plugin {
  // Resolved at call time — no constructor assignment, no deps entry needed
  // unless the dependency must be installed before this plugin's install() runs
  get #logger()    { return this.getDependency('logger') }
  get #xmlEditor() { return this.getDependency('xmleditor') }

  async someAction() {
    this.#logger.debug('action triggered')
    const tree = this.#xmlEditor.getXmlTree()
  }
}
```

Only add a plugin to `deps` when it must be fully installed before this plugin's own `install()` runs.

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
  async onStateUpdate(changedKeys, state) {
    // Catch-all: called on every state change
    if (changedKeys.includes('user')) {
      this.updateUI();
    }
  }

  async handleAction() {
    await this.dispatchStateChange({ customProperty: 'value' });
  }

  get currentUser() {
    return this.state.user;  // read-only
  }
}
```

#### Per-Key State Handlers (`on<Key>Change`)

Instead of a catch-all `onStateUpdate`, declare methods named `on<Key>Change` where `Key` is the state property name with the first letter capitalized. The base class auto-discovers these and registers them as `onStateUpdate.<key>` extension points, so they are called only when that specific key changes.

```javascript
class MyPlugin extends Plugin {
  // Called only when state.xml changes
  async onXmlChange(newXml, prevXml) { ... }

  // Called only when state.user changes
  async onUserChange(newUser, prevUser) { ... }

  // Called only when state.sessionId changes
  async onSessionIdChange(newId, prevId) { ... }
}
```

Naming: `on` + state key with first letter uppercased + `Change` (e.g. `state.editorReadOnly` → `onEditorReadOnlyChange`).

Per-key handlers receive `(newValue, prevValue)`. Use `this.state` to access other state properties. Both `on<Key>Change` methods and `onStateUpdate` can coexist in the same class.

#### Custom Extension Points

Use a computed property getter with the full EP path as the key (primary pattern):

```javascript
import ep from '../extension-points.js'

class MyPlugin extends Plugin {
  static extensionPoints = [ep.toolbar.contentItems]

  get [ep.toolbar.contentItems]() {
    return () => [{ element: this.#ui, priority: 5, position: 'center' }]
  }
}
```

For one-off extension points, override `getExtensionPoints()`:

```javascript
getExtensionPoints() {
  return {
    ...super.getExtensionPoints(),
    'filedata.loading': this.setLoadingState.bind(this)
  }
}
```

See [plugin-communication.md](../code-assistant/plugin-communication.md) for the full pattern, including how the host plugin invokes contributions.

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

### Plugin Classes

Plugin classes extend the `Plugin` base class and receive automatic state management:

```javascript
import Plugin from '../modules/plugin-base.js';

class MyPlugin extends Plugin {
  constructor(context) {
    super(context, {
      name: 'my-plugin',
      deps: ['dependency1']
    });
  }

  /**
   * @param {ApplicationState} state
   */
  async install(state) {
    await super.install(state);
    // Setup UI
  }

  /**
   * @param {(keyof ApplicationState)[]} changedKeys
   * @param {ApplicationState} state
   */
  async onStateUpdate(changedKeys, state) {
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

**Features:**

- Automatic state management via `this.state`
- Built-in lifecycle methods
- Singleton pattern: `MyPlugin.getInstance()`
- Auto-discovered change handlers: `onXmlChange(newVal, prevVal)` for any state key
- `getDependency(name)` for runtime access to other plugins' APIs

### Plugin Objects

Plugin objects are plain JavaScript descriptors that the system uses directly. The class-based `Plugin` class is implemented on top of this primitive pattern. If you need to understand the lower-level mechanics or work with object-based plugins directly, see [Object-Based Plugin Pattern](plugin-system-object-based.md).

```javascript
import { updateState } from '../app.js';

let currentState;

/**
 * @param {String[]} changedKeys
 * @param {ApplicationState} state
 */
async function onStateUpdate(changedKeys, state) {
  currentState = state;
  if (changedKeys.includes('user')) {
    // React to changes
  }
}

async function handleAction() {
  await updateState({ customProperty: 'new value' });
}

export const api = { handleAction };

export const plugin = {
  name: 'my-plugin',
  deps: ['dependency1'],
  api,
  install: async (state) => { /* setup */ },
  onStateUpdate
};

export default plugin;
```

**Characteristics:**

- Manual state management — track state in a closure variable
- The `api` field is what `getDependency('my-plugin')` returns in other plugins
- Extension point paths map to nested object properties (`state.update` → `plugin.state.update`)

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

### Registration Flow

Plugins are collected in `app/src/plugins.js`, which is the central registry:

```javascript
// app/src/plugins.js

// Class-based plugins — imported from plugin-registry.js (auto-generated)
import { MyPlugin } from './plugin-registry.js';

// Object-based plugins — imported directly
import myObjectPlugin from './plugins/my-object-plugin.js';

const plugins = [
  MyPlugin,          // Plugin class — instantiated automatically
  myObjectPlugin,    // Plugin object — used as-is
  // ...
];

export default plugins;

// Export singleton APIs for cross-plugin access
export const myPlugin = MyPlugin.getInstance();
```

To add a new class-based plugin:

1. Create `app/src/plugins/my-plugin.js` with the class
2. Run `node bin/build.js --steps=plugins` to add it to `plugin-registry.js`
3. Import from `./plugin-registry.js` and add to the `plugins` array in `plugins.js`

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

The plugin system is tightly integrated with immutable state management. See [state-management.md](state-management.md) for comprehensive state details, and [plugin-communication.md](../code-assistant/plugin-communication.md) for when to use state propagation vs. other inter-plugin mechanisms.

### Key Principles

- `onStateUpdate` and `on<Key>Change` handlers are **observers** — they react to state but never call `dispatchStateChange` themselves (creates infinite loops)
- State changes only from event handlers or async operations (API responses, timers)
- Use `dispatchStateChange()` in Plugin classes, `updateState()` in object-based plugins
- Store plugin-specific data in `state.ext[this.name]` to avoid key collisions

### State Update Flow

```text
Event Handler → dispatchStateChange()
                      ↓
              Application.updateState()
                      ↓
              New immutable state created
                      ↓
              Plugins notified via onStateUpdate / on<Key>Change
                      ↓
              Plugins update UI
```

## Template Registration System

Plugins use a template registration system supporting both development and production modes. See [architecture.md](architecture.md#template-system) for details.

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

See [plugin-communication.md](../code-assistant/plugin-communication.md) for the full state propagation pattern and decision guide.

- Never mutate — use `dispatchStateChange()` or `updateState()`
- Never call state updates inside `onStateUpdate` — use `on<Key>Change` handlers for reactive UI updates
- Use `changedKeys.includes()` in catch-all `onStateUpdate` to avoid unnecessary work

### Performance

- **Template registration** - Register templates during `install`, create during runtime
- **Conditional updates** - Only update UI for relevant state changes
- **Endpoint caching** - Trust the PluginManager's cache
- **Parallel invocation** - Default parallel mode is fastest for independent operations

## Migrating Object-Based Plugins to Class-Based

To convert an object-based plugin to a Plugin class:

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

   // Run build step, then update plugins.js:
   import { MyPlugin } from './plugin-registry.js';
   const plugins = [MyPlugin, ...];
   export const myPlugin = MyPlugin.getInstance();
   ```

## Related Documentation

- [Plugin System Overview](plugin-system.md) - Overview of frontend and backend plugin systems
- [Object-Based Plugin Pattern](plugin-system-object-based.md) - Underlying primitive pattern
- [Backend Plugin System](plugin-system-backend.md) - Backend plugin architecture
- [Architecture Overview](architecture.md) - Complete system architecture
- [Plugin Development Guide](../code-assistant/plugin-development.md) - Practical plugin development
- [Inter-Plugin Communication](../code-assistant/plugin-communication.md) - State, extension points, getDependency — when to use each
- [State Management](state-management.md) - Immutable state architecture
- [Coding Standards](../code-assistant/coding-standards.md) - Code quality requirements
