# Unified Save Dialog & TEI Label Storage Refactoring

## Context

The previous UI had two separate buttons — "Create New Version" and "Save Revision" — whose distinction was not intuitive to users. Creating a copy without recording a revision entry was common, leaving change histories empty. Version labels were stored in `editionStmt/edition/title`, which is not idiomatic TEI for user-assigned labels.

The goal was a single "Save Revision" dialog that always records a `<change>` entry. Whether to save in the current document or fork to a personal copy is a destination choice inside the dialog. Labels are stored as `<note type="label">` inside the last `<change>` element.

---

## Design Decisions

- **TEI label element**: `<note type="label">` inside `<change>` (more idiomatic than `<label>`).
- **Checkbox visibility**: always shown; auto-checked + disabled only in owner-based mode when the user doesn't own the document.
- **Label in editMetadata dialog**: removed. Labels are set only when saving a revision.
- **Default change description**: "Initial revision" when saving to a new copy; "Corrections" when saving in place.
- **Default copy label**: `v{N} ({userId})` where N = count of non-gold artifacts + 1.
- **Backward compatibility**: `editionStmt/edition/title` remains supported as a fallback label source. No migration needed.
- **editionStmt**: keep `<edition><date>` and `<idno type="fileref">` when creating a copy; stop writing `<title>` and `<note>`.

---

## New TEI Structure

```xml
<revisionDesc>
  <change when="2026-03-15T..." status="draft" who="#cboulanger">
    <note type="label">v1 (cboulanger)</note>
    <desc>Initial revision</desc>
  </change>
</revisionDesc>
```

Label extraction priority (JS and Python):
1. Last `revisionDesc/change/note[@type="label"]`
2. Fallback: `editionStmt/edition/title`

---

## Files Changed

| Action | File |
|--------|------|
| NEW | `app/src/templates/save-document-dialog.html` |
| DELETE | `app/src/templates/new-version-dialog.html` |
| DELETE | `app/src/templates/save-revision-dialog.html` |
| UPDATE | `app/src/templates/document-action-buttons.html` |
| UPDATE | `app/src/templates/edit-metadata-dialog.html` |
| UPDATE | `app/src/plugins/document-actions.js` |
| UPDATE | `app/src/ui.js` |
| UPDATE | `app/src/modules/tei-utils.js` |
| UPDATE | `fastapi_app/lib/utils/tei_utils.py` |
| UPDATE | `docs/development/example.tei.xml` |
| UPDATE | `tests/e2e/tests/document-actions.spec.js` |
| UPDATE | `app/src/plugins/access-control.js` |
| UPDATE | `app/web/app.css` |

---

## Implementation

### Dialog template

The final dialog uses named `<div>` wrappers to group related controls. This enables clean show/hide and proper UI hierarchy traversal:

```html
<div name="saveToNewCopySection" class="dialog-checkbox-section">
  <sl-checkbox name="saveToNewCopy">Save to a new personal copy</sl-checkbox>
  <p class="help-text">...</p>
  <sl-input name="copyLabel" ...></sl-input>
</div>

<sl-input name="changeDesc" ...></sl-input>
<sl-select name="status" ...></sl-select>
<sl-divider></sl-divider>

<div name="saveAsGoldSection" class="dialog-checkbox-section">
  <sl-checkbox name="saveAsGold">Save as Gold Version</sl-checkbox>
  <p class="help-text">...</p>
</div>
```

Elements are accessed via the UI hierarchy:
- `ui.saveDocumentDialog.saveToNewCopySection.saveToNewCopy`
- `ui.saveDocumentDialog.saveToNewCopySection.copyLabel`
- `ui.saveDocumentDialog.saveAsGoldSection.saveAsGold`

The `Username` and `Full Name` fields were removed from the dialog. User identity is read directly from `authentication.getUser()` and passed to `respStmt`/`revisionChange` without being displayed.

### document-actions.js

`createNewVersion()` and `saveRevision()` were merged into a single `saveDocument(state)` function. The `saveToNewCopy` checkbox drives which path is taken after submit:

- **Unchecked** (in-place): calls `addTeiHeaderInfo(respStmt, undefined, revisionChange)` then `filedata.saveXml(state.xml)`. No `<note type="label">` is written.
- **Checked** (fork): calls `addTeiHeaderInfo(respStmt, edition, revisionChange)` then `filedata.saveXml(currentFileId, true)`. The `revisionChange.label` is set from `copyLabel.value`, producing `<note type="label">` in the new document's `<change>`.

The `saveToNewCopySection` visibility toggles `copyLabel` show/hide and updates the default `changeDesc`. In owner-based mode where the user is not the owner, the checkbox is pre-checked and disabled.

`editFileMetadata()` was simplified — all label read/write logic removed. Only `docId` and `source` are editable.

### tei-utils.js

- `RevisionChange` typedef extended with optional `label` field.
- `addRevisionChange()` writes `<note type="label">` before `<desc>` when `label` is set.
- New export `getRevisionLabel(xmlDoc)` returns the last `revisionDesc/change/note[@type="label"]` text, falling back to `editionStmt/edition/title`.
- `addEdition()` no longer requires `title` — when omitted, only `<date>` and the preserved `<idno type="fileref">` are written.

### tei_utils.py

- `extract_tei_metadata()` checks `revisionDesc/change/note[@type="label"]` (last element) before falling back to `editionStmt/edition/title`.
- `add_revision_change()` accepts an optional `label` parameter, written as `<note type="label">` before `<desc>`.

### access-control.js

Owner-based notification messages updated to reference the new workflow:
- "Use 'Save Revision → Save to a new personal copy' to work on your own copy."
- Status bar: "Read-only (owned by {owner}) — save to a personal copy to edit"

### CSS

New rules in `app.css`:
- `.dialog-column > p` — normalized font size and color for intro text.
- `.dialog-column .help-text` — indented under checkbox labels via `calc(toggle-size + spacing)`; flush-left when following `sl-input`/`sl-select`.
- `.dialog-checkbox-section` — subtle card styling (light background, border, border-radius) for grouping checkbox + help text + related inputs.

### E2E tests

All 8 tests in `document-actions.spec.js` updated:

| Old | New |
|-----|-----|
| "should create new version from existing document" | "should create a new copy via saveToNewCopy checkbox" |
| `newVersionDialog` selectors | `saveDocumentDialog.saveToNewCopySection.*` |
| `newRevisionChangeDialog` selectors | `saveDocumentDialog.*` |
| `saveAsGold.style.display` | `saveAsGoldSection.style.display` |

The "create new version" flow in annotator tests no longer needs a separate setup step — the unified dialog is opened directly and `saveToNewCopy` toggled.

---

## Deviations from Plan

- **`persId`/`persName` removed from dialog**: the plan kept them as display-only fields. Removed after review because they add visual noise without user value. User identity is read from the auth object directly.
- **Named section wrappers** (`saveToNewCopySection`, `saveAsGoldSection`): not in the original plan. Added to support show/hide of checkbox+help-text together and to enable proper UI hierarchy access.
- **`addEdition()` bug fix**: the function threw `"Missing 'title'"` when called without a title (the copy-creation path). Made `title` optional with conditional `<title>` element creation.
- **Checkbox help text as `<p>` elements**: Shoelace's `help-text` attribute on `sl-checkbox` renders at a different size than on `sl-input`. Replaced with `<p class="help-text">` and a CSS rule to normalize appearance.
