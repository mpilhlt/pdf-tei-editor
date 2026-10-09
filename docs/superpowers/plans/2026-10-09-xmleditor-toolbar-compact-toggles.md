# XML Editor Toolbar Compact Toggles Implementation Plan

Spec: `docs/superpowers/specs/2026-10-09-xmleditor-toolbar-compact-toggles-design.md`

**Goal:** Replace the three labeled `<status-switch>` elements in the XML editor toolbar with icon-only `<status-toggle-button>` widgets (filled-pill style), invert the diff-whitespace semantics to "strict diff", and fuse the header fold toggle with the "Edit header metadata" button.

**Tech Stack:** Vanilla custom elements (shadow DOM), Shoelace, `uiStorage`, generated UI types (`npm run build:ui-types`).

## File map

- Create `app/src/modules/panels/widgets/status-toggle-button.js`
- Modify `app/src/modules/panels/index.js` (import, export, `PanelUtils.createToggleButton`)
- Modify `app/src/modules/panels/widgets/status-button.js` (add `part`/class hooks only if needed for group CSS)
- Modify `app/src/templates/xmleditor-toolbar.html`; regenerate `xmleditor-toolbar.types.js`
- Modify `app/src/plugins/xmleditor.js`, `tei-tools.js`, `tei-header-editor.js`, `xml-annotation.js`
- Modify `tests/e2e/tests/annotator-teiheader-safeguard.spec.js`
- Create `tests/unit/js/status-toggle-button.test.js` (if the unit runner can load custom elements; otherwise cover in E2E)
- Update docs mentioning the old names (`docs/code-assistant/*` if any reference them)

## Task 1: `StatusToggleButton` widget and group CSS

- [ ] Create `status-toggle-button.js`: `class StatusToggleButton extends StatusButton`, registered as `status-toggle-button`. Add `checked` to `observedAttributes` (spread `super.observedAttributes`).
- [ ] Click handler (override `handleClick`): return if disabled; toggle `checked` attribute; dispatch `widget-change` (`bubbles: true`, `detail: { checked, widget: this }`). Enter/Space reuse the inherited keydown path.
- [ ] Set `role="button"` and `aria-pressed` on the host, kept in sync in `updateHostProperties`/`attributeChangedCallback`.
- [ ] Override `render()`: wrap the icon in `<sl-tooltip content="${tooltip}">`; do not set the native `title` (override `updateHostProperties` to skip `this.title`).
- [ ] Styles (filled pill): off = neutral chrome (border `--sl-color-neutral-300`); `:host([checked])` = `--sl-color-primary-600` fill with `--sl-color-neutral-0` icon; `:host([disabled])` = `opacity .5`, `filter: saturate(.4)` plus `repeating-linear-gradient(45deg, ...)` hatch overlay over the on/off fill, so disabled-on and disabled-off stay distinct.
- [ ] `.status-toggle-group` styles (in shadow styles of both `StatusButton` and `StatusToggleButton` via `:host-context(.status-toggle-group)`, or a light-DOM `<style>` in the toolbar template if `:host-context` is unsupported): `display: inline-flex; gap: 0`; first child `border-radius: 3px 0 0 3px`; last child `border-radius: 0 3px 3px 0`; middle children radius 0; adjacent children `margin-left: -1px`.
- [ ] `index.js`: import/export `StatusToggleButton`, add `PanelUtils.createToggleButton(options)` with JSDoc (`icon`, `tooltip`, `checked`, `disabled`, `name`).
- [ ] Verify: `npm run test:unit` still passes; manual check in `app/src/modules/panels/demo/index.html` (add a demo entry).

## Task 2: Toolbar template and `xmleditor.js` wiring

- [ ] `xmleditor-toolbar.html`: replace the three switches.
  - `strictDiffToggle`: `<status-toggle-button name="strictDiffToggle" icon="..." tooltip="Strict diff (whitespace &amp; linebreaks significant)">` (unchecked, same position after the accept/reject group).
  - `wrapToggle`: `icon="text-wrap"`, `tooltip="Line wrapping"`, `checked`, own slot.
  - `<span class="status-toggle-group" data-group="header" name="headerGroup">` containing `<status-toggle-button name="headerFoldToggle" icon="..." tooltip="Show/fold TEI header" disabled>`.
  - Pick icons that exist in the bundled Shoelace set (check `app/web`/icon registration before use).
- [ ] Run `npm run build:ui-types`; confirm `xmleditor-toolbar.types.js` exposes `strictDiffToggle`, `wrapToggle`, `headerGroup`, `headerFoldToggle`.
- [ ] `xmleditor.js`: rename `#lineWrappingSwitch` -> `#wrapToggle`, `#ignoreWhitespaceSwitch` -> `#strictDiffToggle`; update the toolbar typedef (`StatusToggleButton`, `@import`), initialisation, listeners, and `disabled` logic (lines ~78-80, 184-187, 434-454, 607-627, 803, 889).
- [ ] Strict diff: preference key `strictDiff` (default `false`); init `toggle.checked = strict` and call `setIgnoreWhitespaceInDiff(!strict)`; listener calls `setIgnoreWhitespaceInDiff(!e.detail.checked)`. Rename getter/setter to `#get/#setStrictDiffPreference`.
- [ ] Keep `lineWrapping` and `teiHeaderVisible` storage keys unchanged.
- [ ] `xml-annotation.js`: update `lineWrappingSwitch` -> `wrapToggle`, `teiHeaderToggleWidget` -> `headerFoldToggle` (lines ~138-172, 439).

## Task 3: Header plugins, tests, docs, cleanup

- [ ] `tei-tools.js`: rename to `headerFoldToggle` (type `StatusToggleButton`); replace the `sl-change` listener with `widget-change` using `event.detail.checked`.
- [ ] `tei-header-editor.js`: remove the `console.error('DEBUG ...')` lines and the now-pointless try/catch wrapper in `install()`/`start()` only if it exists solely for the tracing; append `#headerEditorBtn` to `ui.xmlEditor.toolbar.headerGroup` instead of calling `addToolbarWidget(..., 1)`. Ensure append happens after the fold toggle (DOM order: fold toggle, then edit button).
- [ ] Update `tests/e2e/tests/annotator-teiheader-safeguard.spec.js` (`teiHeaderToggleWidget` -> `headerFoldToggle`); grep `tests/` for the other old names.
- [ ] Grep `docs/` (excluding `docs/history`, `docs/superpowers`) for the old names and update; note the new widget in `docs/code-assistant/architecture-frontend.md` or plugin docs if widgets are listed there.
- [ ] Visual check: `node scripts/dev/ui-screenshot.js --out <scratchpad>/toolbar.png` and inspect on, off, and disabled states and the fused header pair.
- [ ] Run `npm run test:unit` and `npm run test:e2e`; fix regressions (watch for console errors failing E2E).
- [ ] Commit in logical steps on `feature/teiheader-editor-plugin` and push.

## Execution

Tasks run sequentially via subagents (each depends on the previous task's files). Each subagent must read `CLAUDE.md`/`app/CLAUDE.md`, use JSDoc with `@import` blocks, and not commit; the orchestrator reviews the diff, commits, and pushes.
