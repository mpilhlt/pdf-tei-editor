# Inter-Plugin Communication

Three mechanisms are available. Choose based on the relationship between producer and consumer.

| Mechanism | Use when |
|-----------|----------|
| `dispatchStateChange` | Broadcasting domain state to unknown or multiple consumers. The producer doesn't target a specific plugin. |
| Extension points (`static extensionPoints`) | A host plugin needs structured contributions from many plugins. Contributions are additive and defined at install/start time. |
| `getDependency()` API | The interaction targets one specific plugin, or a synchronous return value is required. |

**Prefer extension points over hard dependencies.** When a plugin needs another plugin to do something, or to show something in its UI, define an extension point for it instead of calling the other plugin's API through `getDependency()`. A hard dependency (a `deps` entry plus API calls) is only appropriate for core features that many call sites already depend on (e.g. `logger`, `client`, `xmleditor`, `pdfviewer`). Features built on top of a core plugin go into their own plugin, which depends on the core plugin and contributes to it through extension points; callers then invoke an extension point and do not need to know which plugin implements it. Document every new extension point in `app/src/extension-points.js` with its caller, its handler(s) and its function signature.

Example: the synchronization of the XML editor and the PDF viewer (`app/src/plugins/editor-sync.js`) is a plugin of its own. It depends on `pdfviewer` and contributes its "Sync with editor" switch to the PDF viewer's statusbar via `pdfViewer.statusbarItems`, which `PdfViewerPlugin.start()` collects, and learns about page changes via `pdfViewer.pageChanged`. `ServicesPlugin.searchNodeContentsInPdf()` does not call the PDF viewer, but invokes `pdfSearch.searchNode`, which `EditorSyncPlugin` handles.

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
   * @returns {PanelContribution[]}
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
// ToolbarPlugin.start() collects all contributions and puts them into display order
const results = await this.context.invokePluginEndpoint(
  ep.toolbar.contentItems, [], { result: 'values', throws: false }
)
const contributions = results.flatMap(items => Array.isArray(items) ? items : [])
for (const { element, priority = 0 } of resolveContributions(contributions)) {
  ui.toolbar.add(element, priority)
}
```

A `PanelContribution` (`app/src/modules/panels/base-panel.js`) has `element`, `position` (`'left'`, `'center'`, `'right'` or an absolute slot such as `1` or `-1`), `order` (position within the zone, defaults to `priority`) and `priority` (overflow: higher stays visible longer). Use `order` when an item should sit far left but be hidden early, e.g. the Collection selector.

### Dashboard contributions

Backend plugins can add boxes to the login dashboard by implementing `dashboard.contributions` in a frontend extension. See [fastapi_app/plugins/dashboard/README.md](../../fastapi_app/plugins/dashboard/README.md) for the contribution format and the layout rules.

### Resuming client jobs

`jobs.resume` (host: `JobsPlugin`) lets a plugin resume its client jobs after a page reload. The handler returns `{ type, resume: (job) => Promise<void> }` (or an array of them); `resume` typically calls `getDependency('jobs').runClientJob(job.type, job.params, body, { jobId: job.id })`. See [jobs.md](jobs.md#frontend-the-jobs-plugin).

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
  → To add a widget to another plugin's UI, contribute it via an extension point of that plugin
    (e.g. toolbar.contentItems, pdfViewer.statusbarItems); add one if it does not exist yet.
  → If the other plugin owns the widget, add an API method to it and use getDependency().
  → If the value is domain state (e.g. readOnly, currentUser), use dispatchStateChange().

Need another plugin to perform an action?
  → Invoke an extension point that the other plugin handles (e.g. pdfSearch.searchNode).
  → Use getDependency() only for core plugins that many call sites already depend on.

Need contributions from many plugins?
  → Define an extension point. Contributors implement it passively.

Need a return value from one specific plugin?
  → getDependency().methodName()

Broadcasting a domain event?
  → dispatchStateChange()
```
