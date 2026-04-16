# Inter-Plugin Communication

Three mechanisms are available. Choose based on the relationship between producer and consumer.

| Mechanism | Use when |
|-----------|----------|
| `dispatchStateChange` | Broadcasting domain state to unknown or multiple consumers. The producer doesn't target a specific plugin. |
| Extension points (`static extensionPoints`) | A host plugin needs structured contributions from many plugins. Contributions are additive and defined at install/start time. |
| `getDependency()` API | The interaction targets one specific plugin, or a synchronous return value is required. |

Cross-plugin UI access via the global `ui` object is never correct. A plugin that needs to affect another plugin's widget must use one of the three mechanisms above.

---

## State propagation

Use `dispatchStateChange` to broadcast a value that any number of plugins may react to. The producer does not know or care which plugins consume the change.

```javascript
// Producer: fires when user logs in
async handleLogin(user) {
  await this.dispatchStateChange({ user })
}

// Consumer A: reacts to the same state key
async onUserChange(newUser) {
  this.updateUserMenu(newUser)
}

// Consumer B: also reacts independently
async onUserChange(newUser) {
  if (!newUser) this.clearEditor()
}
```

Plugin-specific data goes in `state.ext` to avoid key collisions:

```javascript
await this.dispatchStateChange({
  ext: { [this.name]: { preferences: prefs } }
})

get preferences() {
  return this.state?.ext?.[this.name]?.preferences ?? {}
}
```

**Rules:**

- `onStateUpdate` handlers are **observers only** — calling `dispatchStateChange` from inside one throws an error because state propagation is locked during notification.
- Call `dispatchStateChange` from event handlers, UI callbacks, or top-level async operations.
- When `onStateUpdate` triggers async work (e.g. an API call) whose result must be written back to state, use `scheduleStateChange` instead:

```javascript
async onXmlChange(newXml) {
  const permissions = await this.fetchPermissions(newXml);
  // scheduleStateChange defers the dispatch until propagation is fully done
  await this.scheduleStateChange({ editorReadOnly: !permissions.canEdit });
}
```

`scheduleStateChange` is the only legitimate way to write state as a consequence of `onStateUpdate`. It is not a general escape hatch — synchronous handlers must remain pure observers.

---

## Extension points

Use extension points when a host plugin needs structured contributions from multiple plugins. The host defines the contract; contributors implement it.

### Declaring and implementing an extension point

```javascript
// extension-points.js
export default {
  toolbar: {
    contentItems: 'toolbar.contentItems',
    menuItems:    'toolbar.menuItems',
  }
}
```

```javascript
// Contributing plugin
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

The base class discovers the computed method automatically. The key is the full EP path string (`"toolbar.contentItems"`), so there are no naming conflicts between different namespaces.

> **ASI hazard**: always end `static extensionPoints = [...]` with a semicolon. Without it, the parser treats the following `[ep.X.Y](...)` computed method as a subscript access on the array, causing a `SyntaxError: Unexpected token '{'`.

Extension point handler methods MUST be documented with JSDoc: state the EP being handled, which host plugin invokes them and when, the `Delegates to` link, and `@param`/`@returns` tags.

### Invoking an extension point (host side)

```javascript
// ToolbarPlugin.start() collects all contributions
const results = await this.context.invokePluginEndpoint(
  ep.toolbar.contentItems, [], { result: 'values', throws: false }
)
for (const items of results) {
  if (!Array.isArray(items)) continue
  for (const { element, priority = 0, position = 'center' } of items) {
    ui.toolbar.add(element, priority, position)
  }
}
```

### Auto-discovered extension points

The base class auto-mounts these without any declaration:

- **Lifecycle methods**: `install`, `ready`, `start`, `shutdown`, `onStateUpdate` — just define the method.
- **Per-key state handlers**: `on<Key>Change` — follow the naming convention, e.g. `onXmlChange`, `onUserChange`.

All other extension points require `static extensionPoints` with a corresponding computed handler method.

---

## `getDependency()` API

Use when the interaction is intentionally directed at one specific plugin, or when a synchronous return value is required (state and extension points are both asynchronous/broadcast).

```javascript
class DocumentActionsPlugin extends Plugin {
  // Private getters — resolved lazily at call time, not at construction time.
  // This avoids initialization-order issues and circular dependency problems.
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

Only add a plugin to `deps` when it must be fully installed before this plugin's own `install()` runs. For plugins only needed at action time (button clicks, async operations), the private getter above is sufficient — no `deps` entry required.

**Check for circular deps**: before declaring a dep, verify the full chain does not lead back to the current plugin. If plugin A depends on B and B (transitively) depends on A, declare neither as a dep — use lazy `getDependency()` calls at call time instead.

---

## Decision guide

```
Need to affect another plugin's widget?
  → No direct ui.otherPlugin.* access allowed.
  → If the other plugin owns the widget, add an API method to it and use getDependency().
  → If the value is domain state (e.g. readOnly, currentUser), use dispatchStateChange().

Need contributions from many plugins?
  → Define an extension point. Contributors implement it passively.

Need a return value from one specific plugin?
  → getDependency().methodName()

Broadcasting a domain event?
  → dispatchStateChange()
```
