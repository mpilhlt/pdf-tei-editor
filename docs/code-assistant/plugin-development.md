# Frontend Plugin Development Guide

Guide for creating and working with **frontend plugins** in the PDF-TEI Editor.

**Note**: This guide covers **frontend plugins** (JavaScript/TypeScript code running in the browser). For **backend plugins** (Python code running on the server), see [backend-plugins.md](./backend-plugins.md).

**Key Differences**:
- **Frontend plugins**: JavaScript classes in `app/src/plugins/` that extend the UI and handle client-side logic
- **Backend plugins**: Python modules in `fastapi_app/plugins/` that provide server-side functionality and API endpoints

For detailed frontend plugin architecture, see [../development/plugin-system-frontend.md](../development/plugin-system-frontend.md).

## Creating New Plugin Classes

```javascript
import Plugin from '../modules/plugin-base.js';
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

    // Register templates at install time
    await registerTemplate('my-template', 'my-template.html');
    const element = createSingleFromTemplate('my-template');
    document.body.appendChild(element);

    // Set up event handlers
    element.addEventListener('click', () => {
      this.handleClick();
    });
  }

  async onStateUpdate(changedKeys, state) {
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

  // Per-key state handler: called only when state.user changes
  // Named on<Key>Change where Key is the capitalized state property name
  async onUserChange(newUser, prevUser) {
    this.updateUI();
  }

  // Register a custom extension point via static declaration
  static extensionPoints = ['custom.action'];

  async action() { /* ... */ }
}

export default MyPlugin;
```

## Plugin Registration

After creating a plugin class:

1. Run `node bin/build.js --steps=plugins` — this adds the class to `app/src/plugin-registry.js`
2. In `app/src/plugins.js`, import the class from `./plugin-registry.js` and add it to the `plugins` array

```javascript
// app/src/plugins.js
import { MyPlugin } from './plugin-registry.js';

const plugins = [
  MyPlugin,  // Plugin class — instantiated automatically
  // ...
];
```

If the plugin's API needs to be accessible to other modules, also export the singleton from `plugins.js`:

```javascript
export const myPlugin = MyPlugin.getInstance();
```

## State Management in Plugins

The application uses **immutable state management** with functional programming principles.

### Core Rules

- **Never mutate state directly** — always use `dispatchStateChange()`
- **Use `onStateUpdate()` for reactions** — react to state changes in this method
- **Access current state via `this.state`** — read-only property
- **Store plugin-specific state in `state.ext`** — avoids naming conflicts

### State Management Architecture

```javascript
class MyPlugin extends Plugin {
  async someAction() {
    // Dispatch state changes through context
    await this.dispatchStateChange({ pdf: 'new-file.pdf' });

    // Access current state
    const user = this.state.user;

    // Plugin-specific state via extensions
    await this.dispatchStateChange({
      ext: { [this.name]: { customData: 'value' } }
    });
  }

  async onStateUpdate(changedKeys, state) {
    // Reactive updates when state changes
    if (changedKeys.includes('user')) {
      this.handleUserChange();
    }
  }
}
```

**Key Components:**

- `StateManager` — Handles immutable state updates, change detection, history
- `Application.updateState(changes)` — Orchestrates state changes and plugin notifications
- `PluginContext` — Provides controlled access to state utilities for Plugin classes

### Plugin State Handling Best Practices

1. **Never import global state**: Plugins should only work with state parameters passed to functions
2. **Use changedKeys.includes()**: Replace manual state caching with key checks in `onStateUpdate`
3. **Local storage when needed**: Store local copies only for operations that need them (e.g., API requests)
4. **Access previous state**: Use `state.previousState` to compare with previous values
5. **Use state.ext for plugin-specific state**: Store plugin-specific state in `state.ext` to avoid naming conflicts

### State Architecture Principles

- **Plugin endpoints are reactive observers, not state mutators**: Plugin `onStateUpdate()` functions receive immutable state snapshots and react to changes by updating UI or internal plugin state. They do not return modified state objects.
- **Only state utilities create new state objects**: Functions like `dispatchStateChange()` and `updateState()` are responsible for creating new immutable state objects. Plugin endpoints observe and react to state changes.
- **Parallel plugin execution**: Since plugins don't mutate state, multiple plugins can process the same state snapshot concurrently without conflicts.
- **State initialization is sequential**: During app initialization, state operations are chained sequentially to build up the initial state before plugins start reacting to changes.
- **CRITICAL: Never call dispatchStateChange() in onStateUpdate()**: Plugin functions which receive the state must never update it as this creates infinite loops. They are observers/reactors, not mutators.
- **State mutation only in event handlers**: Only user event handlers (like button clicks) and async operations (like API responses) should call `dispatchStateChange()`.

## Per-Key State Handlers

Instead of checking `changedKeys.includes(key)` inside `onStateUpdate`, declare a method named `on<Key>Change` where `Key` is the state property name with the first letter capitalized. The plugin base class auto-discovers these methods and registers them as `onStateUpdate.<key>` extension points.

```javascript
class MyPlugin extends Plugin {
  // Called only when state.xml changes — more efficient than a catch-all onStateUpdate
  async onXmlChange(newXml, prevXml) {
    if (newXml) this.loadDocument(newXml);
  }

  // Called only when state.user changes
  async onUserChange(newUser, prevUser) {
    this.updateUI(newUser);
  }

  // Called only when state.sessionId changes
  async onSessionIdChange(newId, prevId) {
    this.reconnect(newId);
  }
}
```

The naming convention: `on` + state key with first letter uppercased + `Change`.

- `state.xml` → `onXmlChange`
- `state.user` → `onUserChange`
- `state.sessionId` → `onSessionIdChange`
- `state.editorReadOnly` → `onEditorReadOnlyChange`

Per-key handlers receive `(newValue, prevValue)` — not `changedKeys` and the full state. Use `this.state` to access other state properties.

`onStateUpdate(changedKeys, state)` remains available as the catch-all and runs in parallel with per-key handlers. Both can coexist in the same class.

## Custom Extension Points

The `Plugin` base class auto-mounts two categories of extension points without any declaration:

- **Lifecycle methods** (`install`, `ready`, `start`, `shutdown`, `onStateUpdate`) — just define the method
- **Per-key state handlers** (`on<Key>Change`) — just follow the naming convention

All other extension points must be mounted explicitly.

To expose a method at a custom path (so other plugins can invoke it via `pluginManager.invoke('ns.method', args)`), use `static extensionPoints`:

```javascript
class ValidationPlugin extends Plugin {
  // Declares that this.validate is exposed at 'validation.validate'
  // and this.configure at 'validation.configure'
  static extensionPoints = ['validation.validate', 'validation.configure'];

  async validate(xmlString) { /* ... */ }
  async configure(options) { /* ... */ }
}
```

The convention: the last segment of the path is the method name (`validation.validate` → `this.validate`).

For one-off custom extension points not following this convention, override `getExtensionPoints()`:

```javascript
getExtensionPoints() {
  return {
    ...super.getExtensionPoints(),
    'filedata.loading': this.setLoadingState.bind(this)
  };
}
```

## Common Patterns

```javascript
// Per-key handler (preferred over onStateUpdate for single-key reactions)
async onUserChange(newUser, prevUser) {
  if (newUser) await this.setupUserUI();
}

// Catch-all for multiple keys or when you need changedKeys
async onStateUpdate(changedKeys, state) {
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

## Plugin Objects

Plugin objects are plain JavaScript objects that can also serve as plugins. The class-based `Plugin` class is implemented on top of this primitive pattern. If you need to understand the lower-level mechanics or work with object-based plugins directly, see [Object-Based Plugin Pattern](../development/plugin-system-object-based.md).

```javascript
import { updateState } from '../app.js';

let currentState;

async function onStateUpdate(changedKeys, state) {
  currentState = state;
  if (changedKeys.includes('user')) {
    // React to user changes
  }
}

async function someAction() {
  // Use currentState, not installation-time state
  await updateState({ pdf: 'new.pdf' });
}

export default {
  name: 'my-plugin',
  deps: ['dependency1'],
  api: { someAction },
  install: async (state) => { /* setup */ },
  onStateUpdate
};
```

## Memory Management

- State history is automatically limited to 10 entries to prevent memory leaks
- Older states are garbage collected when the limit is exceeded
- The `previousState` chain is properly broken to allow garbage collection

## Anti-Patterns to Avoid

❌ **DO NOT** import global state:

```javascript
import { state } from '../app.js';  // WRONG
```

❌ **DO NOT** mutate state directly:

```javascript
this.state.user = newUser;  // WRONG
```

❌ **DO NOT** update state in `onStateUpdate`:

```javascript
async onStateUpdate(changedKeys) {
  await this.dispatchStateChange({ ... });  // WRONG - creates infinite loop
}
```

✅ **DO** dispatch state changes from event handlers:

```javascript
async handleButtonClick() {
  await this.dispatchStateChange({ user: newUser });  // CORRECT
}
```

✅ **DO** react to state changes in `onStateUpdate`:

```javascript
async onStateUpdate(changedKeys) {
  if (changedKeys.includes('user')) {
    this.updateUI();  // CORRECT - observe and react
  }
}
```
