# State Management Architecture

This document provides a comprehensive technical overview of the state management system in the PDF-TEI Editor. For practical state usage in plugins, see the [Plugin Development Guide](../code-assistant/plugin-development.md) in the code-assistant documentation.

## Overview

The PDF-TEI Editor uses an **immutable state management** architecture with functional programming principles. This approach provides:

- **Immutable updates** - Each state change creates a new state object
- **State history** - Automatic tracking of previous states for debugging and comparison
- **Change detection** - Efficient tracking of which properties changed
- **Reactive updates** - Plugins automatically notified of relevant changes
- **Memory safety** - WeakMap-based history prevents memory leaks

## Core Concepts

### Immutability

Every state update creates a completely new state object. The previous state is never modified:

```javascript
// WRONG - Mutating state directly
state.user = newUser;

// CORRECT - Creating new state
const newState = await app.updateState({ user: newUser });
```

**Benefits:**
- **Predictability** - State changes are explicit and trackable
- **Debugging** - Complete history of states available
- **Time travel** - Can inspect previous states
- **No side effects** - Functions can safely receive state without mutation concerns

### State History

Each state maintains a link to its previous state using a WeakMap. This provides:

- **Automatic tracking** - No manual history management needed
- **Memory safety** - Garbage collection works normally
- **Change detection** - Easy comparison with previous values
- **Debugging support** - Can trace state evolution

```javascript
// Access previous state
const previousState = state.previousState;

// Check if property changed
if (state.user !== previousState?.user) {
  // User changed
}
```

### Change Detection

The StateManager tracks which properties changed in each update:

```javascript
// Update triggers change detection
const { newState, changedKeys } = stateManager.applyStateChanges(
  currentState,
  { user: newUser, pdf: 'doc.pdf' }
);

// changedKeys = ['user', 'pdf']
```

Plugins receive the changed keys for efficient reactive updates:

```javascript
async onStateUpdate(changedKeys) {
  if (changedKeys.includes('user')) {
    this.updateUserUI();
  }
  if (changedKeys.includes('pdf')) {
    this.loadPDF();
  }
}
```

## Architecture Components

### StateManager

The `StateManager` class ([app/src/modules/state-manager.js](../../app/src/modules/state-manager.js)) handles pure state operations without plugin dependencies.

#### Key Methods

**`applyStateChanges(currentState, changes)`**

Creates a new state with changes applied. Returns `{newState, changedKeys}`.

```javascript
const { newState, changedKeys } = stateManager.applyStateChanges(
  currentState,
  { pdf: 'document.pdf', xml: 'document.xml' }
);
// newState is a new object
// changedKeys = ['pdf', 'xml']
```

**`applyExtensionChanges(currentState, extChanges)`**

Updates plugin-specific state in `state.ext`:

```javascript
const { newState, changedKeys } = stateManager.applyExtensionChanges(
  currentState,
  { 'my-plugin': { customData: 'value' } }
);
// newState.ext['my-plugin'] = { customData: 'value' }
// changedKeys = ['ext']
```

**`hasStateChanged(state, ...propertyNames)`**

Checks if specific properties changed from previous state:

```javascript
if (stateManager.hasStateChanged(state, 'user', 'collection')) {
  // User or collection changed
}
```

**`getChangedStateKeys(state)`**

Returns all properties that changed:

```javascript
const changedKeys = stateManager.getChangedStateKeys(state);
// ['user', 'pdf']
```

**`getPreviousState(state)`**

Retrieves the previous state:

```javascript
const previousState = stateManager.getPreviousState(state);
const previousUser = previousState?.user;
```

**`getPreviousStateValue(state, propertyName)`**

Gets the previous value of a property:

```javascript
const previousPdf = stateManager.getPreviousStateValue(state, 'pdf');
```

### Application Orchestrator

The `Application` class ([app/src/app.js](../../app/src/app.js)) coordinates state updates with plugin notifications:

```javascript
export class Application {
  async updateState(changes) {
    // 1. Apply changes immutably
    const { newState, changedKeys } = this.stateManager.applyStateChanges(
      this.currentState,
      changes
    );

    // 2. Update current state reference
    this.currentState = newState;

    // 3. Notify plugins silently (update internal state)
    await this.pluginManager.invoke('updateInternalState', newState);

    // 4. Notify plugins reactively (trigger UI updates)
    await this.pluginManager.invoke('onStateUpdate', [changedKeys, newState]);

    return newState;
  }
}
```

### State Definition

The ApplicationState type is defined in [app/src/state.js](../../app/src/state.js):

```javascript
/**
 * @typedef {object} ApplicationState
 * @property {string|null} sessionId - Session ID for this browser tab
 * @property {string|null} pdf - Document identifier for PDF file
 * @property {string|null} xml - Document identifier for XML file
 * @property {string|null} diff - XML file for diff comparison
 * @property {string|null} xpath - Current XPath selection
 * @property {string|null} variant - Variant filter for file display
 * @property {boolean} webdavEnabled - Whether WebDAV backend available
 * @property {boolean} editorReadOnly - Whether XML editor is read-only
 * @property {boolean} offline - Whether backend disconnected
 * @property {UserData|null} user - Currently logged-in user
 * @property {string|null} collection - Current collection ID
 * @property {FileListItem[]|null} fileData - File list from server
 * @property {CollectionInfo[]|null} collections - Accessible collections
 * @property {boolean} hasInternet - Whether backend has internet
 * @property {Record<string, any>} ext - Plugin-specific state extensions
 * @property {ApplicationState|null} previousState - Link to previous state
 */
```

## State Update Flow

### Complete Update Lifecycle

```
1. User Action (button click, etc.)
         ↓
2. Event Handler calls dispatchStateChange() or updateState()
         ↓
3. Application.updateState(changes)
         ↓
4. StateManager.applyStateChanges(currentState, changes)
   - Creates new state object
   - Tracks changed keys
   - Links to previous state via WeakMap
         ↓
5. Application updates currentState reference
         ↓
6. PluginManager.invoke('updateInternalState', newState)
   - Plugin class instances update internal state
   - Silent update, no reactions
         ↓
7. PluginManager.invoke('onStateUpdate', [changedKeys, newState])
   - Plugins receive change notifications
   - Plugins update UI reactively
         ↓
8. UI Updated
```

### Update Patterns

**Plugin Class State Updates:**

```javascript
class MyPlugin extends Plugin {
  async handleButtonClick() {
    // Dispatch state change
    await this.dispatchStateChange({
      pdf: 'new-document.pdf',
      xml: 'new-document.xml'
    });
  }

  async onStateUpdate(changedKeys) {
    // React to changes
    if (changedKeys.includes('pdf')) {
      await this.loadPDF();
    }
  }
}
```

**Legacy Plugin Object Updates:**

```javascript
import { updateState } from '../app.js';

let currentState;

async function onStateUpdate(changedKeys, state) {
  currentState = state;
  if (changedKeys.includes('user')) {
    updateUserUI();
  }
}

async function handleAction() {
  // Use currentState (not installation-time state!)
  await updateState({
    collection: currentState.user.defaultCollection
  });
}
```

## Critical Rules

### 1. Endpoints Are Observers, Not Mutators

Plugin functions that receive state (like `onStateUpdate`, `install`, `start`) are **observers**. They react to state but never modify it:

```javascript
// WRONG - Updating state inside observer
async onStateUpdate(changedKeys) {
  await this.dispatchStateChange({ ... });  // Creates infinite loop!
}

// CORRECT - Only react to state
async onStateUpdate(changedKeys) {
  if (changedKeys.includes('user')) {
    this.updateUI();  // Side effect, not state mutation
  }
}
```

**Why?** Updating state inside a state observer creates infinite loops.

### 2. State Updates Only in Event Handlers

State changes should only occur in response to:

- **User events** (clicks, form submissions, keyboard input)
- **Async operations** (API responses, timers, promises resolving)
- **External events** (SSE messages, WebSocket events)

```javascript
// CORRECT - State update in event handler
button.addEventListener('click', async () => {
  await this.dispatchStateChange({ pdf: 'doc.pdf' });
});

// CORRECT - State update after API call
const response = await api.saveFile(data);
await this.dispatchStateChange({ xml: response.id });

// WRONG - State update in observer
async onStateUpdate(changedKeys) {
  await this.dispatchStateChange({ ... });  // NEVER do this
}
```

### 3. Never Mutate State Directly

Always use `dispatchStateChange()` or `updateState()`:

```javascript
// WRONG
this.state.user = newUser;
this.state.pdf = 'doc.pdf';

// CORRECT
await this.dispatchStateChange({
  user: newUser,
  pdf: 'doc.pdf'
});
```

### 4. Use Current State, Not Stale References

**Plugin Classes** - State automatically managed:

```javascript
class MyPlugin extends Plugin {
  async someAction() {
    // Always current - automatically updated
    const currentUser = this.state.user;
  }
}
```

**Plugin Objects** - Must manually track current state:

```javascript
let currentState;  // Closured variable

async function onStateUpdate(changedKeys, state) {
  currentState = state;  // Update reference
}

async function handleClick() {
  // Use currentState, NOT the state from install()
  await updateState({
    collection: currentState.user.defaultCollection
  });
}
```

## Plugin-Specific State

Plugins store custom state in `state.ext` to avoid naming conflicts:

### Using Extensions in Plugin Classes

```javascript
class MyPlugin extends Plugin {
  async savePreferences(preferences) {
    await this.dispatchStateChange({
      ext: {
        [this.name]: { preferences }
      }
    });
  }

  get preferences() {
    return this.state?.ext?.[this.name]?.preferences || {};
  }

  async onStateUpdate(changedKeys) {
    // ext changed
    if (changedKeys.includes('ext')) {
      const prefs = this.preferences;
      this.applyPreferences(prefs);
    }
  }
}
```

### Merging Extension State

When updating extensions, merge with existing ext:

```javascript
// WRONG - Replaces all extensions
await this.dispatchStateChange({
  ext: { 'my-plugin': { data: 'value' } }
});

// CORRECT - Merge with existing
await this.dispatchStateChange({
  ext: {
    ...this.state.ext,
    'my-plugin': { data: 'value' }
  }
});
```

Or use the StateManager's helper:

```javascript
const { newState } = stateManager.applyExtensionChanges(
  currentState,
  { 'my-plugin': { data: 'value' } }
);
```

## State Persistence

### Session Storage

The StateManager supports automatic persistence to sessionStorage:

```javascript
// Enable persistence
stateManager.preserveState(true, ['user', 'collection', 'pdf', 'xml']);

// State automatically saved on updates

// Restore on reload
const savedState = stateManager.getStateFromSessionStorage();
if (savedState) {
  await app.updateState(savedState);
}
```

**Use Cases:**
- Preserve session across page reloads
- Maintain state during development
- Restore user context after authentication

**Limitations:**
- Only JSON-serializable data persists
- sessionStorage limited to ~5-10MB
- Cleared when tab closes

## Memory Management

### History Tracking

State history uses WeakMap for automatic garbage collection:

```javascript
// WeakMap stores history
const stateHistory = new WeakMap();

// Link to previous state
stateHistory.set(newState, currentState);

// When no references to old states exist, they're garbage collected
```

**Benefits:**
- No memory leaks from history chain
- Previous states collected when no longer referenced
- No manual cleanup needed

### State Lifecycle

```
State Created
    ↓
Referenced by currentState in Application
Referenced by this.state in Plugin instances
    ↓
New State Created
    ↓
Old state reference removed from currentState
Old state still in WeakMap (previousState chain)
    ↓
Old state no longer referenced by plugins
    ↓
Garbage collector removes old state
WeakMap entry automatically cleared
```

## Change Detection Patterns

### Basic Change Detection

```javascript
async onStateUpdate(changedKeys) {
  if (changedKeys.includes('user')) {
    this.handleUserChange();
  }
}
```

### Multiple Properties

```javascript
async onStateUpdate(changedKeys) {
  const userChanged = changedKeys.includes('user');
  const collectionChanged = changedKeys.includes('collection');

  if (userChanged || collectionChanged) {
    await this.reloadFileList();
  }
}
```

### Nested Property Changes

```javascript
// Check if ext.my-plugin changed
async onStateUpdate(changedKeys) {
  if (changedKeys.includes('ext')) {
    const previousExt = this.state.previousState?.ext?.[this.name];
    const currentExt = this.state.ext?.[this.name];

    if (previousExt !== currentExt) {
      this.handleExtensionChange(currentExt);
    }
  }
}
```

### Using hasStateChanged Helper

```javascript
// In Plugin classes
if (this.hasStateChanged('user', 'collection')) {
  // Either user or collection changed
}

// In plugin objects
import { hasStateChanged } from '../app.js';

if (hasStateChanged(state, 'user', 'collection')) {
  // Either user or collection changed
}
```

## Debugging State

### Accessing State History

```javascript
// Current state
console.log('Current:', this.state);

// Previous state
console.log('Previous:', this.state.previousState);

// Compare values
console.log('User changed:',
  this.state.user !== this.state.previousState?.user
);
```

### Logging State Changes

```javascript
async onStateUpdate(changedKeys) {
  console.log('State changed:', changedKeys);
  console.log('New values:', changedKeys.map(key => ({
    key,
    value: this.state[key]
  })));
}
```

### Tracking State Evolution

```javascript
// Walk back through state history
let currentState = this.state;
let depth = 0;

while (currentState && depth < 5) {
  console.log(`State ${depth}:`, currentState);
  currentState = currentState.previousState;
  depth++;
}
```

## Performance Considerations

### Conditional Updates

Only react to relevant changes:

```javascript
// BAD - Updates on every state change
async onStateUpdate(changedKeys) {
  this.updateUI();  // Called even when irrelevant properties change
}

// GOOD - Selective updates
async onStateUpdate(changedKeys) {
  if (changedKeys.includes('pdf')) {
    this.updatePDFViewer();
  }
  if (changedKeys.includes('xml')) {
    this.updateXMLEditor();
  }
}
```

### Batching Updates

Batch multiple changes into single update:

```javascript
// BAD - Multiple updates
await this.dispatchStateChange({ pdf: 'doc.pdf' });
await this.dispatchStateChange({ xml: 'doc.xml' });
await this.dispatchStateChange({ collection: 'col1' });

// GOOD - Single batched update
await this.dispatchStateChange({
  pdf: 'doc.pdf',
  xml: 'doc.xml',
  collection: 'col1'
});
```

### Avoiding Unnecessary Work

Use change detection to skip work:

```javascript
async onStateUpdate(changedKeys) {
  // Don't reload if user didn't change
  if (!changedKeys.includes('user')) {
    return;
  }

  // Expensive operation only when needed
  await this.reloadUserData();
}
```

## Testing State Management

### Unit Testing State Changes

```javascript
import { StateManager } from '../modules/state-manager.js';

test('state update creates new object', () => {
  const manager = new StateManager();
  const state1 = { user: 'alice', pdf: null };

  const { newState } = manager.applyStateChanges(state1, { pdf: 'doc.pdf' });

  assert(newState !== state1);  // New object
  assert(newState.user === 'alice');  // Preserved
  assert(newState.pdf === 'doc.pdf');  // Updated
});
```

### Testing Plugin State Handling

```javascript
test('plugin reacts to state changes', async () => {
  const plugin = new MyPlugin(context);
  await plugin.install(initialState);

  const updateCalled = { count: 0 };
  plugin.updateUI = () => { updateCalled.count++; };

  await plugin.onStateUpdate(['user'], { ...initialState, user: 'bob' });

  assert(updateCalled.count === 1);
});
```

## Best Practices

### State Management

1. **Always use immutable updates** via `dispatchStateChange()` or `updateState()`
2. **Never update state in observers** like `onStateUpdate` or `install`
3. **Batch related changes** into single update for performance
4. **Use ext for plugin state** to avoid naming conflicts
5. **Check changedKeys** before doing expensive work

### Plugin Development

1. **Plugin classes** - Prefer for new plugins, automatic state management
2. **Current state access** - Use `this.state` in classes, closured variable in objects
3. **Change detection** - Use `changedKeys.includes()` for reactive updates
4. **Event handlers** - Only place to trigger state updates
5. **State comparison** - Use `previousState` for comparing values

### Debugging

1. **Log changed keys** to understand update patterns
2. **Inspect previousState** to compare values
3. **Check state history** to trace evolution
4. **Verify immutability** - states should never mutate
5. **Monitor update frequency** to identify performance issues

## Related Documentation

- [Plugin System Architecture](plugin-system.md) - Plugin architecture and endpoints
- [Architecture Overview](architecture.md) - Complete system architecture
- [Plugin Development Guide](../code-assistant/plugin-development.md) - Practical state usage
- [Coding Standards](../code-assistant/coding-standards.md) - Code quality requirements
