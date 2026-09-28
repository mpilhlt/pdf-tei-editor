# Document Rules Registry — Editor Integration (Plan 6) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface the document rules registry's state directly inside the XML editor, per this explicit follow-up request from the user (given after Plans 1-5 shipped the full backend + Tools-menu UI):

> - show if one or more resources are being overridden in the xmleditor header statusbar on the right (where lock warnings etc. are displayed) - clicking on that label toggles the header visibility to "visible" and scrolls the `<editorialDecl>` element into view.
> - add a decorator for the resource URLs in that element which, when clicked, opens the override editor for this resource. If a resource is being overridden, the decoration is in a different colour to mark it differently from non-overridden ones.
> - if the document is readonly, the editor is, too.

**Architecture:** One small backend addition (a batch "which of these resources currently have a selection" endpoint — `/document-rules/list`/`/query` don't already provide this without an N+1 fetch-full-text-per-resource loop) plus four frontend additions to the existing `app/src/plugins/document-rules.js`, all following patterns already proven elsewhere in this codebase rather than inventing new ones:

- A clickable "Overrides active" headerbar widget, built with `app/src/modules/panels/index.js`'s `PanelUtils.createText()` and added/removed via `XmlEditorPlugin`'s own `addHeaderbarWidget`/`removeHeaderbarWidget` — the exact mechanism `app/src/plugins/xmleditor.js` already uses for its own "Read-only"/"Auto-save blocked" indicators.
- Clicking it calls the `xmleditor` plugin API's `unfoldByXpath('//tei:teiHeader')` + `selectByXpath('//tei:editorialDecl')` — the same two calls `app/src/plugins/tei-tools.js` already makes for its own "show header" toggle switch (that plugin's own toggle logic is private, so this duplicates the two calls rather than depending on it).
- A `Decoration.mark`-based CodeMirror extension (new module `app/src/modules/document-rules-decorations.js`) that colors each `<ref target="...">` inside `editorialDecl` differently when its target URL is currently overridden, and opens the resource editor dialog on click — built from the same syntax-tree-walk shape (`syntaxTree()`, `Element`/`OpenTag`/`TagName`/`Attribute`/`AttributeName`/`AttributeValue` node names) `app/src/modules/codemirror/xml-annotation-decorations.js` already uses, installed into the shared editor via the same `createExtensionSlot()` compartment mechanism `app/src/plugins/xml-annotation.js` already uses.
- An `onEditorReadOnlyChange` handler on `DocumentRulesPlugin`, following the `on<Key>Change` auto-discovery convention already used by `onXmlChange`/`onUserChange` in that same file, that disables the resource editor dialog's content-editing controls whenever the host document is read-only — independent of, and in addition to, the dialog's existing "read-only unless an override is selected" gating.

**Tech Stack:** FastAPI, Pydantic (backend); vanilla JS class-based plugin, CodeMirror 6 (`@codemirror/state`, `@codemirror/view`, `@codemirror/language`), Shoelace-adjacent custom elements (`status-text`) (frontend); Python `unittest`, Node's `node:test`, Playwright.

---

## Important context for every task below

- **This plan modifies `app/src/plugins/document-rules.js`, which already exists** (built across Plans 1-5). Read the CURRENT file in full before starting any task — do not assume line numbers from this plan's excerpts are exact; the plan gives you the code to add/change, but you must locate the correct insertion points in the real, current file yourself.
- **Field/method naming convention** (carried over from Plan 5, still binding): every field/method a later unit test needs to reach is public-underscore (`_name`), never true `#private`. Only the plugin's own dependency getters (`#client`, `#xmlEditor`, `#logger`) stay true-private.
- **The `_resources` cache and its staleness**: `_resources` (populated by `_refreshResources()`/`#doRefreshResources()`) is refreshed on `onXmlChange()` and on the Tools-submenu's `mouseenter`, not on every keystroke. The new decoration-click and headerbar-widget-click handlers in this plan both look resources up in `_resources` rather than re-fetching, which means a `<ref target="...">` added to the document *since* the last refresh won't yet have a matching entry. This is an accepted, documented tradeoff (matching the existing submenu's own staleness window) — not a bug to fix in this plan.
- **`getDependency('xmleditor')` exposes a merged API**: `app/src/plugins/xmleditor.js`'s `getApi()` (lines ~246-258) returns a `Proxy` over the underlying `NavXmlEditor` instance that special-cases a fixed set of plugin-level method names (`addHeaderbarWidget`, `removeHeaderbarWidget`, `addStatusbarWidget`, `removeStatusbarWidget`, etc.) to route to the *plugin* instance, and everything else (`unfoldByXpath`, `selectByXpath`, `createExtensionSlot`, `getView`, `isReadOnly`, ...) to the underlying `NavXmlEditor`/`XMLEditor` module instance. From `document-rules.js`'s point of view this is all just `this.#xmlEditor.<methodName>(...)` — one flat API surface, no need to know which side of the proxy a given method lives on.
- **Backend endpoint naming**: the new endpoint is `POST /document-rules/selections` (plural — distinct from the existing `PUT /document-rules/selection`, singular, which sets one resource's selection). After adding it, regenerate the API client (`npm run generate-client`) — the generated method name will be `documentRulesSelections` (confirmed by the existing generated-method-naming pattern: `documentRulesSelection` for `PUT .../selection`, `documentRulesSelectionReset` for `POST .../selection/reset`).
- **Precondition check for every task that adds JS**: run `node --check <file>` after editing, and `npm run test:unit` before committing.

---

### Task 1: Backend — batch "is this resource overridden" endpoint

**Files:**
- Modify: `fastapi_app/lib/models/models_document_rules.py`
- Modify: `fastapi_app/routers/document_rules.py`
- Modify: `tests/unit/fastapi/test_document_rules_router.py`
- Regenerate: `app/src/modules/api-client-v1.js` (via `npm run generate-client`)

Neither `POST /document-rules/list` (no selection info at all) nor `POST /document-rules/query` (per-resource, and always fetches the resource's full original text even when the caller only wants a boolean) can answer "which of this document's resources currently have an override selected" without an N+1, full-text-discarding loop. Add a small batch endpoint that only touches the selection table, reusing the existing `ResourceRef {kind, url}` model already defined for `/selection/reset`.

- [ ] **Step 1: Add the request/response models**

In `fastapi_app/lib/models/models_document_rules.py`, add these two classes right after `ResetSelectionRequest` (which already defines `ResourceRef`, reused here unchanged):

```python
class SelectionInfo(BaseModel):
    """Whether the caller currently has an override selected for one resource."""
    kind: str
    url: str
    selected: bool


class SelectionsRequest(BaseModel):
    """Request the caller's selection status for each listed resource."""
    resources: list[ResourceRef]


class SelectionsResponse(BaseModel):
    selections: list[SelectionInfo]
```

- [ ] **Step 2: Add the router handler**

In `fastapi_app/routers/document_rules.py`, add `SelectionInfo`, `SelectionsRequest`, `SelectionsResponse` to the existing `from ..lib.models.models_document_rules import (...)` block (alphabetically), then add this handler right after `reset_selection`:

```python
@router.post("/selections", response_model=SelectionsResponse)
async def get_selections(
    request: SelectionsRequest,
    user: dict = Depends(require_authenticated_user),
    store: DocumentRulesStore = Depends(get_document_rules_store),
) -> SelectionsResponse:
    """
    Whether the caller currently has a selection (an override in use) for
    each listed resource - used to show an "overrides active" indicator
    without fetching every resource's full original/override text via
    repeated /query calls.
    """
    owner = user["username"]
    selections = [
        SelectionInfo(
            kind=r.kind,
            url=r.url,
            selected=store.get_selection(r.kind, normalize_resource_key(r.url), owner) is not None,
        )
        for r in request.resources
    ]
    return SelectionsResponse(selections=selections)
```

- [ ] **Step 3: Write the test**

Add this test class to `tests/unit/fastapi/test_document_rules_router.py`, after `TestQueryAndOverrideLifecycle`:

```python
class TestSelectionsEndpoint(DocumentRulesRouterTestCase):
    def setUp(self):
        super().setUp()
        self.resolve_patcher = patch(
            "fastapi_app.lib.doc_rules.interpretation_ref_kind.InterpretationRefKind.resolve_original",
            return_value="original text",
        )
        self.resolve_patcher.start()
        self.addCleanup(self.resolve_patcher.stop)
        self.url = "https://github.com/mpilhlt/pdf-tei-editor/blob/main/rules.md"

    def test_reports_false_for_a_resource_with_no_selection(self):
        response = self.client.post(
            "/document-rules/selections",
            json={"resources": [{"kind": "interpretation-ref", "url": self.url}]},
        )
        self.assertEqual(response.status_code, 200)
        selections = response.json()["selections"]
        self.assertEqual(selections, [{"kind": "interpretation-ref", "url": self.url, "selected": False}])

    def test_reports_true_once_an_override_is_selected(self):
        create_response = self.client.post(
            "/document-rules/overrides",
            json={"kind": "interpretation-ref", "fragment_url": self.url, "note": ""},
        )
        override_id = create_response.json()["id"]
        self.client.put(
            "/document-rules/selection",
            json={"kind": "interpretation-ref", "fragment_url": self.url, "override_id": override_id},
        )

        response = self.client.post(
            "/document-rules/selections",
            json={"resources": [{"kind": "interpretation-ref", "url": self.url}]},
        )
        selections = response.json()["selections"]
        self.assertEqual(selections, [{"kind": "interpretation-ref", "url": self.url, "selected": True}])

    def test_reports_false_again_after_reset(self):
        create_response = self.client.post(
            "/document-rules/overrides",
            json={"kind": "interpretation-ref", "fragment_url": self.url, "note": ""},
        )
        override_id = create_response.json()["id"]
        self.client.put(
            "/document-rules/selection",
            json={"kind": "interpretation-ref", "fragment_url": self.url, "override_id": override_id},
        )
        self.client.post(
            "/document-rules/selection/reset",
            json={"resources": [{"kind": "interpretation-ref", "url": self.url}]},
        )

        response = self.client.post(
            "/document-rules/selections",
            json={"resources": [{"kind": "interpretation-ref", "url": self.url}]},
        )
        selections = response.json()["selections"]
        self.assertEqual(selections, [{"kind": "interpretation-ref", "url": self.url, "selected": False}])

    def test_handles_multiple_resources_and_an_empty_list(self):
        other_url = "https://github.com/mpilhlt/pdf-tei-editor/blob/main/schema/rng/tei-bib.rng"
        response = self.client.post(
            "/document-rules/selections",
            json={"resources": [
                {"kind": "interpretation-ref", "url": self.url},
                {"kind": "schema", "url": other_url},
            ]},
        )
        selections = response.json()["selections"]
        self.assertEqual(len(selections), 2)
        self.assertTrue(all(s["selected"] is False for s in selections))

        empty_response = self.client.post("/document-rules/selections", json={"resources": []})
        self.assertEqual(empty_response.json()["selections"], [])

    def test_requires_authentication(self):
        self.app.dependency_overrides.pop(require_authenticated_user, None)
        response = self.client.post(
            "/document-rules/selections",
            json={"resources": [{"kind": "interpretation-ref", "url": self.url}]},
        )
        self.assertEqual(response.status_code, 401)
```

- [ ] **Step 4: Run the new tests**

```bash
uv run python -m unittest tests.unit.fastapi.test_document_rules_router.TestSelectionsEndpoint -v
```

Expected: 5/5 pass.

- [ ] **Step 5: Regenerate the API client and verify the new method**

```bash
npm run generate-client
grep -n "documentRulesSelections" app/src/modules/api-client-v1.js
```

Expected: a new `async documentRulesSelections(requestBody)` method calling `POST /document-rules/selections`, alongside the existing `documentRulesSelection`/`documentRulesSelectionReset` methods.

- [ ] **Step 6: Run the full Python unit suite for this router to check no regressions**

```bash
uv run python -m unittest tests.unit.fastapi.test_document_rules_router -v
```

Expected: all tests pass (previous count + 5 new).

- [ ] **Step 7: Commit**

```bash
git add fastapi_app/lib/models/models_document_rules.py fastapi_app/routers/document_rules.py \
        tests/unit/fastapi/test_document_rules_router.py app/src/modules/api-client-v1.js
git commit -m "feat(doc-rules): add POST /document-rules/selections batch endpoint"
```

---

### Task 2: Frontend — "Overrides active" headerbar widget

**Files:**
- Modify: `app/src/plugins/document-rules.js`

- [ ] **Step 1: Add the import**

```js
import { PanelUtils } from '../modules/panels/index.js'
```

- [ ] **Step 2: Add the state fields**

Add these fields alongside the existing `_resources`/`_refreshPromise` fields:

```js
  /** @type {HTMLElement} */
  _overridesWidget = null

  /**
   * Last successful POST /document-rules/selections result for `_resources`.
   * @type {Array<{kind: string, url: string, selected: boolean}>}
   */
  _selections = []
```

- [ ] **Step 3: Create the widget in `install()`**

Add this to `install()`, after the existing `this._md = createMarkdownRenderer()` line (or wherever the equivalent line currently is - read the file first):

```js
    this._overridesWidget = PanelUtils.createText({
      text: 'Overrides active',
      icon: 'pencil-fill',
      variant: 'primary',
      clickable: true,
      name: 'documentRulesOverridesStatus'
    })
    this._overridesWidget.addEventListener('widget-click', () => this._onOverridesWidgetClick())
```

- [ ] **Step 4: Add the click handler**

```js
  /**
   * Reveal the document's editorialDecl: unfold the TEI header (it may be
   * folded) and scroll editorialDecl into view - same two calls
   * app/src/plugins/tei-tools.js's own "show header" toggle makes (that
   * plugin's toggle logic is private, so this duplicates the calls rather
   * than depending on it).
   */
  _onOverridesWidgetClick() {
    try {
      this.#xmlEditor.unfoldByXpath('//tei:teiHeader')
      this.#xmlEditor.selectByXpath('//tei:editorialDecl')
    } catch (error) {
      this.#logger.warn('document-rules: could not reveal editorialDecl: ' + String(error))
    }
  }
```

- [ ] **Step 5: Fetch selection status and show/hide the widget**

Add this method:

```js
  /**
   * Fetch selection status for every currently-known resource and show/hide
   * the "Overrides active" headerbar widget accordingly. Called whenever
   * `_resources` changes (after a list refresh) and whenever a selection
   * changes (override CRUD/selection actions), so the indicator - and the
   * ref decorations built from the same `_selections` data - stay current.
   * @returns {Promise<void>}
   */
  async _refreshOverrideIndicators() {
    if (this._resources.length === 0) {
      this._selections = []
      if (this._overridesWidget.isConnected) this.#xmlEditor.removeHeaderbarWidget(this._overridesWidget.id)
      this._refreshRefDecorations()
      return
    }
    try {
      const response = await this.#client.apiClient.documentRulesSelections({
        resources: this._resources.map(r => ({ kind: r.kind, url: r.url }))
      })
      this._selections = response.selections
    } catch (error) {
      this.#logger.warn('document-rules: could not fetch selection status: ' + String(error))
      return
    }
    const hasOverrides = this._selections.some(s => s.selected)
    if (hasOverrides) {
      if (!this._overridesWidget.isConnected) this.#xmlEditor.addHeaderbarWidget(this._overridesWidget, 'right', 3)
    } else if (this._overridesWidget.isConnected) {
      this.#xmlEditor.removeHeaderbarWidget(this._overridesWidget.id)
    }
    this._refreshRefDecorations()
  }
```

`_refreshRefDecorations()` is added in Task 4 - add a temporary no-op stub for now so this task's own code runs standalone:

```js
  /** @returns {void} */
  _refreshRefDecorations() { /* replaced in Task 4 */ }
```

- [ ] **Step 6: Call `_refreshOverrideIndicators()` wherever `_resources`/selection state changes**

In `#doRefreshResources()`, add a call at the very end (after `this._populateSubmenu()`):

```js
    this._populateSubmenu()
    await this._refreshOverrideIndicators()
```

In `_selectOverride()`, `_onNewOverride()`, `_onDelete()`, and `_onReset()` - each of which already ends by mutating `_currentSelectedId` and re-rendering - add `await this._refreshOverrideIndicators()` right after each method's existing `this._renderEditorDialog()` call (or wherever each method currently ends after a successful mutation - read the file to find each exact spot; `_onNewOverride()` ends by calling `_selectOverride()`, which already re-renders, so `_onNewOverride()` needs no separate call since it delegates).

- [ ] **Step 7: Manual smoke check**

Open a document with an overridden resource, confirm the "Overrides active" indicator appears in the headerbar's right side; click it, confirm the TEI header unfolds and `editorialDecl` scrolls into view. Reset the override, confirm the indicator disappears.

- [ ] **Step 8: Commit**

```bash
git add app/src/plugins/document-rules.js
git commit -m "feat(doc-rules): add the 'Overrides active' headerbar indicator"
```

---

### Task 3: Frontend — read-only linkage for the resource editor dialog

**Files:**
- Modify: `app/src/plugins/document-rules.js`

- [ ] **Step 1: Add the state field**

```js
  /** @type {boolean} */
  _documentReadOnly = false
```

- [ ] **Step 2: Initialize it from the initial state in `install()`**

```js
    this._documentReadOnly = !!state.editorReadOnly
```

(Add this near the top of `install(state)`, after `await super.install(state)`.)

- [ ] **Step 3: Add the auto-discovered state handler**

```js
  /**
   * Keep the resource editor dialog's content-editing controls in sync with
   * the host document's read-only state - independent of, and in addition
   * to, the dialog's existing "read-only unless an override is selected"
   * gating in _renderEditorDialog().
   * @param {boolean} newValue
   */
  onEditorReadOnlyChange(newValue) {
    this._documentReadOnly = !!newValue
    if (this._currentResource) this._renderEditorDialog()
  }
```

- [ ] **Step 4: Fold the flag into `_renderEditorDialog()`'s read-only computation**

Find the existing line:

```js
    const readOnly = selected === null
```

Replace it with:

```js
    const readOnly = selected === null || this._documentReadOnly
```

Find the existing footer-button visibility lines (`saveBtn`/`deleteBtn`/`resetBtn` `style.display` assignments) and the `newOverrideBtn` — content-mutating actions (creating or saving an override) must also be disabled while the document is read-only, but switching between an already-existing override and the original, or clearing the selection, does not edit document content and can remain available:

```js
    dialogUi.newOverrideBtn.disabled = this._documentReadOnly
    dialogUi.saveBtn.style.display = selected && !this._documentReadOnly ? '' : 'none'
```

Leave `deleteBtn`/`resetBtn`'s existing `selected ? '' : 'none'` visibility unchanged.

- [ ] **Step 5: Manual smoke check**

Open a document that's locked/read-only (e.g. held by another session, or a gold file without reviewer role), open a resource's editor, confirm "New override" is disabled, "Save" is hidden even if an override happens to be selected, and the text body/CodeMirror body is read-only regardless of which override is selected.

- [ ] **Step 6: Commit**

```bash
git add app/src/plugins/document-rules.js
git commit -m "feat(doc-rules): make the resource editor dialog read-only when the document is"
```

---

### Task 4: Frontend — CodeMirror ref decoration (color + click-to-open)

**Files:**
- Create: `app/src/modules/document-rules-decorations.js`
- Modify: `app/src/plugins/document-rules.js`

- [ ] **Step 1: Create the decorations module**

```js
/**
 * CodeMirror decorations for <ref target="..."> URLs inside a TEI
 * document's editorialDecl/interpretation entries: colors a ref's target
 * differently when the current user has an override selected for that
 * resource, and reports clicks on a decorated ref so the caller can open
 * the document-rules resource editor for it.
 *
 * Mirrors app/src/modules/codemirror/xml-annotation-decorations.js's
 * syntax-tree-walk shape (Element/OpenTag/TagName/Attribute/AttributeName/
 * AttributeValue node names, and the firstChild.firstChild?.nextSibling
 * TagName lookup), narrowed to <ref>'s target attribute specifically rather
 * than a whole-element badge/mark.
 */

/**
 * @import {EditorState} from '@codemirror/state'
 * @import {DecorationSet} from '@codemirror/view'
 */

import { StateField, RangeSetBuilder } from '@codemirror/state'
import { Decoration, EditorView } from '@codemirror/view'
import { syntaxTree } from '@codemirror/language'

/**
 * Read one element's attributes as {name, value, valueFrom, valueTo} spans,
 * with valueFrom/valueTo excluding the surrounding quote characters.
 * @param {import('@lezer/common').SyntaxNode} openTagNode
 * @param {EditorState} state
 * @returns {Array<{name: string, value: string, valueFrom: number, valueTo: number}>}
 */
function readAttributeSpans(openTagNode, state) {
  /** @type {Array<{name: string, value: string, valueFrom: number, valueTo: number}>} */
  const attrs = []
  let child = openTagNode.firstChild
  while (child) {
    if (child.name === 'Attribute') {
      const nameNode = child.firstChild
      const valueNode = child.lastChild
      if (nameNode && valueNode && nameNode !== valueNode && nameNode.name === 'AttributeName') {
        const name = state.doc.sliceString(nameNode.from, nameNode.to)
        const raw = state.doc.sliceString(valueNode.from, valueNode.to)
        const value = raw.length >= 2 ? raw.slice(1, -1) : raw
        attrs.push({ name, value, valueFrom: valueNode.from + 1, valueTo: valueNode.to - 1 })
      }
    }
    child = child.nextSibling
  }
  return attrs
}

/**
 * Walk the whole syntax tree once, building one mark decoration per
 * <ref target="..."> found anywhere in the document, colored by whether its
 * target URL is in `overriddenUrls`.
 * @param {EditorState} state
 * @param {Set<string>} overriddenUrls
 * @returns {DecorationSet}
 */
export function buildRefDecorations(state, overriddenUrls) {
  const builder = new RangeSetBuilder()
  const tree = syntaxTree(state)
  /** @type {Array<{from: number, to: number, url: string, overridden: boolean}>} */
  const found = []

  tree.iterate({
    enter(node) {
      if (node.name !== 'Element') return
      const openTag = node.node.firstChild
      if (!openTag || openTag.name !== 'OpenTag') return
      const tagNameNode = openTag.firstChild?.nextSibling
      if (!tagNameNode || tagNameNode.name !== 'TagName') return
      const tagName = state.doc.sliceString(tagNameNode.from, tagNameNode.to)
      if (tagName !== 'ref') return
      for (const attr of readAttributeSpans(openTag, state)) {
        if (attr.name === 'target' && attr.valueFrom < attr.valueTo) {
          found.push({
            from: attr.valueFrom,
            to: attr.valueTo,
            url: attr.value,
            overridden: overriddenUrls.has(attr.value)
          })
        }
      }
    }
  })

  found.sort((a, b) => a.from - b.from)
  for (const { from, to, overridden } of found) {
    builder.add(from, to, Decoration.mark({
      class: overridden ? 'doc-rules-ref doc-rules-ref-overridden' : 'doc-rules-ref',
      attributes: { 'data-doc-rules-url': found.find(f => f.from === from)?.url ?? '' }
    }))
  }
  return builder.finish()
}

/** Visual styling for the two decoration classes. */
export const refDecorationTheme = EditorView.baseTheme({
  '.doc-rules-ref': {
    textDecoration: 'underline dotted',
    cursor: 'pointer'
  },
  '.doc-rules-ref-overridden': {
    textDecoration: 'underline solid',
    color: 'var(--sl-color-primary-600)',
    fontWeight: 'bold'
  }
})

/**
 * A StateField holding the current ref-decoration set for a fixed
 * `overriddenUrls` snapshot - rebuilt on every document change (matching
 * xml-annotation-decorations.js's own buildAll()'s whole-tree-walk-per-
 * change approach; acceptable at this feature's document sizes) and
 * whenever `overriddenUrls` itself changes, the caller reconfigures the
 * whole extension via a fresh createOverrideRefField() call rather than
 * pushing an effect into a long-lived field.
 * @param {Set<string>} overriddenUrls
 */
export function createOverrideRefField(overriddenUrls) {
  return StateField.define({
    create(state) {
      return buildRefDecorations(state, overriddenUrls)
    },
    update(decorations, tr) {
      return tr.docChanged ? buildRefDecorations(tr.state, overriddenUrls) : decorations.map(tr.changes)
    },
    provide: (field) => EditorView.decorations.from(field)
  })
}

/**
 * Build a click-handling extension: clicking a decorated <ref target="...">
 * span calls `onRefClick(url)`.
 * @param {(url: string) => void} onRefClick
 * @returns {import('@codemirror/state').Extension}
 */
export function createOverrideRefClickHandler(onRefClick) {
  return EditorView.domEventHandlers({
    click(event) {
      const target = /** @type {HTMLElement} */ (event.target)
      const marker = target.closest?.('.doc-rules-ref')
      if (!marker) return false
      const url = marker.getAttribute('data-doc-rules-url')
      if (url) onRefClick(url)
      return true
    }
  })
}
```

- [ ] **Step 2: Wire it into `document-rules.js`**

Add the import:

```js
import { createOverrideRefField, createOverrideRefClickHandler, refDecorationTheme } from '../modules/document-rules-decorations.js'
```

Add a field:

```js
  /** @type {{reconfigure: (ext: any) => void}} */
  _refDecorationSlot = null
```

In `install()`, after the CodeMirror `_cmView` construction (Task 6 of Plan 5), add:

```js
    this._refDecorationSlot = this.#xmlEditor.createExtensionSlot([])
```

- [ ] **Step 3: Replace the Task 2 stub**

```js
  /**
   * Rebuild the ref-decoration extension from the current `_selections`,
   * restricted to interpretation-ref resources (the schema PI isn't a <ref>
   * element, so it's never decorated this way).
   */
  _refreshRefDecorations() {
    const overriddenUrls = new Set(
      this._selections.filter(s => s.selected && s.kind === 'interpretation-ref').map(s => s.url)
    )
    this._refDecorationSlot.reconfigure([
      createOverrideRefField(overriddenUrls),
      refDecorationTheme,
      createOverrideRefClickHandler((url) => this._onRefDecorationClick(url))
    ])
  }

  /**
   * Open the resource editor for the interpretation-ref resource matching
   * the clicked <ref target="..."> URL, looked up in the existing
   * `_resources` cache (see this plan's "Important context" on staleness).
   * @param {string} url
   */
  _onRefDecorationClick(url) {
    const resource = this._resources.find(r => r.kind === 'interpretation-ref' && r.url === url)
    if (!resource) {
      this.#logger.warn(`document-rules: no resource found for clicked ref url: ${url}`)
      return
    }
    this._openResourceEditor(resource)
  }
```

- [ ] **Step 4: Manual smoke check**

Open a document with two or more `<ref target="...">` entries in `editorialDecl`, one with an override selected and one without. Confirm the overridden one renders visually distinct (bold, solid underline, primary color) from the other (dotted underline only). Click each; confirm both open the resource editor for the correct resource.

- [ ] **Step 5: Commit**

```bash
git add app/src/modules/document-rules-decorations.js app/src/plugins/document-rules.js
git commit -m "feat(doc-rules): add clickable, override-aware ref decorations in editorialDecl"
```

---

### Task 5: Frontend unit tests

**Files:**
- Modify: `tests/unit/js/document-rules.test.js`
- Create: `tests/unit/js/document-rules-decorations.test.js`

- [ ] **Step 1: Test the decorations module in isolation**

The decorations module has no DOM/plugin dependency - test it directly against a real (small) CodeMirror `EditorState`, without any of `document-rules.test.js`'s jsdom bootstrap:

```js
#!/usr/bin/env node

/**
 * Unit tests for the document-rules ref-decoration CodeMirror extension.
 * @testCovers app/src/modules/document-rules-decorations.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { EditorState } from '@codemirror/state';
import { xml } from '@codemirror/lang-xml';
import { buildRefDecorations, createOverrideRefField, createOverrideRefClickHandler } from '../../../app/src/modules/document-rules-decorations.js';

const DOC = `<TEI xmlns="http://www.tei-c.org/ns/1.0">
  <teiHeader><encodingDesc><editorialDecl>
    <interpretation type="a"><p><ref target="https://example.com/a.md"/></p></interpretation>
    <interpretation type="b"><p><ref target="https://example.com/b.md"/></p></interpretation>
  </editorialDecl></encodingDesc></teiHeader>
</TEI>`;

function makeState(doc = DOC) {
  return EditorState.create({ doc, extensions: [xml()] });
}

describe('buildRefDecorations', () => {
  it('finds one decoration per <ref target> element', () => {
    const state = makeState();
    const decos = buildRefDecorations(state, new Set());
    const ranges = [];
    decos.between(0, state.doc.length, (from, to) => ranges.push({ from, to }));
    assert.strictEqual(ranges.length, 2);
  });

  it('marks a URL in overriddenUrls with the overridden class', () => {
    const state = makeState();
    const decos = buildRefDecorations(state, new Set(['https://example.com/a.md']));
    const classes = [];
    decos.between(0, state.doc.length, (_f, _t, deco) => classes.push(deco.spec.class));
    assert.deepStrictEqual(classes.sort(), ['doc-rules-ref', 'doc-rules-ref doc-rules-ref-overridden']);
  });

  it('produces no decorations for a document with no <ref> elements', () => {
    const state = makeState('<TEI xmlns="http://www.tei-c.org/ns/1.0"/>');
    const decos = buildRefDecorations(state, new Set());
    let count = 0;
    decos.between(0, state.doc.length, () => { count++; });
    assert.strictEqual(count, 0);
  });

  it('excludes the surrounding quotes from the decorated span', () => {
    const state = makeState();
    const decos = buildRefDecorations(state, new Set());
    let firstFrom = null, firstTo = null;
    decos.between(0, state.doc.length, (from, to) => { if (firstFrom === null) { firstFrom = from; firstTo = to; } });
    const text = state.doc.sliceString(firstFrom, firstTo);
    assert.strictEqual(text, 'https://example.com/a.md');
  });
});

describe('createOverrideRefField', () => {
  it('rebuilds decorations after a document change', () => {
    const field = createOverrideRefField(new Set());
    let state = EditorState.create({ doc: DOC, extensions: [xml(), field] });
    assert.strictEqual([...state.field(field).between ? [] : []].length, 0); // sanity: field is queryable
    const tr = state.update({ changes: { from: state.doc.length, insert: '\n<!-- x -->' } });
    state = tr.state;
    const decos = state.field(field);
    let count = 0;
    decos.between(0, state.doc.length, () => { count++; });
    assert.strictEqual(count, 2, 'decorations must survive a document change unrelated to the refs');
  });
});

describe('createOverrideRefClickHandler', () => {
  it('calls onRefClick with the marker\'s data-doc-rules-url and returns true when a decorated element is clicked', () => {
    let clickedUrl = null;
    const handlers = createOverrideRefClickHandler((url) => { clickedUrl = url; });
    const marker = { getAttribute: (name) => (name === 'data-doc-rules-url' ? 'https://example.com/a.md' : null) };
    const target = { closest: (sel) => (sel === '.doc-rules-ref' ? marker : null) };
    const handled = handlers.click.call(null, /** @type {any} */ ({ target }), /** @type {any} */ ({}));
    assert.strictEqual(clickedUrl, 'https://example.com/a.md');
    assert.strictEqual(handled, true);
  });

  it('returns false (lets the event through) when the click is not on a decorated element', () => {
    let called = false;
    const handlers = createOverrideRefClickHandler(() => { called = true; });
    const target = { closest: () => null };
    const handled = handlers.click.call(null, /** @type {any} */ ({ target }), /** @type {any} */ ({}));
    assert.strictEqual(called, false);
    assert.strictEqual(handled, false);
  });
});
```

- [ ] **Step 2: Add tests to `document-rules.test.js` for the headerbar widget and read-only linkage**

Read the current `tests/unit/js/document-rules.test.js` in full first (it already has `makePlugin()`/`makeDialogUi()`/the jsdom bootstrap from Plan 5). Add these `describe` blocks:

```js
describe('DocumentRulesPlugin._refreshOverrideIndicators', () => {
  it('shows the headerbar widget when at least one resource is selected', async () => {
    const plugin = makePlugin();
    plugin._overridesWidget = Object.assign(document.createElement('span'), { isConnected: false, id: 'w1' });
    plugin._resources = [{ kind: 'interpretation-ref', url: 'u', key: 'u', label: 'A', format: 'markdown' }];
    let added;
    plugin.getDependency = (name) => {
      if (name === 'xmleditor') return { addHeaderbarWidget: (w) => { added = w; w.isConnected = true; }, removeHeaderbarWidget: () => {} };
      if (name === 'client') return { apiClient: { documentRulesSelections: async () => ({ selections: [{ kind: 'interpretation-ref', url: 'u', selected: true }] }) } };
      throw new Error(`unexpected dependency: ${name}`);
    };
    await plugin._refreshOverrideIndicators();
    assert.strictEqual(added, plugin._overridesWidget);
  });

  it('hides the headerbar widget when nothing is selected', async () => {
    const plugin = makePlugin();
    plugin._overridesWidget = Object.assign(document.createElement('span'), { isConnected: true, id: 'w1' });
    plugin._resources = [{ kind: 'interpretation-ref', url: 'u', key: 'u', label: 'A', format: 'markdown' }];
    let removedId;
    plugin.getDependency = (name) => {
      if (name === 'xmleditor') return { addHeaderbarWidget: () => {}, removeHeaderbarWidget: (id) => { removedId = id; } };
      if (name === 'client') return { apiClient: { documentRulesSelections: async () => ({ selections: [{ kind: 'interpretation-ref', url: 'u', selected: false }] }) } };
      throw new Error(`unexpected dependency: ${name}`);
    };
    await plugin._refreshOverrideIndicators();
    assert.strictEqual(removedId, 'w1');
  });

  it('hides the widget and skips the fetch when there are no resources', async () => {
    const plugin = makePlugin();
    plugin._overridesWidget = Object.assign(document.createElement('span'), { isConnected: true, id: 'w1' });
    plugin._resources = [];
    let removedId, fetchCalled = false;
    plugin.getDependency = (name) => {
      if (name === 'xmleditor') return { addHeaderbarWidget: () => {}, removeHeaderbarWidget: (id) => { removedId = id; } };
      if (name === 'client') return { apiClient: { documentRulesSelections: async () => { fetchCalled = true; return { selections: [] }; } } };
      throw new Error(`unexpected dependency: ${name}`);
    };
    await plugin._refreshOverrideIndicators();
    assert.strictEqual(removedId, 'w1');
    assert.strictEqual(fetchCalled, false);
  });
});

describe('DocumentRulesPlugin._onOverridesWidgetClick', () => {
  it('unfolds the TEI header and reveals editorialDecl', () => {
    const plugin = makePlugin();
    const calls = [];
    plugin.getDependency = (name) => {
      if (name === 'xmleditor') return {
        unfoldByXpath: (xp) => calls.push(['unfold', xp]),
        selectByXpath: (xp) => calls.push(['select', xp]),
      };
      throw new Error(`unexpected dependency: ${name}`);
    };
    plugin._onOverridesWidgetClick();
    assert.deepStrictEqual(calls, [['unfold', '//tei:teiHeader'], ['select', '//tei:editorialDecl']]);
  });
});

describe('DocumentRulesPlugin.onEditorReadOnlyChange', () => {
  it('makes the dialog read-only and hides content-editing controls even with an override selected', () => {
    const plugin = makePlugin();
    plugin._editorDialogUi = makeDialogUi();
    plugin._md = { render: (t) => t };
    plugin._currentResource = { kind: 'interpretation-ref', url: 'u', key: 'u', label: 'A', format: 'markdown' };
    plugin._currentOriginalText = 'original';
    plugin._currentOverrides = [{ id: 'ov1', note: '', text: 'override text', format: 'markdown', created_at: '', updated_at: '' }];
    plugin._currentSelectedId = 'ov1';

    plugin.onEditorReadOnlyChange(true);

    assert.strictEqual(plugin._documentReadOnly, true);
    assert.strictEqual(plugin._editorDialogUi.textBody.textTabs.editPanel.textArea.readonly, true);
    assert.strictEqual(plugin._editorDialogUi.newOverrideBtn.disabled, true);
    assert.strictEqual(plugin._editorDialogUi.saveBtn.style.display, 'none');
  });

  it('does nothing to the dialog when no resource is currently open', () => {
    const plugin = makePlugin();
    assert.doesNotThrow(() => plugin.onEditorReadOnlyChange(true));
    assert.strictEqual(plugin._documentReadOnly, true);
  });

  it('restores editability when the document becomes writable again, for a selected override', () => {
    const plugin = makePlugin();
    plugin._editorDialogUi = makeDialogUi();
    plugin._md = { render: (t) => t };
    plugin._currentResource = { kind: 'interpretation-ref', url: 'u', key: 'u', label: 'A', format: 'markdown' };
    plugin._currentOriginalText = 'original';
    plugin._currentOverrides = [{ id: 'ov1', note: '', text: 'override text', format: 'markdown', created_at: '', updated_at: '' }];
    plugin._currentSelectedId = 'ov1';
    plugin.onEditorReadOnlyChange(true);

    plugin.onEditorReadOnlyChange(false);

    assert.strictEqual(plugin._editorDialogUi.textBody.textTabs.editPanel.textArea.readonly, false);
    assert.strictEqual(plugin._editorDialogUi.newOverrideBtn.disabled, false);
    assert.strictEqual(plugin._editorDialogUi.saveBtn.style.display, '');
  });
});

describe('DocumentRulesPlugin._refreshRefDecorations', () => {
  it('reconfigures the decoration slot with the overridden interpretation-ref URLs only', () => {
    const plugin = makePlugin();
    let reconfigured;
    plugin._refDecorationSlot = { reconfigure: (ext) => { reconfigured = ext; } };
    plugin._selections = [
      { kind: 'interpretation-ref', url: 'https://example.com/a.md', selected: true },
      { kind: 'interpretation-ref', url: 'https://example.com/b.md', selected: false },
      { kind: 'schema', url: 'https://example.com/s.rng', selected: true },
    ];
    plugin._refreshRefDecorations();
    assert.ok(Array.isArray(reconfigured));
    assert.strictEqual(reconfigured.length, 3);
  });
});

describe('DocumentRulesPlugin._onRefDecorationClick', () => {
  it('opens the resource editor for the matching interpretation-ref resource', () => {
    const plugin = makePlugin();
    const resource = { kind: 'interpretation-ref', url: 'https://example.com/a.md', key: 'a', label: 'A', format: 'markdown' };
    plugin._resources = [resource];
    let opened;
    plugin._openResourceEditor = (r) => { opened = r; };
    plugin._onRefDecorationClick('https://example.com/a.md');
    assert.deepStrictEqual(opened, resource);
  });

  it('logs a warning and does nothing when no matching resource is cached', () => {
    const plugin = makePlugin();
    plugin._resources = [];
    let warned = false;
    plugin.getDependency = (name) => {
      if (name === 'logger') return { warn: () => { warned = true; }, debug: () => {} };
      throw new Error(`unexpected dependency: ${name}`);
    };
    let opened = false;
    plugin._openResourceEditor = () => { opened = true; };
    plugin._onRefDecorationClick('https://example.com/unknown.md');
    assert.strictEqual(opened, false);
    assert.strictEqual(warned, true);
  });
});
```

- [ ] **Step 3: Run both test files**

```bash
node --test --experimental-test-module-mocks --disable-warning=ExperimentalWarning tests/unit/js/document-rules-decorations.test.js
node --test --experimental-test-module-mocks --disable-warning=ExperimentalWarning tests/unit/js/document-rules.test.js
```

Expected: both files green, 0 failures.

- [ ] **Step 4: Run the full JS unit suite**

```bash
npm run test:unit -- --grep document-rules
```

Expected: all matching files pass with no regressions elsewhere.

- [ ] **Step 5: Commit**

```bash
git add tests/unit/js/document-rules-decorations.test.js tests/unit/js/document-rules.test.js
git commit -m "test(doc-rules): cover the headerbar indicator, read-only linkage, and ref decorations"
```

---

### Task 6: E2E test, fixture update, full suite, UI screenshot

**Files:**
- Modify: `tests/e2e/fixtures/standard/files/tei/document-rules/document-rules-fixture.tei.xml` (only if it needs a second `<ref target>` entry - check first)
- Modify: `tests/e2e/tests/document-rules.spec.js`

- [ ] **Step 1: Check the existing fixture**

Read `tests/e2e/fixtures/standard/files/tei/document-rules/document-rules-fixture.tei.xml` (created in Plan 5's Task 8). It has one `editorialDecl/interpretation/p/ref[@target]` entry. That's enough to test "the overridden one is colored differently from the un-overridden default state" is NOT directly testable with only one ref (there's nothing to contrast against) - decide whether to add a second `<interpretation>` entry with its own `<ref target="...">` to this fixture so the E2E test can assert one is decorated as overridden and the other isn't. If added, keep the new ref's URL resolvable the same way the existing plan's Task 8 already established for the first one (an existing GROBID annotation-rules file's own real URL, or reuse the exact same domain/pattern already verified working in that task - do NOT introduce a fresh live-network dependency; check what Plan 5's Task 8 actually settled on before adding a second entry, since it deliberately avoided opening/fetching the interpretation-ref resource's real content in E2E - the decoration test only needs the ref's syntax highlighting/color, not its resolved text, so this is a lower-risk addition than Plan 5's own override-CRUD test).

- [ ] **Step 2: Add E2E coverage**

Append to `tests/e2e/tests/document-rules.spec.js` (read the current file first for its existing `loadFixtureDocument`/`openToolsMenu` helpers and login/cleanup conventions - reuse them, don't duplicate):

```js
  test('shows the headerbar indicator and decorates an overridden ref differently once an override is selected', async ({ page }) => {
    const consoleLogs = setupTestConsoleCapture(page);
    const stopErrorMonitoring = setupErrorFailure(consoleLogs, ALLOWED_ERROR_PATTERNS);

    try {
      await navigateAndLogin(page, 'testreviewer', 'reviewerpass');
      await loadFixtureDocument(page, 'document-rules-fixture');

      // No overrides selected yet: no headerbar indicator, ref not decorated as overridden.
      await expect(page.locator('status-text[name="documentRulesOverridesStatus"]')).toHaveCount(0);
      const refSpan = page.locator('.cm-content .doc-rules-ref').first();
      await expect(refSpan).not.toHaveClass(/doc-rules-ref-overridden/);

      // Select an override for the schema resource via the existing submenu flow.
      await openToolsMenu(page);
      const editMenuItem = page.locator('sl-menu-item:has-text("Edit prompts/schemas")');
      await editMenuItem.waitFor({ state: 'visible', timeout: 15000 });
      await editMenuItem.hover();
      await page.waitForTimeout(500);
      const submenu = page.locator('sl-menu-item:has-text("Edit prompts/schemas") sl-menu[slot="submenu"]');
      await submenu.locator('sl-menu-item:has-text("Data correction")').click();
      const dialog = page.locator('sl-dialog[name="documentRulesEditorDialog"]');
      await expect(dialog).toHaveAttribute('open', '');
      await page.waitForTimeout(500);
      await dialog.locator('sl-button:has-text("New override")').click();
      await page.waitForTimeout(500);
      await dialog.locator('sl-button[name="closeBtn"]').click();
      await page.waitForTimeout(500);

      // Headerbar indicator now shows; clicking it reveals editorialDecl.
      const indicator = page.locator('status-text[name="documentRulesOverridesStatus"]');
      await expect(indicator).toBeVisible();
      await indicator.click();
      await page.waitForTimeout(500);
      await expect(page.locator('.cm-content')).toContainText('editorialDecl');

      // Clean up the override created above (same rationale as the earlier
      // test in this file: no TTL/cascade-delete on resource_overrides).
      await page.evaluate(async (url) => {
        const client = /** @type {any} */ (window).client;
        const query = await client.apiClient.documentRulesQuery({ kind: 'interpretation-ref', url });
        for (const override of query.overrides) {
          await client.apiClient.documentRulesDeleteOverrides(override.id);
        }
      }, INTERPRETATION_REF_URL);
    } finally {
      stopErrorMonitoring();
      await releaseAllLocks(page);
    }
  });
```

Add this constant near the top of the file, alongside the existing `SCHEMA_URL` constant (same established pattern - a value that must match the fixture exactly, kept as a named constant with a comment saying so):

```js
// Must match the <ref target="..."> in document-rules-fixture.tei.xml's
// "Data correction" interpretation entry exactly.
const INTERPRETATION_REF_URL = 'https://github.com/mpilhlt/fossil/blob/main/docs/guidelines.md#data-correction';
```

If Step 1 above added a NEW fixture ref entry rather than reusing this existing one, use that new entry's exact URL instead, verified by reading the fixture file directly - do not guess or reuse this value if it no longer matches what's actually in the fixture.

- [ ] **Step 3: Run the new test in isolation, iterate until green**

```bash
node tests/e2e-runner.js tests/e2e/tests/document-rules.spec.js
```

Run it a second time with `--keep-db` to confirm the cleanup step actually prevents cross-run state leakage (same check Plan 5's Task 8 established):

```bash
node tests/e2e-runner.js --keep-db tests/e2e/tests/document-rules.spec.js
```

Both runs must pass.

- [ ] **Step 4: Run the full suite**

```bash
npm run test:unit
npm run test:e2e
```

Expected: all green except the one pre-existing, unrelated Python failure already tracked from Plan 5 (`tests/unit/fastapi/test_plugin_tools_sandbox_client.py::test_uses_cached_script_when_source_missing`).

- [ ] **Step 5: UI screenshot check**

```bash
node scripts/dev/ui-screenshot.js --out <scratchpad>/document-rules-headerbar.png
```

View the PNG with the Read tool; if a document with an active override can be pre-loaded via `--mock`/an existing demo fixture, confirm the headerbar indicator renders sensibly (icon, text, position relative to other right-side widgets like "Read-only").

- [ ] **Step 6: Commit**

```bash
git add tests/e2e/tests/document-rules.spec.js
# plus the fixture file if Step 1 changed it
git commit -m "test(doc-rules): add E2E coverage for the headerbar indicator and ref decorations"
```

---

## Post-plan: request a final whole-plan code review

Once all 6 tasks are committed, dispatch a final code-reviewer subagent (per `superpowers:requesting-code-review`) against the whole plan's diff, asking it to specifically check:

1. **No duplicate `_refreshOverrideIndicators()`/`_refreshRefDecorations()` calls causing redundant network requests** — trace every call site added across Tasks 2 and 4 and confirm a single user action (e.g. clicking "New override") doesn't trigger the selections fetch more than once.
2. **The `_documentReadOnly` flag and the existing `selected === null` read-only gating don't fight each other** — re-read `_renderEditorDialog()`'s full body fresh and confirm the combined `readOnly` boolean and the button-visibility logic are self-consistent for all four combinations of (selected/not selected) × (document read-only/not).
3. **The decoration module has no memory/listener leak** — confirm `_refDecorationSlot.reconfigure(...)` fully replaces the previous extension set each time (not additively accumulating `domEventHandlers` instances), by re-reading `createExtensionSlot()`'s implementation in `app/src/modules/xmleditor.js`.
4. **Backend**: confirm `/document-rules/selections` doesn't leak one user's override existence to another (re-check `store.get_selection(kind, key, owner)` is correctly scoped to the calling user's own `owner`, not global).
