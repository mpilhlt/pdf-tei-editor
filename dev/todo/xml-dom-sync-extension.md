# Plan: Extract XML DOM Sync into a CodeMirror v6 Extension

## Context

The XML DOM synchronization logic (parsing XML, building bidirectional maps between Lezer syntax tree positions and DOM nodes, detecting processing instructions, tracking well-formedness) is currently scattered across private fields and methods of `XMLEditor`. This is not idiomatic CodeMirror v6 — the sync state should live in the editor state/view via proper CM extension primitives (StateField, ViewPlugin, StateEffect, Facet), with accessor functions for reading state.

## New Module: `app/src/modules/codemirror/xml-dom-sync.js`

### Architecture: StateField + ViewPlugin Hybrid

**Why hybrid?** The sync metadata (isWellFormed, diagnostics, syncVersion) is immutable and fits `StateField`. The mutable artifacts (DOM tree, Maps with Node references, processing instructions) cannot be serialized into CM state — they live on a `ViewPlugin` instance, following the same pattern CM6 uses internally for the syntax tree.

### Extension Primitives

**StateEffects** (trigger state transitions):
- `syncSucceeded` — dispatched when XML parses successfully and maps are built
- `syncFailed` — dispatched when XML is empty or has parse errors (carries diagnostics)
- `requestSync` — dispatched externally to force immediate sync (bypasses debounce)

**StateField `xmlDomSyncField`** (immutable metadata):
```
{ isWellFormed: boolean, diagnostics: ExtendedDiagnostic[], syncVersion: number }
```
Updated via `StateEffect`s in the standard CM `update(value, tr)` pattern.

**Facet `xmlDomSyncConfig`** (configuration):
```
{ debounceMs: number }  // default 1000
```

**ViewPlugin `xmlDomSyncPlugin`** (mutable state + sync engine):
- Instance properties: `xmlTree`, `syntaxToDom`, `domToSyntax`, `processingInstructions`, `syncVersion`
- `update(update)`: on `docChanged` — starts debounce timer; on `requestSync` effect — schedules immediate sync via `setTimeout(0)` (must not dispatch during update cycle)
- `performSync(view)`: async method that parses XML, waits for syntax parser, builds maps via `linkSyntaxTreeWithDOM()`, dispatches `syncSucceeded`/`syncFailed`
- `destroy()`: clears debounce timer

**Key constraint**: `performSync()` is always called from `setTimeout` (either debounced or immediate), never synchronously inside `update()`, to avoid "dispatch during update" errors.

### Exported API

```js
// Extension factory — add to EditorState extensions
export function xmlDomSync(config?)

// Accessor functions (CM6 pattern: function takes view/state, returns data)
export function xmlTree(view)               // Document | null
export function syntaxToDomMap(view)         // Map<number, Node>
export function domToSyntaxMap(view)         // Map<Node, number>
export function xmlSyncProcessingInstructions(view) // ProcessingInstructionData[]

// StateField for metadata (import and use with state.field())
export { xmlDomSyncField }

// Effect for manual sync trigger
export function requestSyncEffect()         // returns StateEffect<null>
```

### Functions moved into this module

| Function | Origin | Notes |
|---|---|---|
| `linkSyntaxTreeWithDOM(view, syntaxNode, domNode)` | `codemirror-utils.js` | Moved entirely (only used by sync logic) |
| `parseErrorNode(errorNode, doc)` | `XMLEditor.#parseErrorNode` | Made pure — takes `Text` doc param instead of reading from `this.#view` |
| `detectProcessingInstructions(xmlDoc)` | `XMLEditor.detectProcessingInstructions` | Takes `Document` param |
| `waitForSyntaxParser(view)` | Inlined in `XMLEditor.#updateTrees` | Extracted as helper |

Remove `linkSyntaxTreeWithDOM` from `codemirror-utils.js` after the move.

## Changes to `app/src/modules/xmleditor.js`

### Private fields removed

| Field | Replacement |
|---|---|
| `#xmlTree` | `xmlTree(this.#view)` |
| `#syntaxTree` | `syntaxTree(this.#view.state)` (already available from CM) |
| `#syntaxToDom` | `syntaxToDomMap(this.#view)` |
| `#domToSyntax` | `domToSyntaxMap(this.#view)` |
| `#processingInstructions` | `xmlSyncProcessingInstructions(this.#view)` |
| `#editorContent` | `this.#view.state.doc.toString()` |

### Private methods removed

| Method | Replacement |
|---|---|
| `#updateTrees()` | Handled by `ViewPlugin.performSync()` |
| `#updateMaps()` | Handled by `ViewPlugin.performSync()` |
| `#delayedUpdateActions()` | Debouncing handled by ViewPlugin; event emission handled by update listener |
| `#parseErrorNode()` | Moved to `xml-dom-sync.js` as standalone function |
| `#updateTimeout` field + debounce in `#onUpdate()` | Replaced by ViewPlugin's internal debounce |

### New: Compartment + update listener

**Constructor** adds `#xmlDomSyncCompartment.of(xmlDomSync({ debounceMs: 1000 }))` to extensions.

**Update listener** (added as extension) observes `xmlDomSyncField` transitions:
- When `syncVersion` changes and `isWellFormed` becomes true → emit `editorXmlWellFormed`, reconfigure `xmlTagSync` compartment ON
- When `isWellFormed` becomes false with diagnostics → emit `editorXmlNotWellFormed`, reconfigure `xmlTagSync` compartment OFF
- After any sync completion → increment `#documentVersion`, emit `editorReady`, schedule `editorUpdateDelayed`

### Method changes

**Delegating methods** (read from extension instead of private fields):
- `getXmlTree()` → `return xmlTree(this.#view)`
- `getSyntaxTree()` → `return syntaxTree(this.#view.state)`
- `getEditorContent()` → `return this.#view.state.doc.toString()`
- `getProcessingInstructions()` → `return xmlSyncProcessingInstructions(this.#view)`
- `getDomNodeAt(pos)` → reads `syntaxToDomMap(this.#view)` instead of `this.#syntaxToDom`
- `getDomNodePosition(domNode)` → reads `domToSyntaxMap(this.#view)` instead of `this.#domToSyntax`
- Similarly for `getSyntaxNodeByXpath`, `getSyntaxNodeFromDomNode`, etc.

**`sync()`** — dispatches `requestSyncEffect()` and awaits `isReadyPromise()`:
```js
async sync() {
  this.#markAsNotReady();
  this.#view.dispatch({ effects: requestSyncEffect() });
  await this.isReadyPromise();
}
```

**`loadXml()`** — includes `requestSyncEffect()` in the dispatch to bypass debounce:
```js
this.#view.dispatch({
  changes: { ... },
  effects: requestSyncEffect(),
  annotations: Transaction.addToHistory.of(false)
});
```

**`#onUpdate()`** — simplified: just sets `#editorIsDirty` and emits `editorUpdate`. No more debounce timer or `#delayedUpdateActions` call.

**`detectProcessingInstructions()`** — kept as public method for backward compat, delegates to accessor or calls the standalone function with `xmlTree(this.#view)`.

### Methods that stay unchanged on XMLEditor

All XPath query methods (`getDomNodesByXpath`, `getDomNodeByXpath`, `countDomNodesByXpath`, `selectByXpath`, `foldByXpath`, `unfoldByXpath`), `getXPathForNode`, `#serialize`, `namespaceResolver`, `updateEditorFromNode`, `updateEditorFromXmlTree`, `updateNodeFromEditor`, `getXML`, all merge view methods, all event methods.

## No changes to `app/src/modules/navigatable-xmleditor.js`

`NavXmlEditor` only uses `XMLEditor`'s public API (`getXmlTree()`, `getXPathForNode()`, `countDomNodesByXpath()`, `selectByXpath()`, `updateNodeFromEditor()`, `updateEditorFromNode()`). Since the public API signatures don't change, `NavXmlEditor` works without modification.

## Implementation Steps

1. Create `app/src/modules/codemirror/xml-dom-sync.js` with all extension primitives, standalone helper functions, and exported accessors
2. Move `linkSyntaxTreeWithDOM` from `codemirror-utils.js` into the new module, remove from old location
3. Update `XMLEditor` constructor: add `#xmlDomSyncCompartment`, add the extension to the extensions array, add the state transition update listener
4. Remove private sync fields (`#xmlTree`, `#syntaxTree`, `#syntaxToDom`, `#domToSyntax`, `#processingInstructions`, `#editorContent`) and methods (`#updateTrees`, `#updateMaps`, `#delayedUpdateActions`, `#parseErrorNode`, `#updateTimeout`)
5. Update all methods that read sync state to use accessor functions
6. Update `sync()` and `loadXml()` to use `requestSyncEffect()`
7. Simplify `#onUpdate()` — remove debounce logic

## Verification

- Load a TEI XML document → editor should display, `editorReady` fires, DOM tree accessible via `getXmlTree()`
- Edit XML content → after 1s pause, sync runs, maps update, node navigation works
- Introduce XML error → `editorXmlNotWellFormed` fires with diagnostic, xmlTagSync disabled
- Fix error → `editorXmlWellFormed` fires, xmlTagSync re-enabled
- Use merge view → existing merge functionality unaffected
- Node navigation (NavXmlEditor) → `selectByIndex`, `nextNode`, `previousNode` all work
- XPath queries → `getDomNodeByXpath`, `foldByXpath`, etc. work as before
- `updateEditorFromNode` / `updateEditorFromXmlTree` → bidirectional sync works
- Auto-save → `isDirty()` + `editorUpdateDelayed` flow works

## Implementation Report

The extension was implemented as planned. The new module `app/src/modules/codemirror/xml-dom-sync.js` provides the XML DOM sync as a self-contained CM6 extension using a StateField + ViewPlugin hybrid architecture.

### `xml-dom-sync.js`

The ViewPlugin instance holds the mutable DOM artifacts (`xmlTree`, `syntaxToDom`/`domToSyntax` maps, `processingInstructions`) and runs the sync engine. On document changes, it debounces (configurable via `xmlDomSyncConfig` Facet, default 1000ms) and then parses the XML via DOMParser, waits for the Lezer syntax parser if needed, builds bidirectional maps via `linkSyntaxTreeWithDOM()`, and dispatches `syncSucceeded` or `syncFailed` StateEffects. The StateField `xmlDomSyncField` stores the immutable metadata (`isWellFormed`, `diagnostics`, `syncVersion`) and updates via these effects.

External callers trigger an immediate sync (bypassing debounce) by dispatching `requestSyncEffect()`. All sync execution goes through `setTimeout` to avoid "dispatch during update" errors.

Four accessor functions (`xmlTree()`, `syntaxToDomMap()`, `domToSyntaxMap()`, `xmlSyncProcessingInstructions()`) read from the ViewPlugin via `view.plugin()`, following the same pattern CM6 uses for `syntaxTree(state)`.

`linkSyntaxTreeWithDOM` was moved from `codemirror-utils.js` into this module since it is only used by the sync logic. `parseErrorNode`, `detectProcessingInstructions`, and `waitForSyntaxParser` were extracted from XMLEditor's private methods into standalone functions.

### `xmleditor.js`

XMLEditor now adds the extension via `#xmlDomSyncCompartment.of(xmlDomSync())` in its constructor. A new `#onSyncStateChange(update)` method, registered as an `EditorView.updateListener`, observes `xmlDomSyncField` transitions and bridges them to XMLEditor's EventEmitter events (`editorXmlWellFormed`, `editorXmlNotWellFormed`, `editorReady`, `editorUpdateDelayed`) and manages the `xmlTagSync` compartment reconfiguration.

All private sync fields and methods were removed. Public accessor methods (`getXmlTree()`, `getDomNodeAt()`, `getDomNodePosition()`, `getProcessingInstructions()`, etc.) now delegate to the extension's accessor functions. `sync()` and `loadXml()` dispatch `requestSyncEffect()` for immediate sync. `#onUpdate()` was simplified to only set the dirty flag and emit `editorUpdate`.

### `codemirror-utils.js`

`linkSyntaxTreeWithDOM` was removed. Remaining exports: `selectionChangeListener`, `resolveXPath`, `isExtension`, `detectXmlIndentation`, `resolveDeduplicated`.

### Status

Implementation complete. Manual verification pending (see Verification section above).
