# Frontend Rules

Rules specific to frontend code in `app/`. The root [CLAUDE.md](../CLAUDE.md) applies here too.

## Development

- **DO NOT rebuild after frontend changes** - The importmap loads source files directly in development mode

## File Identifiers

- **File identifiers on the client** - ALWAYS use `stable_id` (nanoid) when referencing files in client-side code (frontend plugins, HTML output, JavaScript). NEVER use `file_id` (content hash) on the client. The `stable_id` is the permanent identifier for files, while `file_id` is only used internally for storage and deduplication

## Plugin Architecture

- **Plugin endpoints are observers, not mutators** - Never call `dispatchStateChange` from inside `onStateUpdate` or any per-key handler (`on<Key>Change`). State propagation is locked during notification and the call will throw. If async work triggered by `onStateUpdate` produces a result that must be written back to state (e.g. an API call that determines `editorReadOnly`), use `await this.scheduleStateChange({ ... })` instead — it flushes after the current propagation cycle completes. This is the only legitimate exception; synchronous handlers must remain pure observers.
- **Always document extension point handler methods** - Every `[ep.X.Y](...args)` computed method MUST have a JSDoc comment with: (1) the phrase "Extension point handler for `ep.X.Y`.", (2) a sentence describing when it is called and by which plugin/mechanism, (3) `Delegates to {@link ClassName#methodName}.`, and (4) `@param` and `@returns` tags matching the underlying method's signature.
- **`static extensionPoints` needs a semicolon** - Always terminate `static extensionPoints = [...]` with a semicolon. Without it, the parser treats the following `[ep.X.Y](...)` computed method as a subscript access on the array, causing `SyntaxError: Unexpected token '{'`.
- **Class-based plugins use `dispatchStateChange`** - In class-based plugins, ALWAYS use `await this.dispatchStateChange({ key: value })` instead of `app.updateState(...)`. `dispatchStateChange` is defined on the `Plugin` base class and is the correct way to trigger state updates from within a class plugin.
- **Circular dependency detection in plugin migrations** - Before declaring a dep in a class plugin, verify the full dep chain does not lead back to the current plugin. Common pattern: if plugin A depends on B, and B (transitively) depends on A, declare neither as a dep — use lazy `getDependency()` calls at call time instead. Always check each new dep's `deps` field (and its deps' deps) before adding it to the `deps` array.
- **Template registration pattern** - ALWAYS register templates at module level using `await registerTemplate('template-name', 'template-file.html')` BEFORE the plugin class definition, then use `createFromTemplate('template-name', parentElement)` in the `install()` method. Never use direct `fetch()` and `insertAdjacentHTML()` - this bypasses the template system and prevents proper logging and UI registration.

## UI Navigation and Structure

- **ALWAYS use UI navigation via the `ui` object** - Never use `querySelector()` or `querySelectorAll()` to access UI elements. Use the `ui` object hierarchy instead (e.g., `ui.toolbar.logoutButton` instead of `ui.toolbar.querySelector('[name="logoutButton"]')`). This ensures alignment with runtime UI structure and documentation
- **UI element hierarchy** - Named elements inside other named elements create a hierarchy. Access nested elements via `ui.parent.child.grandchild`, not `ui.parent.grandchild`. Example: if a checkbox with `name="myCheckbox"` is inside a div with `name="myContainer"`, access it as `ui.parent.myContainer.myCheckbox`. When asked to refactor the UI (i.e., move a button from one location to another), **always** also update references to the UI hierarchy. For example, if during a refactoring, the UI element referenced by `ui.parent.myContainer.myCheckbox` is moved to `ui.parent.otherContainer`, its reference **must** be renamed to `ui.parent.otherContainer.myCheckbox` throughout the application.
- **ALWAYS add UI typedefs for plugin UI elements** - When a plugin adds UI elements, MUST add a `@typedef` documenting the structure (see `app/src/plugins/toolbar.js` for pattern), import it in `app/src/ui.js`, and add the property to the parent typedef (e.g., `toolbarPart`). This enables autocomplete and eliminates need for defensive checks. During refactoring, **always** also update all of the affected typedefs.
- **UI elements are always available after `updateUi()`** - After calling `updateUi()`, assume all UI elements are properly registered in the ui object. NEVER use defensive optional chaining (`ui.foo?.bar`), existence checks (`if (ui.foo)`), or nullish coalescing (`ui.foo ?? fallback`) when accessing UI elements defined in typedefs - if elements are missing, it indicates a logic error that needs fixing. The app should fail hard, not silently continue.

## Shoelace Components

- **Tooltip wrappers don't need names** - SlTooltip components are wrappers and don't need `name` attributes. Only the element inside (like a button) needs a name
- **Programmatic checkbox changes don't fire events** - Setting `checkbox.checked` programmatically does NOT trigger `sl-change` events in Shoelace components. Must manually update state when programmatically changing checkbox states
- **Shoelace dropdown z-index in toolbars** - When adding `sl-dropdown` to toolbars, the dropdown menu may appear behind other content due to z-index stacking contexts. Fix: (1) Add `sl-show`/`sl-hide` event listeners to toggle `dropdown-open` class on the parent `tool-bar` element, (2) CSS rule `tool-bar.dropdown-open { z-index: var(--sl-z-index-dropdown) !important; }` overrides the base `z-index: 0` rule.

## Utilities

- **User notifications** - Use `notify(message, variant, icon)` from `app/src/modules/sl-utils.js` for toast notifications. Variants: "primary", "success", "warning", "danger". Common icons: "check-circle", "exclamation-triangle", "exclamation-octagon", "info-circle"
- **Reload file data** - Use `FiledataPlugin.getInstance().reload({ refresh: true })` to reload file data from the server. Import `FiledataPlugin` from `../plugins.js`
- **UI preference persistence** - Use `this.uiStorage.get/set/remove/bind()` (available on every `Plugin` subclass) instead of writing `localStorage` directly. Keys are namespaced automatically as `ui.<plugin-name>.<key>`. See [docs/code-assistant/ui-storage.md](../docs/code-assistant/ui-storage.md) for the full API, DOM binding pattern, and testing guide.
