# Annotator teiHeader Safeguard — Design

Status: draft for review. Date: 2026-09-28.

## Goal

For users holding only the `annotator` role (not `reviewer`/`admin`), add a **UI-only safeguard** against accidental edits to `<teiHeader>`, and reduce visual clutter by keeping the header folded and its toggle hidden by default.

This is explicitly **not** a security boundary: `<teiHeader>` metadata must remain editable — by other roles in the editor, and programmatically (e.g. automated metadata updates) — so no backend enforcement is added. The goal is purely to stop an annotator from accidentally typing into the header while working in `<text>`, and to avoid showing them a part of the document that has no relevance to their task.

## Current state

- `annotator` is an existing built-in role, defined identically on both sides: `fastapi_app/lib/permissions/acl_utils.py` (`user_has_annotator_role`) and `app/src/modules/acl-utils.js` (`userHasAnnotatorRole`), with matching `userHasReviewerRole`/`userIsAdmin` checks. No new role work is needed.
- The XML editor (`app/src/modules/xmleditor.js`, `XMLEditor`/`NavXmlEditor`) only supports whole-document read-only via `setReadOnly()`, driven by `state.editorReadOnly` from `app/src/plugins/access-control.js`. There is no range-scoped edit restriction anywhere in the codebase.
- There is no tree/outline view. `<teiHeader>` visibility is handled by CodeMirror code-folding via XPath: `XMLEditor.foldByXpath('//tei:teiHeader')` / `unfoldByXpath(...)` (`app/src/modules/xmleditor.js`), wired to a toolbar switch:
  - `app/src/templates/xmleditor-toolbar.html:53` — `<status-switch name="teiHeaderToggleWidget" text="Header" disabled></status-switch>`.
  - `app/src/plugins/tei-tools.js` — `#toggleTeiHeaderVisibility()` folds/unfolds and persists the choice via `uiStorage.set('teiHeaderVisible', ...)`; `#updateTeiHeaderToggle()` restores that stored preference and disables the switch when no document/no header is present; `onStateUpdate` also disables it when `state.view === 'annotation'`.
  - `app/src/plugins/xml-annotation.js` already forces the switch `checked = false` / `disabled = true` and folds the header while in "annotation mode" (a `view` state, not a role) — a direct precedent for a role-based override, but it targets a different state variable and does not hide the control.
- CodeMirror's built-in fold gutter (`foldGutter()`) remains active regardless of the toggle switch — clicking the gutter arrow can fold/unfold any element manually, independent of the toggle.

## Design

Both parts below apply only to **pure annotators**: `userHasAnnotatorRole(user) && !userHasReviewerRole(user) && !userIsAdmin(user)`, mirroring the precedence `acl-utils.js` already applies elsewhere (reviewer/admin outrank annotator).

### 1. Soft edit guard on `<teiHeader>`

Add a new CM6 extension to `XMLEditor` (`app/src/modules/xmleditor.js`), parallel to the existing `setReadOnly()` pattern:

- New compartment (e.g. `#editGuardCompartment`) and method `setEditGuardXpath(xpath | null)`.
- When set, installs an `EditorState.transactionFilter` that, for transactions carrying a user event (typing, paste, cut — i.e. `tr.isUserEvent(...)` truthy; programmatic transactions such as initial document load or merge-view operations are exempt, same exemption style already used in `setReadOnly()`), resolves the current `<teiHeader>` node's `[from, to)` span via the existing xpath/syntax-tree resolution already used by `foldByXpath`, and drops the transaction (returns `[]`) if any changed range falls inside that span.
- This is a **soft guard**: it only intercepts edits made through the CodeMirror UI by the current user. It does not affect document loading, programmatic replacement, merge/revert operations, or the backend in any way — `<teiHeader>` remains fully writable through those paths.
- Wiring: in `XmlEditorPlugin` (`app/src/plugins/xmleditor.js`), in the same `onStateUpdate` handler that drives `setReadOnly()`, compute the pure-annotator check and call `xmlEditor.setEditGuardXpath(isPureAnnotator ? '//tei:teiHeader' : null)`. No change to `state.editorReadOnly` or `access-control.js` — this is additive and independent of the existing whole-document read-only logic.

### 2. teiHeader hidden by default, toggle hidden

In `app/src/plugins/tei-tools.js`:

- **Toggle visibility**: where the widget is currently `disabled` for missing document/header or `view === 'annotation'`, add: if the current user is a pure annotator, hide the switch entirely (e.g. `hidden` attribute / `display: none`) rather than just disabling it. Reviewer/admin behavior is unchanged.
- **Default fold state**: in `#updateTeiHeaderToggle()`, for a pure annotator, always fold the header on document load (`foldByXpath('//tei:teiHeader')`) regardless of the stored `teiHeaderVisible` preference, and do not read or write that preference for this role — since the switch is hidden, no user-driven toggle event fires anyway, so this only affects the initial-load branch.
- **Manual unfold stays available**: no change to `foldGutter()` — a pure annotator can still click the gutter arrow to unfold `<teiHeader>` manually. This is intentional: the requirement is reduced clutter by default, not an absolute prohibition.
- Interaction with existing annotation-mode override (`xml-annotation.js`): both mechanisms push toward folded/hidden, so no conflict; the role-based hide/fold is independent of and composes with the existing `view === 'annotation'` override.

## Testing

- Unit test for the edit guard: with `setEditGuardXpath('//tei:teiHeader')` active, a simulated user-event transaction targeting a position inside `<teiHeader>` is rejected (document unchanged); the same transaction targeting `<text>` succeeds; a non-user-event transaction (e.g. programmatic `setDocument`) touching `<teiHeader>` succeeds.
- Unit/E2E test for tei-tools.js: loading a document as a pure-annotator user shows the header folded and the toggle switch hidden; loading as reviewer/admin is unchanged (switch visible, existing disable/preference logic intact).
- E2E: as an annotator, manually unfolding `<teiHeader>` via the gutter works, and typing inside the unfolded header is rejected by the editor while typing inside `<text>` succeeds.
- Run the full suite (`npm run test:unit`, `npm run test:e2e`) before finishing, per project rules.

## Migration

None. No stored data or API changes. Existing `teiHeaderVisible` UI-storage preference is untouched for all roles except that it is no longer read/written on load for pure annotators.

## Deferred / explicitly out of scope

- **No backend enforcement.** `fastapi_app/routers/files_save.py` is not changed. `<teiHeader>` remains fully editable via the API and by other roles — this feature only guards against accidental in-editor edits by annotators, not deliberate or programmatic changes. If a hard boundary is ever needed, it would require a separate diff-based check in the save path (comparing old/new `teiHeader` subtree) plus role gating — out of scope here by explicit product decision.
- **No change to fold-gutter behavior.** Manual fold/unfold via the gutter stays available to all roles.
- **No new role or permission model.** Reuses the existing `annotator` role and existing `acl-utils.js` helpers as-is.
