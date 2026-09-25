# Annotation Review UI (Parts D + E) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the already-merged `annotation_review` plugin (Part C) a UI: a Tools-menu item "Review Annotations" (Part D) and display of the returned findings as editor diagnostics, each with a "Propose fix" action that opens the existing merge view showing exactly that one change (Part E). Spec: `docs/superpowers/specs/2026-09-24-llm-annotation-review-design.md`, Parts D and E.

**Architecture:** Almost everything lives in the existing frontend extension `fastapi_app/plugins/annotation_review/extensions/annotation-review.js`. Two small app-side additions are needed because the spec's Part E assumption ("a second `linter()` source composed alongside `tei-validation`'s") is wrong: CodeMirror keeps **one global diagnostic set** (`setDiagnosticsEffect` replaces it wholesale, verified in `node_modules/@codemirror/lint/dist/index.js`), so any validation run would wipe the findings. Instead the extension stores its findings and **merges** them into the current diagnostics, re-merging whenever something else replaces the set. Extensions are IIFEs and cannot import `@codemirror/lint`, so the merge helpers go into a new `@registerModule` module `app/src/modules/lint-utils.js`, reachable via `getDependency('lint-utils')` exactly like `tei-utils`/`sl-utils`. `tei-validation`'s `#removeDiagnosticsInChangedRanges` currently rebuilds diagnostics with only 4 fields and would drop `source`/`actions`; it is changed to preserve them.

**Tech Stack:** CodeMirror 6 (`@codemirror/lint` 6.9.7, `@codemirror/state`), the app's `xmleditor` plugin API (`getView`, `addUpdateListener`, `showMergeView`, `on`), `tools.addMenuItems`, Node built-in test runner.

**Branch/commit conventions:** work on a feature branch `feature/annotation-review-ui` off `devel`; commit messages end with `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>`. JS tests: `npm run test:unit:js -- <path>` (the runner takes file paths, it has **no** `--grep`). Do not rebuild after frontend changes; never restart the dev server.

---

## Grounding — confirmed facts

- `@codemirror/lint`: `setDiagnostics(state, diagnostics)` returns a TransactionSpec; `forEachDiagnostic(state, (d, from, to) => ...)` yields the stored `Diagnostic` objects (including `actions`, `source`); `setDiagnosticsEffect` is exported and can be tested with `effect.is(...)`. A `Diagnostic` is `{from, to, severity: 'info'|'warning'|'error'|'hint', message, source?, actions?: {name, apply(view, from, to)}[]}`. Dispatching from inside an `updateListener` is not allowed - defer with `setTimeout(..., 0)`.
- `app/src/plugins/xmleditor.js` `getApi()` proxies the inner `NavXmlEditor`: `getView()`, `addUpdateListener(fn)`, `on(event, fn)`, `getXmlTree()`, `getEditorContent()`, `showMergeView(xmlString)` (async, replaces an existing merge view), events `editorReady`, `editorXmlNotWellFormed`, `editorXmlWellFormed`, `editorAfterLoad`.
- Accept/reject of a merge view is done with the existing toolbar buttons ("accept all"/"reject all", `acceptAllDiffs`/`rejectAllDiffs`); nothing new is needed. The merge view diffs the live document against the string given to `showMergeView`.
- `tei-validation.js:45` registers its own `linter(...)`; its `#removeDiagnosticsInChangedRanges` (`tei-validation.js:~262-290`) rebuilds diagnostics via `forEachDiagnostic` copying only `column/from/to/severity/message`.
- Modules tagged `@registerModule` in their source are auto-registered by `node bin/generate-modules.js` into `app/src/module-registry.js` under the file's base name (e.g. `sl-utils`, `tei-utils`).
- Menu API as in `tei-annotator.js`: `this.getDependency('tools').addMenuItems([item], 'annotation')`; spinner: `this.getDependency('ui').spinner.show(msg)` / `.hide()`; toasts: `this.getDependency('sl-utils').notify(msg, variant, icon)`.
- The extension (Part C) currently has `deps: []`, methods `hasReviewableRules(xmlDoc)` and `review(override)` (returns `findings|null`, notifies on failure). Findings are `{id, old, new, rationale}`; `old` occurs exactly once in the `<text>` element's **raw** text.
- Extensions may have named exports besides the default class (precedent: `tei-annotator.js` exports `getIndentation`), which is how pure helpers are unit-tested.

---

## Task 1: `lint-utils` module (merge helpers)

**Files:**
- Create: `app/src/modules/lint-utils.js`
- Create: `tests/unit/js/lint-utils.test.js`
- Modify (generated): `app/src/module-registry.js` via `node bin/generate-modules.js`

- [ ] **Step 1: Write the failing tests**

```js
// tests/unit/js/lint-utils.test.js
/**
 * @testCovers app/src/modules/lint-utils.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { EditorState } from '@codemirror/state';
import { setDiagnostics } from '@codemirror/lint';
import { collectDiagnostics, mergeDiagnostics, replacesDiagnostics } from '../../../app/src/modules/lint-utils.js';

const DOC = 'hello brave new world';

/** @param {import('@codemirror/lint').Diagnostic[]} diagnostics */
function stateWith(diagnostics) {
  const base = EditorState.create({ doc: DOC });
  return base.update(setDiagnostics(base, diagnostics)).state;
}

const validation = { from: 0, to: 5, severity: 'error', message: 'schema error' };

describe('collectDiagnostics', () => {
  it('returns [] for a state without lint state', () => {
    assert.deepStrictEqual(collectDiagnostics(EditorState.create({ doc: DOC })), []);
  });

  it('returns stored diagnostics including their actions and source', () => {
    const action = { name: 'x', apply() {} };
    const state = stateWith([{ ...validation, source: 's', actions: [action] }]);
    const [d] = collectDiagnostics(state);
    assert.strictEqual(d.message, 'schema error');
    assert.strictEqual(d.source, 's');
    assert.strictEqual(d.actions[0].name, 'x');
  });
});

describe('mergeDiagnostics', () => {
  it('keeps foreign diagnostics and appends own ones tagged with the source', () => {
    const state = stateWith([validation]);
    const merged = mergeDiagnostics(state, 'annotation-review', [
      { from: 6, to: 11, severity: 'info', message: 'rationale' },
    ]);
    assert.strictEqual(merged.length, 2);
    assert.ok(merged.some(d => d.message === 'schema error'));
    assert.strictEqual(merged.find(d => d.message === 'rationale').source, 'annotation-review');
  });

  it('replaces earlier diagnostics of the same source instead of duplicating them', () => {
    const state = stateWith([
      validation,
      { from: 6, to: 11, severity: 'info', message: 'old rationale', source: 'annotation-review' },
    ]);
    const merged = mergeDiagnostics(state, 'annotation-review', [
      { from: 12, to: 15, severity: 'info', message: 'new rationale' },
    ]);
    assert.deepStrictEqual(merged.map(d => d.message).sort(), ['new rationale', 'schema error']);
  });

  it('removes all diagnostics of the source when given an empty list', () => {
    const state = stateWith([
      validation,
      { from: 6, to: 11, severity: 'info', message: 'r', source: 'annotation-review' },
    ]);
    assert.deepStrictEqual(mergeDiagnostics(state, 'annotation-review', []).map(d => d.message), ['schema error']);
  });
});

describe('replacesDiagnostics', () => {
  it('is true for an update whose transaction carries setDiagnosticsEffect', () => {
    const base = EditorState.create({ doc: DOC });
    const tr = base.update(setDiagnostics(base, [validation]));
    assert.strictEqual(replacesDiagnostics({ transactions: [tr] }), true);
  });

  it('is false for a plain document edit', () => {
    const base = EditorState.create({ doc: DOC });
    const tr = base.update({ changes: { from: 0, insert: 'x' } });
    assert.strictEqual(replacesDiagnostics({ transactions: [tr] }), false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test:unit:js -- tests/unit/js/lint-utils.test.js`
Expected: FAIL - module `lint-utils.js` does not exist.

- [ ] **Step 3: Write `app/src/modules/lint-utils.js`**

```js
/**
 * @registerModule
 */

/**
 * Helpers for contributing diagnostics from a plugin without clobbering the
 * diagnostics other plugins (e.g. tei-validation) put into the editor.
 *
 * CodeMirror keeps a single global diagnostic set: `setDiagnostics()` replaces
 * it wholesale. A plugin that owns its own diagnostics therefore has to merge
 * them into the current set and re-merge whenever something else replaces it.
 * This module exists so that frontend extensions (which cannot use ES imports)
 * can do that via `getDependency('lint-utils')`.
 *
 * @import { Diagnostic } from '@codemirror/lint'
 * @import { EditorState } from '@codemirror/state'
 * @import { EditorView, ViewUpdate } from '@codemirror/view'
 */

import { forEachDiagnostic, setDiagnostics, setDiagnosticsEffect } from '@codemirror/lint';

/**
 * Returns the diagnostics currently stored in the editor state.
 * @param {EditorState} state
 * @returns {Diagnostic[]}
 */
export function collectDiagnostics(state) {
  /** @type {Diagnostic[]} */
  const result = [];
  forEachDiagnostic(state, (d, from, to) => {
    result.push({ ...d, from, to });
  });
  return result;
}

/**
 * Returns the current diagnostics with all diagnostics of `source` replaced
 * by `own` (each tagged with `source`).
 * @param {EditorState} state
 * @param {string} source - Identifier marking diagnostics that belong to the caller
 * @param {Diagnostic[]} own
 * @returns {Diagnostic[]}
 */
export function mergeDiagnostics(state, source, own) {
  const foreign = collectDiagnostics(state).filter(d => d.source !== source);
  return [...foreign, ...own.map(d => ({ ...d, source }))];
}

/**
 * Merges `own` into the view's diagnostics and dispatches the result.
 * @param {EditorView} view
 * @param {string} source
 * @param {Diagnostic[]} own
 */
export function applyMergedDiagnostics(view, source, own) {
  view.dispatch(setDiagnostics(view.state, mergeDiagnostics(view.state, source, own)));
}

/**
 * True if the update contains a transaction that replaced the diagnostic set
 * (e.g. a validation run finished).
 * @param {Pick<ViewUpdate, 'transactions'>} update
 * @returns {boolean}
 */
export function replacesDiagnostics(update) {
  return update.transactions.some(tr => tr.effects.some(e => e.is(setDiagnosticsEffect)));
}
```

- [ ] **Step 4: Regenerate the module registry and run tests**

Run: `node bin/generate-modules.js`
Expected: `app/src/module-registry.js` now contains `'lint-utils': lintUtils` and the matching import; nothing else changes (check `git diff app/src/module-registry.js`).

Run: `npm run test:unit:js -- tests/unit/js/lint-utils.test.js`
Expected: PASS. If `collectDiagnostics` on a state with no lint field throws, guard it (the first test covers this) - `forEachDiagnostic` uses `state.field(lintState, false)` and should not.

- [ ] **Step 5: Commit**

```bash
git add app/src/modules/lint-utils.js tests/unit/js/lint-utils.test.js app/src/module-registry.js
git commit -m "feat(lint-utils): add helpers to merge plugin diagnostics into the editor"
```

---

## Task 2: Keep `source`/`actions` when tei-validation prunes diagnostics

**Files:**
- Modify: `app/src/plugins/tei-validation.js` (`#removeDiagnosticsInChangedRanges`, ~line 262-290)

- [ ] **Step 1: Read the current function and any existing test**

Read `#removeDiagnosticsInChangedRanges`. Search `tests/` for a `tei-validation` test (`grep -rl "tei-validation" tests/unit`). If a unit test for this plugin exists, extend it (Step 2); if none exists, skip Step 2 - the plugin is not unit-testable without a full editor and Task 1's tests already cover `mergeDiagnostics`.

- [ ] **Step 2: (only if a test exists) add a failing test** asserting that a surviving diagnostic still has its `source` and `actions` after pruning.

- [ ] **Step 3: Change the rebuild to preserve all fields**

In the `forEachDiagnostic` callback, replace

```js
diagnostics.push({ column: null, from: validFrom, to: validTo, severity: d.severity, message: d.message });
```

with

```js
diagnostics.push({ ...d, from: validFrom, to: validTo });
```

(`d` is the stored `Diagnostic`; spreading keeps `source`, `actions`, and everything else. The existing clamping of `from`/`to` stays. The `column` key was always `null` and is not read anywhere - confirm with `grep -n "\.column" app/src`.)

- [ ] **Step 4: Run the unit suite for regressions**

Run: `npm run test:unit:js`
Expected: PASS (all existing tests).

- [ ] **Step 5: Commit**

```bash
git add app/src/plugins/tei-validation.js
git commit -m "fix(tei-validation): preserve diagnostic source and actions when pruning changed ranges"
```

---

## Task 3: Pure helpers in the extension (locate finding, build modified text, build diagnostics)

**Files:**
- Modify: `fastapi_app/plugins/annotation_review/extensions/annotation-review.js` (add named exports above the class)
- Modify: `fastapi_app/plugins/annotation_review/tests/annotation-review.test.js`

- [ ] **Step 1: Write the failing tests** (append to the existing test file; add the new names to the existing dynamic import)

```js
const { default: AnnotationReviewExtension, locateFinding, buildModifiedText, findingsToDiagnostics } =
  await import('../extensions/annotation-review.js');
```

(Replace the existing single-name destructure; keep the `global.FrontendExtensionPlugin` stub before it.)

```js
describe('locateFinding', () => {
  const finding = { id: 0, old: '<b>x</b>', new: '<i>x</i>', rationale: 'r' };

  it('returns the range of the single occurrence', () => {
    assert.deepStrictEqual(locateFinding(finding, 'aa<b>x</b>bb'), { from: 2, to: 10 });
  });

  it('returns null when old is absent', () => {
    assert.strictEqual(locateFinding(finding, 'nothing here'), null);
  });

  it('returns null when old occurs more than once', () => {
    assert.strictEqual(locateFinding(finding, '<b>x</b><b>x</b>'), null);
  });
});

describe('buildModifiedText', () => {
  it('replaces exactly the given range with the new text', () => {
    const finding = { id: 0, old: 'BAD', new: 'GOOD', rationale: 'r' };
    assert.strictEqual(buildModifiedText('a BAD b', 2, 5, finding), 'a GOOD b');
  });

  it('returns null when the text at the range no longer equals old', () => {
    const finding = { id: 0, old: 'BAD', new: 'GOOD', rationale: 'r' };
    assert.strictEqual(buildModifiedText('a XYZ b', 2, 5, finding), null);
  });
});

describe('findingsToDiagnostics', () => {
  it('builds one info diagnostic per locatable finding, with a Propose fix action', () => {
    const findings = [
      { id: 0, old: 'AAA', new: 'a', rationale: 'first' },
      { id: 1, old: 'MISSING', new: 'm', rationale: 'dropped' },
    ];
    const proposed = [];
    const result = findingsToDiagnostics(findings, 'x AAA y', (finding, from, to) => proposed.push([finding.id, from, to]));
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].severity, 'info');
    assert.strictEqual(result[0].message, 'first');
    assert.deepStrictEqual([result[0].from, result[0].to], [2, 5]);
    assert.strictEqual(result[0].actions[0].name, 'Propose fix');
    result[0].actions[0].apply({}, 2, 5);
    assert.deepStrictEqual(proposed, [[0, 2, 5]]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test:unit:js -- fastapi_app/plugins/annotation_review/tests/annotation-review.test.js`
Expected: FAIL - the named exports don't exist.

- [ ] **Step 3: Add the helpers** (top of the extension file, after the `@import` doc block, before the class)

```js
/**
 * @typedef {{id: number, old: string, new: string, rationale: string}} Finding
 */

/**
 * Locate the single occurrence of `finding.old` in the current document text.
 * Returns null when it is absent or ambiguous - the document may have changed
 * since the review request was sent, and such findings are dropped silently.
 * @param {Finding} finding
 * @param {string} docText
 * @returns {{from: number, to: number}|null}
 */
export function locateFinding(finding, docText) {
  const from = docText.indexOf(finding.old);
  if (from === -1 || docText.indexOf(finding.old, from + 1) !== -1) return null;
  return { from, to: from + finding.old.length };
}

/**
 * Build the document text with only this finding applied, for the merge view.
 * Returns null if the text at [from, to) is no longer exactly `finding.old`.
 * @param {string} docText
 * @param {number} from
 * @param {number} to
 * @param {Finding} finding
 * @returns {string|null}
 */
export function buildModifiedText(docText, from, to, finding) {
  if (docText.slice(from, to) !== finding.old) return null;
  return docText.slice(0, from) + finding.new + docText.slice(to);
}

/**
 * Turn findings into CodeMirror diagnostics positioned in the current text.
 * @param {Finding[]} findings
 * @param {string} docText
 * @param {(finding: Finding, from: number, to: number) => void} onProposeFix
 * @returns {import('@codemirror/lint').Diagnostic[]}
 */
export function findingsToDiagnostics(findings, docText, onProposeFix) {
  /** @type {import('@codemirror/lint').Diagnostic[]} */
  const diagnostics = [];
  for (const finding of findings) {
    const range = locateFinding(finding, docText);
    if (!range) continue;
    diagnostics.push({
      from: range.from,
      to: range.to,
      severity: 'info',
      message: finding.rationale,
      actions: [{
        name: 'Propose fix',
        apply: (_view, from, to) => onProposeFix(finding, from, to),
      }],
    });
  }
  return diagnostics;
}
```

Note (`app/CLAUDE.md`/root `CLAUDE.md`): type imports must use `@import` tags at the top of the file, never inline `import('...')` types. Replace the `import('@codemirror/lint').Diagnostic` uses above with a top-level tag `@import { Diagnostic } from '@codemirror/lint'` and write `Diagnostic[]`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test:unit:js -- fastapi_app/plugins/annotation_review/tests/annotation-review.test.js`
Expected: PASS (existing 9 + new cases).

- [ ] **Step 5: Commit**

```bash
git add fastapi_app/plugins/annotation_review/extensions/annotation-review.js fastapi_app/plugins/annotation_review/tests/annotation-review.test.js
git commit -m "feat(annotation-review): add pure helpers to turn findings into diagnostics"
```

---

## Task 4: Show findings in the editor and "Propose fix" (Part E)

**Files:**
- Modify: `fastapi_app/plugins/annotation_review/extensions/annotation-review.js`
- Modify: `fastapi_app/plugins/annotation_review/tests/annotation-review.test.js`

Behavior to implement in the class:

- `deps: ['xmleditor']` (it is used in `start()`, so it must be installed first - update the constructor; the Part C review argued `deps: []` only because nothing ran at start).
- `start()`: register `xmleditor.addUpdateListener(update => ...)`: if `lintUtils.replacesDiagnostics(update)` and `!this._rendering` and `this._findings.length`, `setTimeout(() => this._renderFindings(), 0)` (dispatching inside an update listener is illegal).
- `showFindings(findings)`: store, then `_renderFindings()`.
- `clearFindings()`: `this._findings = []` and `_renderFindings()` (an empty own-list removes the tagged diagnostics).
- `_renderFindings()`: `view = xmleditor.getView()`; `own = findingsToDiagnostics(this._findings, view.state.doc.toString(), (f, from, to) => this._proposeFix(f, from, to))`; set `this._rendering = true` in a `try`, call `lintUtils.applyMergedDiagnostics(view, SOURCE, own)`, `finally` reset the flag.
- `_proposeFix(finding, from, to)`: `docText = xmleditor.getView().state.doc.toString()`; `modified = buildModifiedText(docText, from, to, finding)`; if null notify `'The document changed; this finding no longer applies.'` (warning) and return; else `await xmleditor.showMergeView(modified)`.
- `async onXmlChange()`: `this.clearFindings()` (a different document was loaded; findings are stale). Note per `app/CLAUDE.md`: never call `dispatchStateChange` inside handlers - this only dispatches a CodeMirror transaction, which is fine.
- const `SOURCE = 'annotation-review'` (module-level, not exported).

- [ ] **Step 1: Write the failing tests**

Extend `buildExtension` in the test file so the stubbed dependencies include:

```js
    'lint-utils': {
      replacesDiagnostics: opts.replacesDiagnostics ?? (() => false),
      applyMergedDiagnostics: (view, source, own) => lintCalls.push({ view, source, own }),
    },
```

and `xmleditor` gains:

```js
      getView: () => ({ state: { doc: { toString: () => opts.docText ?? '' } } }),
      addUpdateListener: (fn) => { updateListeners.push(fn); },
      showMergeView: async (text) => { mergeViews.push(text); },
```

(declare `const lintCalls = [], updateListeners = [], mergeViews = [];` next to `notifyCalls` and return them from `buildExtension`). Because Task 5 makes `start()` create a menu item, also put **all** of Task 5's stubs into `buildExtension` now (`tools.addMenuItems`, `ui.spinner`, `xmleditor.on`, and the `global.document.createElement` stub, returning `menuAdds`, `spinnerCalls`, `handlers`), so the `start()` calls in the tests below keep working after Task 5. Then add:

```js
describe('showFindings / clearFindings', () => {
  const finding = { id: 0, old: 'AAA', new: 'a', rationale: 'why' };

  it('merges diagnostics for locatable findings under the annotation-review source', () => {
    const { ext, lintCalls } = buildExtension({ docText: 'x AAA y' });
    ext.showFindings([finding]);
    assert.strictEqual(lintCalls.length, 1);
    assert.strictEqual(lintCalls[0].source, 'annotation-review');
    assert.strictEqual(lintCalls[0].own.length, 1);
    assert.strictEqual(lintCalls[0].own[0].message, 'why');
  });

  it('clearFindings merges an empty own list', () => {
    const { ext, lintCalls } = buildExtension({ docText: 'x AAA y' });
    ext.showFindings([finding]);
    ext.clearFindings();
    assert.deepStrictEqual(lintCalls.at(-1).own, []);
  });
});

describe('re-rendering after diagnostics are replaced', () => {
  it('re-merges the stored findings when another source replaced the diagnostics', async () => {
    const { ext, lintCalls, updateListeners } = buildExtension({
      docText: 'x AAA y',
      replacesDiagnostics: () => true,
    });
    await ext.start();
    ext.showFindings([{ id: 0, old: 'AAA', new: 'a', rationale: 'why' }]);
    const before = lintCalls.length;
    updateListeners[0]({ transactions: [] });
    await new Promise(r => setTimeout(r, 5));
    assert.strictEqual(lintCalls.length, before + 1);
  });

  it('does not re-merge while it is itself applying diagnostics', async () => {
    const { ext, lintCalls, updateListeners } = buildExtension({ docText: 'x AAA y', replacesDiagnostics: () => true });
    await ext.start();
    // simulate the listener firing synchronously inside our own dispatch
    ext._rendering = true;
    ext._findings = [{ id: 0, old: 'AAA', new: 'a', rationale: 'why' }];
    updateListeners[0]({ transactions: [] });
    await new Promise(r => setTimeout(r, 5));
    assert.strictEqual(lintCalls.length, 0);
  });
});

describe('Propose fix', () => {
  it('opens the merge view with only that finding applied', async () => {
    const { ext, mergeViews } = buildExtension({ docText: 'x AAA y' });
    await ext._proposeFix({ id: 0, old: 'AAA', new: 'a', rationale: 'r' }, 2, 5);
    assert.deepStrictEqual(mergeViews, ['x a y']);
  });

  it('notifies instead when the text no longer matches', async () => {
    const { ext, mergeViews, notifyCalls } = buildExtension({ docText: 'x ZZZ y' });
    await ext._proposeFix({ id: 0, old: 'AAA', new: 'a', rationale: 'r' }, 2, 5);
    assert.strictEqual(mergeViews.length, 0);
    assert.strictEqual(notifyCalls[0][1], 'warning');
  });
});

describe('onXmlChange', () => {
  it('drops stale findings', async () => {
    const { ext, lintCalls } = buildExtension({ docText: 'x AAA y' });
    ext.showFindings([{ id: 0, old: 'AAA', new: 'a', rationale: 'r' }]);
    await ext.onXmlChange('newdoc');
    assert.deepStrictEqual(lintCalls.at(-1).own, []);
  });
});
```

- [ ] **Step 2: Run to verify it fails** (`npm run test:unit:js -- fastapi_app/plugins/annotation_review/tests/annotation-review.test.js`; expected FAIL: `showFindings is not a function` etc.)

- [ ] **Step 3: Implement** exactly as described in the behavior list above (constructor `deps: ['xmleditor']`, fields `_findings = []`, `_rendering = false`). Use `this.getDependency('lint-utils')` lazily inside methods. JSDoc every method; type imports via top-level `@import` tags.

- [ ] **Step 4: Run tests** - expected PASS, including the earlier 9 Part-C tests (`review`/`hasReviewableRules` unchanged; the constructor's `deps` change must not break them since they stub `getDependency`).

- [ ] **Step 5: Commit**

```bash
git add fastapi_app/plugins/annotation_review/extensions/annotation-review.js fastapi_app/plugins/annotation_review/tests/annotation-review.test.js
git commit -m "feat(annotation-review): show findings as diagnostics with a Propose fix action"
```

---

## Task 5: Tools-menu item and `runReview()` (Part D)

**Files:**
- Modify: `fastapi_app/plugins/annotation_review/extensions/annotation-review.js`
- Modify: `fastapi_app/plugins/annotation_review/tests/annotation-review.test.js`

Behavior:

- Constructor `deps: ['xmleditor', 'tools']`.
- `start()` additionally creates `const item = document.createElement('sl-menu-item'); item.textContent = 'Review Annotations'; item.disabled = true; item.addEventListener('click', () => this.runReview());`, stores it as `this._menuItem`, and calls `this.getDependency('tools').addMenuItems([item], 'annotation')`. It also subscribes `xmleditor.on('editorReady', () => this._updateMenuState())` and `xmleditor.on('editorXmlNotWellFormed', () => this._updateMenuState())`, then calls `_updateMenuState()` once.
- `_updateMenuState()`: `tree = xmleditor.getXmlTree()`; `this._menuItem.disabled = !tree || !this.hasReviewableRules(tree)`. Wrap nothing in try/catch - `getEditorialDeclGuides` only throws for an invalid document object, which `!tree` already excludes.
- `async onXmlChange()` (from Task 4) also calls `_updateMenuState()` after clearing findings (return early if `this._menuItem` is not yet set, since `onXmlChange` can run before `start()`).
- `async runReview(override)`: `ui = this.getDependency('ui')`; `ui.spinner.show('Reviewing annotations…')`; `try { findings = await this.review(override); if (findings === null) return; this.showFindings(findings); notify(findings.length ? \`${findings.length} suggestion(s) - see the highlighted passages.\` : 'No issues found.', findings.length ? 'primary' : 'success', findings.length ? 'info-circle' : 'check-circle'); } finally { ui.spinner.hide(); }`. `review()` already notifies on its own failure paths, so `null` returns silently.
- Icons used in notify are existing names (`info-circle`, `check-circle`); no template change.
- **Verify** that `'annotation'` is an accepted category for `tools.addMenuItems` (read `app/src/plugins/tools.js` `addMenuItems`; `tei-annotator.js` already uses it, so it should be). If categories are registered somewhere and only exist when tei-annotator is enabled, report back before continuing.

- [ ] **Step 1: Write the failing tests** (the stubs are already in `buildExtension` from Task 4; they are `tools: { addMenuItems: (items, category) => menuAdds.push({ items, category }) }`, `ui: { spinner: { show: (m) => spinnerCalls.push(['show', m]), hide: () => spinnerCalls.push(['hide']) } }`, `xmleditor.on: (event, fn) => { handlers[event] = fn; }`, and a `global.document = { createElement: () => ({ addEventListener(t, fn) { this._click = fn; }, style: {} }) }` stub set at the top of the file before the import; return `menuAdds`, `spinnerCalls`, `handlers` from `buildExtension`):

```js
describe('menu item', () => {
  it('adds a disabled "Review Annotations" item to the annotation category', async () => {
    const { ext, menuAdds } = buildExtension({ xmlDoc: null });
    await ext.start();
    assert.strictEqual(menuAdds.length, 1);
    assert.strictEqual(menuAdds[0].category, 'annotation');
    assert.strictEqual(menuAdds[0].items[0].textContent, 'Review Annotations');
    assert.strictEqual(menuAdds[0].items[0].disabled, true);
  });

  it('enables the item once the document has reviewable rules', async () => {
    const { ext, menuAdds, handlers } = buildExtension({
      getEditorialDeclGuides: () => [{ category: 'p', refs: [{ target: 'x', contentType: null, subtype: 'machine' }] }],
    });
    await ext.start();
    handlers.editorReady();
    assert.strictEqual(menuAdds[0].items[0].disabled, false);
  });

  it('keeps the item disabled when there is no machine rule ref', async () => {
    const { ext, menuAdds, handlers } = buildExtension({ getEditorialDeclGuides: () => [] });
    await ext.start();
    handlers.editorReady();
    assert.strictEqual(menuAdds[0].items[0].disabled, true);
  });
});

describe('runReview', () => {
  const rules = [{ category: 'p', refs: [{ target: 'x', contentType: null, subtype: 'machine' }] }];

  it('shows a spinner, displays findings and reports the count', async () => {
    const { ext, spinnerCalls, notifyCalls, lintCalls } = buildExtension({
      getEditorialDeclGuides: () => rules,
      defaultModel: { providerId: 'p', modelId: 'm' },
      docText: 'x AAA y',
      callPluginApiImpl: async () => ({ findings: [{ id: 0, old: 'AAA', new: 'a', rationale: 'r' }] }),
    });
    await ext.runReview();
    assert.deepStrictEqual(spinnerCalls.map(c => c[0]), ['show', 'hide']);
    assert.strictEqual(lintCalls.at(-1).own.length, 1);
    assert.match(notifyCalls.at(-1)[0], /1 suggestion/);
  });

  it('reports when nothing was found', async () => {
    const { ext, notifyCalls } = buildExtension({
      getEditorialDeclGuides: () => rules,
      defaultModel: { providerId: 'p', modelId: 'm' },
      callPluginApiImpl: async () => ({ findings: [] }),
    });
    await ext.runReview();
    assert.strictEqual(notifyCalls.at(-1)[1], 'success');
  });

  it('hides the spinner and shows nothing when review() fails', async () => {
    const { ext, spinnerCalls, lintCalls } = buildExtension({
      getEditorialDeclGuides: () => rules,
      defaultModel: { providerId: 'p', modelId: 'm' },
      callPluginApiImpl: async () => { throw new Error('boom'); },
    });
    await ext.runReview();
    assert.deepStrictEqual(spinnerCalls.map(c => c[0]), ['show', 'hide']);
    assert.strictEqual(lintCalls.length, 0);
  });
});
```

- [ ] **Step 2: Run to verify it fails.**
- [ ] **Step 3: Implement** per the behavior list.
- [ ] **Step 4: Run** `npm run test:unit:js -- fastapi_app/plugins/annotation_review/tests/annotation-review.test.js` (PASS) and `npm run test:unit:js` (no regressions).
- [ ] **Step 5: Commit**

```bash
git add fastapi_app/plugins/annotation_review/extensions/annotation-review.js fastapi_app/plugins/annotation_review/tests/annotation-review.test.js
git commit -m "feat(annotation-review): add Tools-menu trigger for the annotation review"
```

---

## Task 6: Correct the design spec and document the pattern

**Files:**
- Modify: `docs/superpowers/specs/2026-09-24-llm-annotation-review-design.md` (Part E)
- Modify: `docs/development/frontend-extensions.md`

- [ ] **Step 1:** In the spec's Part E, replace the paragraph starting "Findings become a **second `linter()` source**..." (and the "verify during implementation that both sources' diagnostics render coherently" note) with a short description of what was built: findings are merged into the single global diagnostic set via `lint-utils` and re-merged when another source replaces it, because CodeMirror keeps one global set and `setDiagnostics` replaces it wholesale.
- [ ] **Step 2:** In `docs/development/frontend-extensions.md`, add a short "Contributing editor diagnostics" section: extensions cannot import `@codemirror/lint`; use `getDependency('lint-utils')` (`mergeDiagnostics`, `applyMergedDiagnostics`, `replacesDiagnostics`, `collectDiagnostics`), tag your diagnostics with a `source`, and re-apply from an `xmleditor.addUpdateListener` handler (deferred with `setTimeout`) when `replacesDiagnostics(update)` is true and you are not the one dispatching.
- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/specs/2026-09-24-llm-annotation-review-design.md docs/development/frontend-extensions.md
git commit -m "docs: describe merge-based diagnostics for annotation review"
```

---

## Final check

- [ ] `npm run test:unit:js` - all pass. `uv run python tests/unit-test-runner.py fastapi_app/plugins` - all pass.
- [ ] **Manual verification in the browser** (report exactly what was and was not observed; if the app can't be exercised, say so): open a TEI document whose `editorialDecl` has a `machine` ref, with a default model selected in Tools > Default Model. Confirm: (1) Tools > Annotation > "Review Annotations" is enabled (and disabled for a document without such a ref); (2) clicking it shows the spinner, then highlighted passages with the rationale as tooltip; (3) triggering validation (edit something, wait) does **not** remove the highlights; (4) "Propose fix" opens the merge view with exactly one changed span; accepting via the toolbar changes only that span; rejecting leaves the document untouched.

## Out of scope

Per-call provider/model override UI; persisting findings in the document; automatic/background review (all listed as out of scope in the spec).
