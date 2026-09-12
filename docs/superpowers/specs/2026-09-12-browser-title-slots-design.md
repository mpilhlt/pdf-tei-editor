# Browser Tab Title Slots — Design Spec

Date: 2026-09-12
Status: Approved for planning

## Problem

The browser tab title should include the logged-in username, so tabs with
different users (e.g. `cboulanger` vs `admin`) can be told apart at a
glance. Today `document.title` has exactly one writer,
`XMLEditorPlugin#updateBrowserTitle()` (`app/src/plugins/xmleditor.js:1370`),
which prefixes a base title — captured once at construction from the
static `<title>` in `index.html` — with `● ` (unsaved) or `⚠ ` (autosave
blocked). Adding a second, independent writer for the username would race
with this: whichever writes last wins, and the base title never reflects
the current user.

Rather than hardcode a second "username" concern into `XMLEditorPlugin`,
the title is generalized into a small, reusable slot/template mechanism:
any plugin can contribute a named slot value, and the composition rule
(template) is itself part of application state so it isn't tied to this
one feature.

## Decision

**Template lives in state.** `ApplicationState.titleTemplate` (new field,
`app/src/state.js`) is a string with `{slotName}` placeholders, e.g. the
default:

```text
{status}{appTitle} ({username})
```

Being state, it can be changed at runtime (e.g. by config or another
plugin) without touching the rendering code.

**Slots are updated via an extension point owned by `start.js`.** New
entry in `app/src/extension-points.js`:

```js
title: {
  /** Merges given slot values into the title template and re-renders
   *  document.title. Unknown slot names (not present in the template)
   *  are ignored.
   *  Function signature: (slots: Record<string, string>) => void */
  updateSlots: "title.updateSlots"
}
```

`StartPlugin` (`app/src/plugins/start.js`) implements the handler,
`[ep.title.updateSlots](slots)`. It owns the live slot-value map
(`#titleSlots`), merges incoming partial updates into it, and re-renders.
Any plugin can call
`this.context.invokePluginEndpoint(ep.title.updateSlots, { someSlot: value })`
to contribute — the caller does not need to know the full template or
what else contributes to it.

**Rendering is a pure, app-agnostic helper.** New export in
`app/src/modules/browser-utils.js`:

```js
export function renderTitleTemplate(template, slots) {
  let result = template.replace(/\{(\w+)\}/g, (_, name) => slots[name] ?? '');
  result = result.replace(/[[(]\s*[)\]]/g, '').replace(/\s{2,}/g, ' ').trim();
  return result;
}
```

A missing/empty slot value substitutes as `''`; the second `.replace`
strips any `()`/`[]` pair left empty by that substitution (so a logged-out
title renders as `PDF-TEI Editor`, not `PDF-TEI Editor ()`), and
whitespace is normalized. This is generic string templating with no
knowledge of "username" or "status" — reusable by any app built on this
plugin framework with its own template/slots.

**`StartPlugin` owns the DOM write and the built-in slots:**

- `#titleSlots = { appTitle: document.title, status: '', username: '' }`
  — `appTitle` is captured once at construction, exactly like the old
  `#originalDocumentTitle` was, just centralized here instead of in
  `XMLEditorPlugin`.
- `install(state)`: seeds `username` from `state.user` (handles a
  restored session at boot, since `onUserChange` only fires on
  subsequent changes — same reason `user-account.js` seeds from
  `initialState.user` in its `install()`), then does the first render.
- `onUserChange(user)`: updates the `username` slot and re-renders.
- `[ep.title.updateSlots](slots)`: merges `slots` into `#titleSlots`,
  renders `renderTitleTemplate(this.state.titleTemplate, this.#titleSlots)`,
  and writes `document.title` only if the rendered value changed.

**`XMLEditorPlugin` no longer touches `document.title`.**
`#originalDocumentTitle` is removed entirely. `#updateBrowserTitle()`
still computes its own `status` prefix (`'⚠ '` for autosave-blocked,
`'● '` for dirty, `''` otherwise — unchanged logic) but instead of writing
the DOM directly, calls:

```js
this.context.invokePluginEndpoint(ep.title.updateSlots, { status });
```

## Result

- Logged out: `PDF-TEI Editor`
- Logged in as `cboulanger`: `PDF-TEI Editor (cboulanger)`
- Logged in, unsaved edits: `● PDF-TEI Editor (cboulanger)`
- Logged in, autosave blocked: `⚠ PDF-TEI Editor (cboulanger)`

## Out of scope

- No UI to let users customize `titleTemplate` themselves — it's a code/
  config-level default, not a user preference.
- No conditional template sections (e.g. "show this literal text only if
  slot X is non-empty") beyond the empty-`()`/`[]` collapsing rule above —
  YAGNI for the current use case.
- No changes to when/why `XMLEditorPlugin` decides the document is dirty
  or autosave-blocked — only how that status reaches `document.title`.
