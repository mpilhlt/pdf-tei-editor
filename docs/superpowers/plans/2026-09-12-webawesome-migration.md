# Shoelace → Web Awesome Migration: High-Level Phased Plan

> **For agentic workers:** This is a **master/phasing plan**, not a bite-sized execution plan. Each phase below is scoped to be one independent session. **Before executing a phase**, run `superpowers:writing-plans` again for that phase alone (spec = the phase's "Scope" + "Key findings" sections) to produce the bite-sized, code-level task list, then execute with `superpowers:subagent-driven-development` or `superpowers:executing-plans`. Do not try to execute phases directly from this document — it deliberately stays at the level of files/areas/risks, not exact diffs, because several details depend on live Web Awesome docs that should be re-checked at the start of each phase (the library is under active development).

**Tracking issue:** [#458](https://github.com/mpilhlt/pdf-tei-editor/issues/458)

**Goal:** Replace `@shoelace-style/shoelace` (2.20, unmaintained) with `@awesome.me/webawesome` across the entire frontend, with zero functional regressions, in a sequence of independently mergeable sessions.

**Architecture / key strategy decision:** Shoelace and Web Awesome use disjoint custom-element tag prefixes (`sl-*` vs `wa-*`) and disjoint CSS custom-property prefixes (`--sl-*` vs `--wa-*`). This means **both libraries can be loaded side by side** for the duration of the migration with no tag/registration collisions. This is what makes a "several independent sessions" approach viable: install Web Awesome once (Phase 1), then migrate one functional area at a time behind the existing test suite, and only remove Shoelace at the very end (Phase 9). At no intermediate point does the app need to be in a broken or half-working state.

---

## Current Shoelace footprint (inventory, as of 2026-09-12)

Gathered by grepping the repo; re-verify counts at the start of Phase 0 since the codebase moves.

- **Dependency:** `@shoelace-style/shoelace` `2.20` in [package.json](../../../package.json), plus transitive `@shoelace-style/localize`.
- **Loading:** [app/web/bootstrap.js](../../../app/web/bootstrap.js) injects the Shoelace base path + `light.css` theme; [app/web/importmap.json](../../../app/web/importmap.json) maps `@shoelace-style/shoelace/...` for dev-mode source loading.
- **Central registration:** [app/src/ui.js](../../../app/src/ui.js) imports 20 Shoelace component classes (`SlDialog`, `SlButton`, `SlButtonGroup`, `SlTextarea`, `SlInput`, `SlSelect`, `SlOption`, `SlIcon`, `SlTooltip`, `SlPopup`, `SlDropdown`, `SlMenu`, `SlMenuItem`, `SlCheckbox`, `SlDivider`, `SlSwitch`, `SlIconButton`, `SlProgressBar`, `SlDrawer`, `SlTree`, `SlTreeItem`, `SlSplitPanel`) and uses them as JSDoc types throughout the `UI` typedef tree.
- **Templates:** 37 files under `app/src/templates/*.html` use `<sl-*>` tags directly.
- **19 distinct `<sl-*>` tag names in use:** `sl-button`, `sl-button-group`, `sl-checkbox`, `sl-dialog`, `sl-divider`, `sl-drawer`, `sl-dropdown`, `sl-icon`, `sl-icon-button`, `sl-input`, `sl-menu`, `sl-menu-item`, `sl-option`, `sl-popup`, `sl-progress-bar`, `sl-select`, `sl-switch`, `sl-textarea`, `sl-tooltip`, `sl-tree` (plus `sl-tree-item`, `sl-split-panel` used only from JS/ui.js).
- **Modules that build custom elements directly on Shoelace primitives** (deeper coupling than "just a tag"):
  - [app/src/modules/sl-utils.js](../../../app/src/modules/sl-utils.js) — `notify()` instantiates `SlAlert` programmatically for toasts.
  - [app/src/modules/filtered-combobox.js](../../../app/src/modules/filtered-combobox.js) — hand-built combobox composed from `sl-popup` + `sl-input` + `sl-menu` + `sl-menu-item`, listens for `sl-input`/`sl-focus`/`sl-clear`/`sl-select`, re-emits a synthetic `sl-change`, and inlines `--sl-*` CSS variables in its shadow DOM.
  - [app/src/modules/config-value-editor.js](../../../app/src/modules/config-value-editor.js), [app/src/modules/rbac/form-renderer.js](../../../app/src/modules/rbac/form-renderer.js), [app/src/modules/rbac/member-picker.js](../../../app/src/modules/rbac/member-picker.js), [app/src/modules/codemirror/xml-annotation-popup.js](../../../app/src/modules/codemirror/xml-annotation-popup.js), [app/src/modules/panels/widgets/status-switch.js](../../../app/src/modules/panels/widgets/status-switch.js), [app/src/modules/panels/widgets/status-dropdown.js](../../../app/src/modules/panels/widgets/status-dropdown.js) — build or manipulate Shoelace elements programmatically rather than only via HTML templates.
- **CSS:** `--sl-*` custom properties used throughout [app/web/app.css](../../../app/web/app.css) and defined/overridden in [app/web/light.css](../../../app/web/light.css) (a hand-copied Shoelace token palette); a few references in [app/web/pdfjs-viewer.css](../../../app/web/pdfjs-viewer.css).
- **Icons:** no `registerIconLibrary()` call anywhere — the app relies entirely on Shoelace's default bundled **Bootstrap Icons** set. ~50+ distinct icon names are hardcoded as `name="..."`/`icon="..."` attributes across templates and JS (e.g. `check-circle`, `exclamation-triangle-fill`, `cloud-upload`, `folder2-open`, `filetype-pdf`). Web Awesome's default library is **Font Awesome**, with different names for most icons.
- **Tests:** `sl-*` selectors/expectations appear in Playwright E2E specs (`auth-workflow`, `frontend-extension`, `export-workflow`, `document-actions`, `file-drawer-batch-move`, `sse-progress`, `docker-infrastructure`, plus `helpers/extraction-helper.js` and `helpers/login-helper.js`) and in unit tests (`rbac-form-renderer`, `rbac-member-picker`, `xml-annotation-popup`, `ui-storage`).
- **Docs referencing Shoelace by name** (need updates as part of this migration, per this repo's "suggest doc updates" rule): [app/CLAUDE.md](../../../app/CLAUDE.md) ("Shoelace Components" section — tooltip wrappers, checkbox events, dropdown z-index gotchas), `docs/development/architecture.md`, `docs/development/frontend-extensions.md`, `docs/code-assistant/README.md`, `docs/code-assistant/coding-standards.md`, `docs/code-assistant/ui-storage.md`, `docs/code-assistant/testing-guide.md`, `docs/development/api-reference.md`.

## What changes conceptually (from the Web Awesome migration guide)

Full guide: https://webawesome.com/docs/resources/migrating-from-shoelace/ — **re-read it at the start of every phase**, it may have changed since this plan was written.

- Package: `@shoelace-style/shoelace` → `@awesome.me/webawesome`.
- Tags: `sl-*` → `wa-*`. CSS vars: `--sl-*` → `--wa-*`.
- `variant="primary"` → `variant="brand"` everywhere.
- `sl-icon-button` is **removed** — replace with `wa-button` + an icon child. This is a structural change, not a rename.
- `sl-menu`/`sl-menu-item` **consolidate into** `wa-dropdown`/`wa-dropdown-item` (dropdown positioning + menu are merged). Structural change, affects every menu/dropdown in the app.
- Form controls: `help-text` → `hint`, `slot="prefix"/"suffix"` → `slot="start"/"end"`, `clearable` → `with-clear`, `filled` boolean → `appearance="filled"`; native `ElementInternals`-based form association (affects `form.checkValidity()`, `FormData`, native `:invalid`/`:valid` pseudo-classes) — relevant to the RBAC form renderer and config editor.
- Buttons: no more `outline`/`circle` booleans — use `appearance="outlined"|"filled"|"plain"`.
- Events: custom events `sl-*` → `wa-*` (e.g. `sl-show`/`sl-hide`/`sl-after-show`/`sl-after-hide`/`sl-request-close` → `wa-show`/`wa-hide`/`wa-after-show`/`wa-after-hide`/`wa-hide` with `preventDefault()`). **These fail silently** — a stale `addEventListener('sl-show', …)` just never fires, no error.
- `sl-alert` → `wa-callout` (inline, no `open` attribute — conditionally render) or `wa-toast` (for the app's toast/notify use case).
- Theme classes: `sl-theme-light`/`sl-theme-dark` → `wa-light`/`wa-dark`. A **soft-landing** class pair `wa-theme-shoelace wa-palette-shoelace` on `<html>` approximates the old look during transition. New: cascade layers (`@layer wa-component`), optional `native.css`, layout-utility classes (`wa-stack`, `wa-cluster`, `wa-grid`, …) — adopt only if useful, not required.
- Icons: default library is Font Awesome, not Bootstrap Icons. Either (a) register Bootstrap Icons as a custom library (`library="bootstrap"`) to keep all ~50 existing `name="..."` values working unchanged, or (b) rename every icon reference to its Font Awesome equivalent. **Recommendation: do (a) first** to de-risk the migration, and treat (b) as an optional later cleanup — flagged as a decision for Phase 0.
- Components that migrate with just a prefix change (no structural rework expected): `avatar, breadcrumb, card, checkbox, details, divider, icon, popup, progress-bar, radio, rating, skeleton, spinner, switch, tab-group, textarea, tooltip, tree`.
- **Not covered by the guide summary — must be resolved by reading current docs in Phase 0:** exact Web Awesome equivalents (if any) for `sl-split-panel` (used in `layout.js`) and the precise `wa-tree`/`wa-tree-item` API, since this app's tree usage (file selection) may rely on Shoelace-specific tree behaviors (lazy loading, selection API).

---

## Phase sequencing

Each phase is a candidate PR into `devel`. Do NOT start a phase until the previous one is merged and green — later phases assume earlier ones landed. Within a phase, run the full test suite (unit + E2E per [docs/code-assistant/testing-guide.md](../../code-assistant/testing-guide.md)) before considering it done. Because both libraries coexist until Phase 9, every phase leaves the app in a fully working state — there is no "in-progress broken" branch to babysit across sessions.

### Phase 0 — Discovery, decisions, and docs (no code behavior change)

**Scope:** Read the *current* Web Awesome migration guide and component docs live (this plan's summary may be stale). Confirm/replace the open questions above (`sl-split-panel`, `sl-tree` API parity). Make and record three decisions the rest of the plan depends on:
1. Icon strategy — register Bootstrap Icons as a custom library vs. rename to Font Awesome.
2. Theming strategy — adopt the `wa-theme-shoelace`/`wa-palette-shoelace` soft landing first, migrate to native WA tokens/OKLCH palette later (recommended), vs. jumping straight to native WA theming.
3. Branch strategy — one long-lived integration branch that each phase PRs into, vs. each phase branching straight off `devel`. (Given `devel`→`main` merge-commit requirements from this repo's release automation, prefer phase branches straight off `devel`, each a normal squash-or-merge PR into `devel`, to keep `semantic-release` inference simple — confirm with the user.)

**Output:** an updated inventory (this document's "Current Shoelace footprint" section, refreshed) and a short decisions note, either appended here or as a comment on #458.

### Phase 1 — Install Web Awesome alongside Shoelace

**Scope:** Add `@awesome.me/webawesome` to `package.json`; update `app/web/importmap.json` with dev-mode mappings; update `app/web/bootstrap.js` to also load the WA stylesheet/loader (with the soft-landing theme classes from Phase 0's decision) without touching the existing Shoelace loading code. No template or component is migrated yet. **Acceptance:** app looks and behaves identically; full existing test suite passes unchanged.

### Phase 2 — Leaf/presentational components

**Scope:** Components with the "just a prefix change" profile and low JS coupling: `icon`, `divider`, `progress-bar`, `tooltip`, `spinner`, `badge`-like usages, plain `button`/`button-group` (non-icon-button, non-form-critical usages), `checkbox`, `switch`. Update templates tag-by-tag, apply `variant="primary"` → `variant="brand"`, `outline`/`circle` → `appearance="..."` on buttons touched here. Update the corresponding `app/CLAUDE.md` gotchas (tooltip wrapper naming, programmatic-checkbox-doesn't-fire-events — re-verify this still holds under WA) as each is re-verified. Update `ui.js` typedefs for only the fields touched. **Acceptance:** visual smoke test of touched screens + full test suite.

### Phase 3 — Icon buttons → `wa-button` + icon child

**Scope:** `sl-icon-button` has no direct WA equivalent — every usage (toolbar buttons, menu-bar, status-bar widgets, dialog/drawer close buttons, `document-action-buttons`, `extraction-buttons`, `xmleditor-*-buttons`, etc.) becomes a structural change: `<wa-button appearance="plain"><wa-icon name="..."></wa-icon></wa-button>` (confirm exact recommended pattern against live docs). Isolate to its own session because it changes DOM structure/CSS selectors, not just tag names. **Acceptance:** every button that previously showed a bare icon still does, with equivalent hover/focus/disabled states; full test suite; targeted manual check of toolbar/menu-bar/status-bar.

### Phase 4 — Form controls

**Scope:** `input`, `textarea`, `select`/`option`. Apply `help-text`→`hint`, `slot="prefix"/"suffix"`→`slot="start"/"end"`, `clearable`→`with-clear`. Rework `app/src/modules/config-value-editor.js`, `app/src/modules/rbac/form-renderer.js`, `app/src/modules/rbac/member-picker.js` for the new native `ElementInternals` form-association behavior — re-verify `FormData`/`checkValidity()`/`reset()` interactions with these hand-built forms. **Acceptance:** RBAC form renderer and config editor unit tests pass; manually exercise create/edit/validate flows for both.

### Phase 5 — Menus and dropdowns (highest structural risk)

**Scope:** `sl-menu`/`sl-menu-item`/`sl-dropdown` consolidate into `wa-dropdown`/`wa-dropdown-item`. Affects `toolbar-menu-button`, `backend-plugins-dropdown`, `gc-menu-item`, `config-editor-menu-item`, `user-menu-items`, `info-menu-item`, `rbac-manager-menu-item`, `xsl-viewer-button`, the `status-dropdown` widget, `app/src/modules/codemirror/xml-editor-context-menu.js`, and — separately and carefully — the hand-built `app/src/modules/filtered-combobox.js` (which uses `sl-popup` + `sl-menu` + `sl-menu-item` as raw primitives, not `sl-dropdown`, so its migration path needs its own design: confirm in Phase 0/5 whether WA's `wa-popup` + custom items is still the right primitive-level approach, or whether `wa-dropdown` now covers this case). Consider splitting this phase into "toolbar/static menus" and "filtered-combobox" as two sessions if it proves too large for one. Update the "Shoelace dropdown z-index in toolbars" gotcha in `app/CLAUDE.md` (the underlying `sl-show`/`sl-hide` event names become `wa-show`/`wa-hide`). **Acceptance:** every menu opens/closes/positions correctly, including the toolbar dropdown z-index case; keyboard navigation (arrow keys, escape) in `filtered-combobox` still works; full test suite plus manual pass over every menu in the app.

### Phase 6 — Dialogs and drawers

**Scope:** `sl-dialog`/`sl-drawer` → `wa-dialog`/`wa-drawer`. Update `app/src/plugins/dialog.js` and every `*-dialog.html`/`*-drawer.html` template (login, save-document, extraction, prompt-editor, RBAC manager, user profile, config editor, backend-plugins result, TEI wizard, move-files, file-selection-drawer, info-drawer, annotation-guide-drawer, TEI revision-history-drawer). Rename event listeners: `sl-show`/`sl-hide`/`sl-after-show`/`sl-after-hide`/`sl-request-close` → `wa-show`/`wa-hide`/`wa-after-show`/`wa-after-hide`/`wa-hide` (note `wa-request-close` is gone — cancel via `preventDefault()` on `wa-hide`). **Acceptance:** every dialog/drawer opens, closes, and is cancelable where it used to be; full test suite; manual pass over each dialog/drawer.

### Phase 7 — Tree, split-panel, and any other unmapped components

**Scope:** Resolve whatever Phase 0 flagged as unmapped: `sl-tree`/`sl-tree-item` (used in file selection) and `sl-split-panel` (used in `app/src/plugins/layout.js`). If Web Awesome has no direct equivalent for one of these, this phase's job is to design and implement the replacement (native WA primitive, a small custom element, or a documented decision to keep the Shoelace component running indefinitely alongside WA — acceptable given the side-by-side strategy, but record the decision). **Acceptance:** file tree selection/expansion works; resizable split layout works; full test suite.

### Phase 8 — Alerts/toasts, icon library execution, and CSS token migration

**Scope:**
- Rewrite `app/src/modules/sl-utils.js`'s `notify()` from `SlAlert` to `wa-toast`/`wa-callout` per Phase 0's decision.
- Execute the icon strategy decided in Phase 0 (register `library="bootstrap"`, or rename all ~50 icon references to Font Awesome names — the latter is mechanical but must be done in one careful pass with a checklist, since unmapped names silently render as a question mark).
- Migrate `--sl-*` custom properties to `--wa-*` in `app/web/app.css`, `app/web/light.css`, `app/web/pdfjs-viewer.css`, including the size-scale renaming (`small`→`s`, `medium`→`m`, etc.) and the inverted tint-scale direction (Shoelace 50→950 light→dark vs. WA 95→05). Move off the soft-landing theme classes if Phase 0 chose the "soft landing first" path.
**Acceptance:** visual regression pass (light theme, and dark theme if in use) across the main screens; toasts/notifications look and behave correctly; full test suite.

### Phase 9 — Remove Shoelace and final sweep

**Scope:** Remove `@shoelace-style/shoelace` and `@shoelace-style/localize` from `package.json`; remove the Shoelace-loading code in `app/web/bootstrap.js` and the Shoelace entries in `app/web/importmap.json`; delete the now-unused Shoelace imports/types in `app/src/ui.js`; grep the entire repo for stray `sl-`/`--sl-`/`Shoelace`/`shoelace` and resolve every hit (including test files, docs, and `app/CLAUDE.md`'s "Shoelace Components" section, which should be renamed/rewritten as "Web Awesome Components" with re-verified gotchas). Update `docs/development/architecture.md`, `docs/development/frontend-extensions.md`, `docs/code-assistant/README.md`, `docs/code-assistant/coding-standards.md`, `docs/code-assistant/ui-storage.md`, `docs/code-assistant/testing-guide.md`, `docs/development/api-reference.md`. **Acceptance:** `grep -ri shoelace` over the repo (excluding `node_modules`, `package-lock.json`/lockfiles, and historical `docs/history/*`) returns nothing; full test suite green; production build succeeds.

---

## Cross-cutting notes for every phase

- **Tests move with the code.** Update the unit/E2E tests and Playwright selectors for whatever a phase touches *within that phase's session* — don't defer all test updates to Phase 9. Phase 9's sweep is a safety net, not the primary place test updates happen.
- **Silent-failure risks to check manually, not just via grep:** stale `sl-*` event listener strings (no error, just never fires), `slot="prefix"/"suffix"` left un-renamed (renders in the wrong place, not an error), unmapped icon names (renders as a placeholder glyph, not an error), `::part()` CSS selectors that changed names (style silently doesn't apply). Each phase's acceptance check should include manually operating the touched UI, not just running greps.
- **No stylistic refactors.** Per this repo's general rules, keep each phase to the mechanical migration plus the structural changes the library forces (icon-buttons, dropdown/menu consolidation) — don't use this migration as cover for unrelated cleanup.
- **Re-verify `app/CLAUDE.md` gotchas as you go.** Several documented Shoelace quirks (tooltip wrapper naming, programmatic checkbox events, dropdown z-index workaround) may or may not still apply under Web Awesome — confirm empirically per this repo's "prefer empirical debugging" rule rather than assuming.
