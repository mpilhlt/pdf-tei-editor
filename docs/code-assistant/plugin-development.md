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

See [plugin-communication.md](./plugin-communication.md) for when to use state vs. other mechanisms.

The application uses **immutable state management**:

- **Dispatch changes**: `await this.dispatchStateChange({ key: value })` — never mutate `this.state` directly
- **React to changes**: `onStateUpdate(changedKeys, state)` or per-key handlers (see below)
- **Read current state**: `this.state` — read-only property
- **Plugin-specific state**: store in `state.ext[this.name]` to avoid key collisions
- **Never call `dispatchStateChange` inside `onStateUpdate`** — state propagation is locked during observer notification; doing so throws an error. Use `scheduleStateChange` when async work triggered by `onStateUpdate` produces a result that must be written back to state (see below).

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

## Extension Points

See [plugin-communication.md](./plugin-communication.md) for the full extension point system, including when to use them vs. state or `getDependency()`.

Auto-discovered without any declaration:

- **Lifecycle methods**: `install`, `ready`, `start`, `shutdown`, `onStateUpdate` — just define the method
- **Per-key state handlers**: `on<Key>Change` — follow the naming convention (see below)

All other extension points: declare in `static extensionPoints` and implement a computed method that delegates to a named method:

```javascript
import ep from '../extension-points.js'

class MyPlugin extends Plugin {
  static extensionPoints = [ep.toolbar.contentItems];

  /**
   * Extension point handler for `ep.toolbar.contentItems`.
   * Called by ToolbarPlugin during start() to collect this plugin's toolbar contributions.
   * Delegates to {@link MyPlugin#getToolbarContentItems}.
   * @returns {Array<{element: HTMLElement, priority: number, position: string}>}
   */
  [ep.toolbar.contentItems](...args) { return this.getToolbarContentItems(...args) }

  getToolbarContentItems() {
    return [{ element: this.#ui, priority: 5, position: 'center' }]
  }
}
```

Always document the computed handler method with JSDoc (see the CLAUDE.md rule).

## Accessing Dependencies

See [plugin-communication.md](./plugin-communication.md) for when to use `getDependency()` vs. state or extension points.

Use private getter properties — resolved lazily at call time, avoiding initialization-order and circular-dependency issues:

```javascript
class DocumentActionsPlugin extends Plugin {
  get #logger()    { return this.getDependency('logger') }
  get #xmlEditor() { return this.getDependency('xmleditor') }
  get #client()    { return this.getDependency('client') }

  async saveRevision() {
    this.#logger.debug('saving...')
    const xmlDoc = this.#xmlEditor.getXmlTree()
    await this.#client.saveXml(xmlDoc)
  }
}
```

Only add a plugin to `deps` when it must be fully installed before this plugin's own `install()` runs. Plugins only needed at action time don't need a `deps` entry.

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

❌ **DO NOT** call `dispatchStateChange` inside `onStateUpdate`:

```javascript
async onStateUpdate(changedKeys) {
  await this.dispatchStateChange({ ... });  // WRONG — throws, propagation is locked
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
    this.updateUI();  // CORRECT — observe and react, no state mutation
  }
}
```

✅ **DO** use `scheduleStateChange` when async work inside `onStateUpdate` produces a result that must go back into state:

```javascript
async onXmlChange(newXml) {
  // Async API call triggered by a state change
  const permissions = await this.fetchPermissions(newXml);
  // dispatchStateChange would throw here — propagation may still be active.
  // scheduleStateChange flushes after the current cycle completes.
  await this.scheduleStateChange({ editorReadOnly: !permissions.canEdit });
}
```

`scheduleStateChange` is an explicit opt-in for this one legitimate pattern. It is **not** a general escape hatch from the observer rule — synchronous reactions must always remain pure observers.
