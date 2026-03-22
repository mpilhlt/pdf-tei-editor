# Object-Based Plugin Pattern

The frontend plugin system is built on a primitive object-based pattern. A plugin is a plain JavaScript object with a `name` and methods placed at extension point paths. The `Plugin` base class is implemented on top of this pattern: it auto-mounts class methods as extension points at registration time, translating between "class method" and "object property at a path".

This document describes the object-based pattern directly — useful when:

- Reading or modifying existing object-based plugins
- Understanding how the class-based system works internally
- Writing a simple plugin that doesn't need the class infrastructure

For the class-based API, see [Frontend Plugin System](plugin-system-frontend.md).

## Plugin Descriptor Shape

An object-based plugin is a plain JavaScript object with the following fields:

```javascript
const plugin = {
  // Required
  name: 'my-plugin',          // Unique string identifier

  // Optional
  deps: ['config', 'dialog'], // Names of plugins this one depends on (load order)
  api: { ... },               // Public API returned by getDependency('my-plugin')

  // Lifecycle methods
  install,    // async (initialState) => void
  start,      // async () => void
  shutdown,   // async () => void

  // State endpoint
  onStateUpdate,  // async (changedKeys, state) => void
};
```

All fields except `name` are optional.

## Lifecycle Methods

### `install(initialState)`

Called during application initialization, in dependency order. Use this to set up UI, register templates, and attach event listeners.

```javascript
async function install(initialState) {
  currentState = initialState;
  await registerTemplate('my-template', 'my-template.html');
  const el = createSingleFromTemplate('my-template');
  document.body.appendChild(el);
}
```

### `start()`

Called after all plugins have been installed. Use for operations that require other plugins to be ready.

```javascript
async function start() {
  const configApi = getDependency('config');
  // configApi is available now
}
```

### `shutdown()`

Called on `window.beforeunload`. Use to clean up resources.

```javascript
async function shutdown() {
  // cleanup
}
```

## State Update Handler

```javascript
async function onStateUpdate(changedKeys, state) {
  // changedKeys: string[] of state property names that changed
  // state: the new ApplicationState (immutable, do not mutate)
}
```

State tracking must be done manually. Store the current state in a module-level closure variable and update it in `onStateUpdate`:

```javascript
let currentState;

async function onStateUpdate(changedKeys, state) {
  currentState = state;
  if (changedKeys.includes('user')) {
    updateUserUI(state.user);
  }
}
```

Use `currentState` in event handlers — never capture state at install time, as it will become stale:

```javascript
async function handleButtonClick() {
  // currentState is always up to date
  await updateState({ someKey: computeValue(currentState) });
}
```

## Extension Point Path Mapping

Extension point paths map to nested properties on the plugin object. For example:

| Path | Property accessed |
|---|---|
| `onStateUpdate` | `plugin.onStateUpdate` |
| `state.update` | `plugin.state.update` |
| `custom.action` | `plugin.custom.action` |

The `PluginManager` resolves paths by splitting on `.` and traversing the object tree. So a plugin can expose multiple endpoints by nesting them:

```javascript
const plugin = {
  name: 'validation',
  validation: {
    validate: async (content) => { /* ... */ },
    configure: async (options) => { /* ... */ }
  }
};
```

These are then invokable as `manager.invoke('validation.validate', ...)`.

## The `api` Field and `getDependency()`

When another plugin calls `getDependency('my-plugin')`, it receives the value of `plugin.api`. This is how object-based plugins expose their public API:

```javascript
// In my-plugin.js
const api = {
  open,
  close,
  info,
  error
};

const plugin = {
  name: 'my-plugin',
  deps: ['config'],
  api,
  install,
  onStateUpdate
};

export { api, plugin };
export default plugin;
```

```javascript
// In another plugin
const myPluginApi = getDependency('my-plugin');
myPluginApi.open({ title: 'Hello' });
```

If `api` is omitted, `getDependency()` returns `undefined` for that plugin.

For class-based plugins, `getDependency()` returns whatever `getApi()` returns on the class instance.

## State Updates

Object-based plugins dispatch state changes using the exported `updateState` function from `app.js`:

```javascript
import { updateState } from '../app.js';

async function handleSave() {
  await updateState({ xml: { content: newContent, dirty: false } });
}
```

Never call `updateState()` inside `onStateUpdate()` — this creates infinite loops.

## Complete Example

```javascript
// app/src/plugins/my-plugin.js

import { updateState } from '../app.js';
import { registerTemplate, createSingleFromTemplate } from '../ui.js';

let currentState;
let buttonEl;

async function install(initialState) {
  currentState = initialState;

  await registerTemplate('my-plugin', 'my-plugin.html');
  buttonEl = createSingleFromTemplate('my-plugin');
  document.body.appendChild(buttonEl);

  buttonEl.addEventListener('click', handleClick);
}

async function start() {
  // All plugins are installed — safe to use getDependency here
}

async function shutdown() {
  buttonEl.removeEventListener('click', handleClick);
}

async function onStateUpdate(changedKeys, state) {
  currentState = state;
  if (changedKeys.includes('user')) {
    buttonEl.disabled = !state.user;
  }
}

async function handleClick() {
  await updateState({
    ext: { 'my-plugin': { lastClicked: Date.now() } }
  });
}

const api = {
  handleClick
};

const plugin = {
  name: 'my-plugin',
  deps: ['config'],
  api,
  install,
  start,
  shutdown,
  onStateUpdate
};

export { api, plugin };
export default plugin;
```

Registration in `app/src/plugins.js`:

```javascript
import myPlugin from './plugins/my-plugin.js';

const plugins = [
  // ...
  myPlugin,
  // ...
];
```

## Choosing Between Object-Based and Class-Based

Use the **class-based pattern** for new plugins. It provides:

- Automatic `this.state` tracking
- `this.dispatchStateChange()` instead of the global `updateState()`
- `getDependency()` method on `this`
- Singleton access via `MyPlugin.getInstance()`
- Auto-discovered `on<Key>Change()` handlers

Use the **object-based pattern** when:

- Modifying an existing object-based plugin where conversion is not warranted
- Writing a very small plugin where the class overhead is unnecessary
- Working at the PluginManager level and needing to understand how endpoints resolve

## Related Documentation

- [Frontend Plugin System](plugin-system-frontend.md) - Full architecture with class-based examples
- [Plugin Development Guide](../code-assistant/plugin-development.md) - Practical development guide
