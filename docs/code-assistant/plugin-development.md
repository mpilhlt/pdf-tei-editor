# Frontend Plugin Development Guide

Guide for creating and working with **frontend plugins** in the PDF-TEI Editor.

**Note**: This guide covers **frontend plugins** (JavaScript/TypeScript code running in the browser). For **backend plugins** (Python code running on the server), see [backend-plugins.md](./backend-plugins.md).

**Key Differences**:
- **Frontend plugins**: JavaScript classes in `app/src/plugins/` that extend the UI and handle client-side logic
- **Backend plugins**: Python modules in `fastapi_app/plugins/` that provide server-side functionality and API endpoints

For detailed frontend plugin architecture, see [../development/plugin-system-frontend.md](../development/plugin-system-frontend.md).

## Creating New Plugin Classes

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

## Plugin Registration in app.js

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

## State Management in Plugins

The application uses **immutable state management** with functional programming principles.

### Core Rules

- **Never mutate state directly** - always use `dispatchStateChange()`
- **Use `onStateUpdate()` for reactions** - more efficient than legacy `state.update`
- **Access current state via `this.state`** - read-only property
- **Store plugin-specific state in `state.ext`** - avoids naming conflicts
- **Use `hasStateChanged()` for conditional logic** - available via PluginContext

### State Management Architecture

State is managed through the `StateManager` class and `Application` orchestrator:

```javascript
// Plugin classes - via PluginContext
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
- `Application.updateState(changes)` - Orchestrates state changes and plugin notifications
- `PluginContext` - Provides controlled access to state utilities for Plugin classes
- Legacy BC wrappers - `updateState(changes)` and `hasStateChanged()` exported from app.js

### Plugin State Handling Best Practices

1. **Never import global state**: Plugins should only work with state parameters passed to functions
2. **Use hasStateChanged()**: Replace manual state caching with `hasStateChanged(state, 'property')`
3. **Local storage when needed**: Store local copies only for operations that need them (e.g., API requests)
4. **Access previous state**: Use `state.previousState` to compare with previous values
5. **Use state.ext for plugin-specific state**: Store plugin-specific state in `state.ext` to avoid TypeScript errors
6. **Use updateStateExt()**: For updating extension properties immutably

### State Architecture Principles

- **Plugin endpoints are reactive observers, not state mutators**: Plugin `update()` functions receive immutable state snapshots and react to changes by updating UI or internal plugin state. They do not return modified state objects.
- **Only state utilities create new state objects**: Functions like `updateState()` and `updateStateExt()` are responsible for creating new immutable state objects. Plugin endpoints observe and react to state changes.
- **Parallel plugin execution**: Since plugins don't mutate state, multiple plugins can process the same state snapshot concurrently without conflicts.
- **State initialization is sequential**: During app initialization, state operations are chained sequentially to build up the initial state before plugins start reacting to changes.
- **CRITICAL: Never call app.updateState() in endpoints that receive the state**: Plugin functions which receive the state must never update it as this creates infinite loops. They are observers/reactors, not mutators.
- **State mutation only in event handlers**: Only user event handlers (like button clicks) and async operations (like API responses) should call `app.updateState()`.
- **Event handlers must use current state**: In legacy code, event handlers registered during plugin installation receive stale state references. For plugin objects, store the current state in a closured variable and update it via an `onStateUpdate` endpoint. Use this updated reference in event handlers instead of the installation-time state parameter!

## Common Patterns

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

## Plugin Objects

Plugin objects use the `onStateUpdate` endpoint:

```javascript
import { updateState, hasStateChanged } from '../app.js';

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
