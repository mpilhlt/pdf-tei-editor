# Browser Tab Title Slots Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show the logged-in username in the browser tab title (e.g. `PDF-TEI Editor (cboulanger)`) via a generic, state-driven title-template mechanism, replacing `XMLEditorPlugin`'s direct `document.title` writes.

**Architecture:** `ApplicationState.titleTemplate` holds a `{slot}`-placeholder string. `StartPlugin` owns the live slot values and the only `document.title` write, exposed to other plugins via a new `ep.title.updateSlots` extension point. `XMLEditorPlugin` keeps computing its own dirty/blocked status prefix but now reports it through that extension point instead of touching the DOM directly. A pure `renderTitleTemplate()` helper in `browser-utils.js` does the substitution and cleans up empty decorations (e.g. stray `()`).

**Tech Stack:** Vanilla JS frontend plugin framework (`app/src/modules/plugin-base.js`), Node's built-in test runner (`node:test`) for unit tests, Playwright for e2e.

Spec: `docs/superpowers/specs/2026-09-12-browser-title-slots-design.md`

---

### Task 1: `renderTitleTemplate()` helper

**Files:**
- Modify: `app/src/modules/browser-utils.js`
- Test: `tests/unit/js/browser-utils.test.js` (new)

- [ ] **Step 1: Write the failing test**

Create `tests/unit/js/browser-utils.test.js`:

```js
/**
 * Unit tests for renderTitleTemplate() in browser-utils.js
 *
 * @testCovers app/src/modules/browser-utils.js
 */

import { describe, it } from 'node:test'
import assert from 'node:assert'
import { renderTitleTemplate } from '../../../app/src/modules/browser-utils.js'

describe('renderTitleTemplate', () => {
  it('substitutes all present slots', () => {
    const result = renderTitleTemplate('{status}{appTitle} ({username})', {
      status: '',
      appTitle: 'PDF-TEI Editor',
      username: 'cboulanger'
    })
    assert.strictEqual(result, 'PDF-TEI Editor (cboulanger)')
  })

  it('applies a non-empty status prefix', () => {
    const result = renderTitleTemplate('{status}{appTitle} ({username})', {
      status: '● ',
      appTitle: 'PDF-TEI Editor',
      username: 'cboulanger'
    })
    assert.strictEqual(result, '● PDF-TEI Editor (cboulanger)')
  })

  it('collapses an empty ()  pair left by a missing slot', () => {
    const result = renderTitleTemplate('{status}{appTitle} ({username})', {
      status: '',
      appTitle: 'PDF-TEI Editor',
      username: ''
    })
    assert.strictEqual(result, 'PDF-TEI Editor')
  })

  it('treats a slot absent from the values object as empty', () => {
    const result = renderTitleTemplate('{status}{appTitle} ({username})', {
      appTitle: 'PDF-TEI Editor'
    })
    assert.strictEqual(result, 'PDF-TEI Editor')
  })

  it('ignores placeholders not present in the template', () => {
    const result = renderTitleTemplate('{appTitle}', {
      appTitle: 'PDF-TEI Editor',
      username: 'cboulanger'
    })
    assert.strictEqual(result, 'PDF-TEI Editor')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/unit-test-runner.js tests/unit/js/browser-utils.test.js`
Expected: FAIL — `renderTitleTemplate is not a function` (or import error), since it doesn't exist yet.

- [ ] **Step 3: Write minimal implementation**

In `app/src/modules/browser-utils.js`, add (near the other small string/DOM helpers, e.g. after `escapeHtml`):

```js
/**
 * Renders a title template by substituting `{slotName}` placeholders with values
 * from `slots`. A placeholder with no matching key (or an empty/falsy value) in
 * `slots` is substituted with an empty string; any `()` or `[]` pair left empty by
 * that substitution is then stripped, and whitespace is normalized. Placeholders
 * not present in `slots` are simply ignored (substituted as empty), and extra
 * `slots` entries not referenced by `template` have no effect.
 * @param {string} template
 * @param {Record<string, string>} slots
 * @returns {string}
 */
export function renderTitleTemplate(template, slots) {
  let result = template.replace(/\{(\w+)\}/g, (_, name) => slots[name] || '')
  result = result.replace(/[[(]\s*[)\]]/g, '').replace(/\s{2,}/g, ' ').trim()
  return result
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node tests/unit-test-runner.js tests/unit/js/browser-utils.test.js`
Expected: PASS (5/5 tests)

- [ ] **Step 5: Commit**

```bash
git add app/src/modules/browser-utils.js tests/unit/js/browser-utils.test.js
git commit -m "$(cat <<'EOF'
feat: add renderTitleTemplate() slot-based title renderer

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Add `titleTemplate` state field and `title.updateSlots` extension point

**Files:**
- Modify: `app/src/state.js`
- Modify: `app/src/extension-points.js`

- [ ] **Step 1: Add the state field**

In `app/src/state.js`, add to the `ApplicationState` typedef (after the `previousState` line, i.e. new last `@property`):

```js
 * @property {ApplicationState|null} previousState - Links to the previous state object
 * @property {string} titleTemplate - Template for the browser tab title, with `{slot}`
 * placeholders. Unresolved/empty slots become empty strings; a resulting empty `()`/`[]`
 * pair is stripped. See `ep.title.updateSlots` and `StartPlugin`.
 */
```

And add to `initialState` (after `ext: {},`):

```js
  ext: {},
  titleTemplate: '{status}{appTitle} ({username})',
  previousState: null
```

- [ ] **Step 2: Add the extension point**

In `app/src/extension-points.js`, add a new top-level entry after `xmlEditor: { ... }` (before the closing `}` of `extensionPoints`):

```js
  xmlEditor: {
    /**
     * Contribute items to the XML editor right-click context menu.
     * Called by XmlEditorPlugin.start() on all plugins that declare this extension point.
     * Function signature: () => Array<{element: HTMLElement, group?: string}>
     */
    contextMenuItems: "xmlEditor.contextMenuItems",
  },
  title: {
    /**
     * Merges the given slot values into the browser tab title (see `state.titleTemplate`)
     * and re-renders `document.title`. Slot names not present in the current template are
     * ignored. Handled by StartPlugin.
     * Function signature: (slots: Record<string, string>) => void
     */
    updateSlots: "title.updateSlots"
  }
```

- [ ] **Step 3: Verify no syntax errors**

Run: `node -e "import('./app/src/extension-points.js').then(m => console.log(m.default.title.updateSlots))"`
Expected: prints `title.updateSlots`

Run: `node -e "import('./app/src/state.js').then(m => console.log(m.default.titleTemplate))"`
Expected: prints `{status}{appTitle} ({username})`

- [ ] **Step 4: Commit**

```bash
git add app/src/state.js app/src/extension-points.js
git commit -m "$(cat <<'EOF'
feat: add titleTemplate state field and title.updateSlots extension point

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: `StartPlugin` owns the title slots and the DOM write

**Files:**
- Modify: `app/src/plugins/start.js`

- [ ] **Step 1: Import the new pieces**

In `app/src/plugins/start.js`, update the imports:

```js
import { UrlHash, renderTitleTemplate } from '../modules/browser-utils.js'
```

(`UrlHash` is already imported from there; add `renderTitleTemplate` to the same import.)

- [ ] **Step 2: Declare the extension point and add the private slot-state field**

`[ep.title.updateSlots]` is a custom (non-auto-discovered) extension point, so it must be declared via `static extensionPoints` (per `docs/code-assistant/plugin-communication.md`: "All other extension points require `static extensionPoints` with a corresponding computed handler method"). Add right after the `class StartPlugin extends Plugin {` line:

```js
class StartPlugin extends Plugin {
  static extensionPoints = [ep.title.updateSlots];

  /** @type {import('./logger.js').default} */
  #logger
```

Then add the slot-state field alongside the other private fields (after `#authentication`):

```js
  /** @type {import('./authentication.js').default} */
  #authentication
  /** @type {{appTitle: string, status: string, username: string}} */
  #titleSlots = { appTitle: document.title, status: '', username: '' }
```

- [ ] **Step 3: Seed the username slot and render on install**

In `install(state)`, after `this.#authentication = this.getDependency('authentication')`, add:

```js
    this.#authentication = this.getDependency('authentication')

    this.#updateTitleSlots({ username: state.user?.username ?? '' })
```

- [ ] **Step 4: Add the slot-merge/render helper and the extension point handler**

Add these two methods to the class (e.g. after `start()`, before `#configureFindNodeInPdf`):

```js
  /**
   * Extension point handler for `ep.title.updateSlots`.
   * Merges the given slot values into the browser tab title and re-renders it. Called by
   * any plugin that needs to contribute part of the title (e.g. XmlEditorPlugin for the
   * unsaved/blocked status marker).
   * Delegates to {@link StartPlugin#updateTitleSlots}.
   * @param {Record<string, string>} slots
   * @returns {void}
   */
  [ep.title.updateSlots](slots) {
    this.#updateTitleSlots(slots)
  }

  /**
   * @param {Record<string, string>} slots
   */
  #updateTitleSlots(slots) {
    Object.assign(this.#titleSlots, slots)
    const title = renderTitleTemplate(this.state.titleTemplate, this.#titleSlots)
    if (document.title !== title) document.title = title
  }
```

- [ ] **Step 5: React to login/logout**

Add an `onUserChange` handler to the class (e.g. right after `start()`):

```js
  /**
   * @param {ApplicationState['user']} user
   */
  onUserChange(user) {
    this.#updateTitleSlots({ username: user?.username ?? '' })
  }
```

- [ ] **Step 6: Check `ep` is imported**

`app/src/plugins/start.js` already has `import ep from '../extension-points.js'` (line 14) — no change needed there.

- [ ] **Step 7: Sanity-check for syntax errors**

Run: `node --check app/src/plugins/start.js`
Expected: no output (exit code 0)

- [ ] **Step 8: Commit**

```bash
git add app/src/plugins/start.js
git commit -m "$(cat <<'EOF'
feat: StartPlugin owns browser tab title rendering

Handles ep.title.updateSlots and reacts to login/logout, replacing the
static base title previously captured by XMLEditorPlugin.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: `XMLEditorPlugin` reports status via the extension point instead of writing `document.title`

**Files:**
- Modify: `app/src/plugins/xmleditor.js`

- [ ] **Step 1: Remove the field that captured the static title**

Delete this line (around line 237):

```js
  /** @type {string} */
  #originalDocumentTitle = document.title;
```

- [ ] **Step 2: Rewrite `#updateBrowserTitle()`**

Replace the method (around lines 1365-1379):

```js
  /**
   * Updates the browser tab title to reflect unsaved/error state. Reports "● " when there
   * is unsaved work, or "⚠ " when auto-save is actively blocked, so users can notice from
   * other tabs.
   */
  #updateBrowserTitle() {
    const dirty = this.#xmlEditor.isDirty();
    const blocked = this.#saveStatusWidget?.isConnected;
    let status = '';
    if (blocked) status = '⚠ ';
    else if (dirty) status = '● ';
    this.context.invokePluginEndpoint(ep.title.updateSlots, { status });
  }
```

- [ ] **Step 3: Sanity-check for syntax errors**

Run: `node --check app/src/plugins/xmleditor.js`
Expected: no output (exit code 0)

- [ ] **Step 4: Commit**

```bash
git add app/src/plugins/xmleditor.js
git commit -m "$(cat <<'EOF'
refactor: XMLEditorPlugin reports title status via ep.title.updateSlots

Removes the plugin's direct document.title writes and its captured
static base title, now owned centrally by StartPlugin.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: End-to-end verification

**Files:**
- Modify: `tests/e2e/tests/auth-workflow.spec.js`

- [ ] **Step 1: Add title assertions to the login/logout cycle test**

In the `'should complete full login and logout cycle'` test, after the block that verifies `toolbarMenuButtonEnabled` (around line 98) and before `// Clear console logs for logout test`, add:

```js
    // Verify the browser tab title now includes the username
    const titleAfterLogin = await page.title();
    expect(titleAfterLogin).toContain('testuser');
```

After the block that verifies `loginDialogVisibleAgain` (around line 130) and before `// Verify successful logout message in console logs`, add:

```js
    // Verify the browser tab title no longer includes the username after logout
    const titleAfterLogout = await page.title();
    expect(titleAfterLogout).not.toContain('testuser');
```

- [ ] **Step 2: Run the e2e test**

Run: `node tests/e2e-runner.js tests/e2e/tests/auth-workflow.spec.js`
Expected: PASS (all 4 tests in the file, including the modified one)

- [ ] **Step 3: Run the full unit test suite to check for regressions**

Run: `npm run test:unit:js`
Expected: PASS (no failures)

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/tests/auth-workflow.spec.js
git commit -m "$(cat <<'EOF'
test: verify browser tab title includes username on login

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Manual sanity check (optional, no dev-server restart needed)

If a dev server is already running, log in and log out in a browser tab and confirm the tab title changes: `PDF-TEI Editor` → `PDF-TEI Editor (yourusername)` → back to `PDF-TEI Editor` on logout. Type in the editor to confirm `● PDF-TEI Editor (yourusername)` appears while dirty.
