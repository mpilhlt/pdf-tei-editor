# TEI Header Editor Plugin — Design Spec

Date: 2026-10-07

## Purpose

Give users a form-based way to edit the bibliographic parts of `<teiHeader>`
(title, publication info, source description) without hand-editing raw XML,
as preparation for using the app on digital editions. Fields, labels, and
help text are generated from the RelaxNG schema that governs the open
document, falling back to the real TEI content model where the document's
own schema is too permissive or incomplete to express it.

There is currently no UI anywhere in the app for editing this data — users
either rely on extractor-seeded values, the DOI-lookup/LLM metadata-enrichment
jobs, or raw XML editing in CodeMirror.

## Scope (v1)

Editable, under `fileDesc`:

- `titleStmt/title` (main title) — **not** `titleStmt/respStmt` (see below).
- `publicationStmt` — `publisher`, `date`, `idno`, `availability/licence`,
  `ptr`.
- `sourceDesc` — `bibl` (plain-text citation) and `biblStruct` (`analytic`:
  title, author/persName, idno; `monogr`: title, idno, imprint/publisher,
  imprint/date, biblScope; `ptr`).

Explicitly excluded, because this app writes/manages them itself and a
manual editor would conflict with or duplicate that (see
[tei-header-integrations.md](../../development/tei-header-integrations.md)):

- `titleStmt/respStmt` — the document's user registry (one entry per user
  who saved a revision), not bibliographic data. Schema-wise it's a normal
  child of `titleStmt`, so the field-tree builder must exclude it explicitly
  rather than relying on it just not appearing.
- `encodingDesc` (`appInfo/application`, `editorialDecl`) — extractor
  provenance and annotation-rule refs, already managed by extraction/"Refresh
  document rules".
- `revisionDesc` — the edit-history log, written by "Save Revision" and
  friends; already has its own read UI (`tei-tools.js`'s revision-history
  drawer) and the forthcoming revision-feed plugin.
- `fileDesc/@xml:id` — document identity, managed by `update_fileref_in_xml()`.
- `profileDesc`, `notesStmt`, `xenoData` — confirmed unused anywhere in this
  app.

## Current state / precedents

- No root-level naming convention exists for a "core" plugin; it's simply a
  plugin registered in `app/src/plugins.js`, as opposed to a backend-plugin
  frontend extension loaded via `FrontendExtensionRegistry`.
- `app/src/plugins/tei-tools.js` is the precedent for adding a status button
  to the XML editor's own toolbar (not the Tools-menu style of
  `document-rules.js`): `xmlEditorApi.addToolbarWidget(button, position)`,
  gated via `userIsAnnotatorOnly()` from `app/src/modules/acl-utils.js`.
- `app/src/plugins/document-rules.js` + `app/src/templates/document-rules-editor-dialog.html`
  is the precedent for a schema/content-driven `sl-dialog`, and for writing
  XML changes back without a dedicated save endpoint: mutate the live DOM
  from `xmlEditorApi.getXmlTree()`, then `updateEditorFromNode(node)` to push
  it into CodeMirror.
- `fastapi_app/lib/utils/relaxng_to_codemirror.py`'s `RelaxNGParser` already
  parses a RelaxNG schema into per-tag `description` (from `<a:documentation>`),
  `children`, `attributes` (with enumerated values and per-value docs), and
  `bareAllowed`, via `extract_tag_definitions(root_tag, exclude)`. This is
  reused as-is for descriptions/attributes/children; it does not currently
  expose per-child cardinality (required/repeatable), which this feature
  needs — see "Backend" below.
- `fastapi_app/routers/validation.py`'s `/autocomplete-data` endpoint already
  resolves "the schema that governs the document" — via
  `extract_schema_locations()` (reads the `<?xml-model?>` PI) and
  `get_schema_cache_info()`/`download_schema_file()` (fetch + cache) — and
  parses it with `RelaxNGParser`. The new endpoint reuses this exact
  resolution.
- The bundled `schema/rng/tei-bib.rng` (full TEI P5 ODD-generated RelaxNG,
  already parsed by the same `RelaxNGParser`) is the "core TEI schema"
  fallback — no new schema file needs to be vendored into this repo.
- `docs/superpowers/specs/2026-09-28-annotator-teiheader-safeguard.md`
  established that pure annotators (`userHasAnnotatorRole && !reviewer &&
  !admin`, exposed as `userIsAnnotatorOnly()`) should not casually touch
  `<teiHeader>`; the header-visibility toggle is hidden (not just disabled)
  for this role. The new toolbar button follows the same rule.
- Saving: `saveIfDirty()` (exposed on the `xmleditor` plugin dependency) is
  the app's normal "plain save" path — the same one that already
  auto-triggers on a debounced delay after any edit
  (`XmlEditorPlugin`'s `editorUpdateDelayed` listener). It is distinct from
  the explicit "Save Revision" action that appends a `revisionDesc/change`
  entry. Calling it directly after a DOM mutation (as `document-rules.js`'s
  `_onReset()` does) persists immediately instead of waiting for the debounce.

## Design

### 1. Schema source: `grobid-footnote-flavour/schema/shared/tei-header.rng`

Add `<a:documentation>` (namespace
`http://relaxng.org/ns/compatibility/annotations/1.0`) to this file's
`<define>`s, copied from the official TEI `tei_bare.rng`
(`https://tei-c.org/release/xml/tei/custom/schema/relaxng/tei_bare.rng`)
where that schema defines the same element.

**Finding:** `tei_bare.rng` is TEI's minimal starter customization (297
`<define>`s total) and only documents a subset of what `tei-header.rng`
defines: `teiHeader`, `fileDesc`, `titleStmt`, `publicationStmt`,
`sourceDesc`, `title`, `author`, `label`. It has no `respStmt`, `resp`,
`editionStmt`, `edition`, `encodingDesc`, `editorialDecl`, `interpretation`,
`appInfo`, `application`, `desc`, `revisionDesc`, `change`, or `note` at all.
This isn't a problem for this feature: every element `tei_bare.rng` is
missing is either outside this spec's v1 scope anyway (`encodingDesc`,
`revisionDesc`) or already excluded (`respStmt`). Apply documentation only
to the eight matching defines; leave the rest of the file unannotated for
now rather than inventing text from another source.

`sourceDesc`'s own children in this schema (`biblStruct`, `availability`,
`licence`, `date`, `idno`, `publisher`, `ptr`) live in the sibling
`shared/bibl-struct.rng`/`shared/common-elements.rng`, not in
`tei-header.rng` — out of scope for this edit. Those files already carry a
handful of `<a:documentation>` annotations from earlier work; the runtime
core-schema fallback (below) covers whatever gaps remain there regardless.

### 2. Backend: schema-derived teiHeader structure

**New endpoint** `POST /api/v1/validate/teiheader-structure` in
`fastapi_app/routers/validation.py`, alongside `/autocomplete-data` (same
resolution needs, same tag). Request: `{ xml_string: str }`. The schema
resolution block currently inlined in `generate_autocomplete_data()` (lines
~124–178: `extract_schema_locations()` → pick RelaxNG → `get_schema_cache_info()`
→ download-if-missing) is extracted into a shared helper both endpoints call,
rather than duplicated.

For each of the three v1 roots (`titleStmt`, `publicationStmt`,
`sourceDesc`):

1. Run `RelaxNGParser.extract_tag_definitions(root, exclude={'respStmt'})`
   against the **document's own resolved schema**.
2. Run the same call against the bundled `schema/rng/tei-bib.rng` (parsed
   once at process start / cached, not per-request).
3. Merge per tag: keep the document schema's `attributes`/`children` where
   the tag is reachable there; take `description` from the document schema
   if present, else from the core schema. A tag reachable in the core
   schema's closure but **absent entirely** from the document schema's
   closure (e.g. a GROBID variant that doesn't define `idno` the same way)
   is included anyway, sourced fully from the core schema — this is the
   "falls back to the required element of teiHeader in the core TEI schema"
   behavior from the feature request.
4. Cardinality (`required`/`repeatable` per child, keyed by parent tag) is
   taken from the **core schema only** (per product decision — GROBID's
   training schemas use loose `zeroOrMore(choice(...))` groups that don't
   encode real TEI cardinality). This needs a new
   `_extract_child_cardinality(element) -> dict[child_name, {required: bool,
   repeatable: bool}]` in `relaxng_to_codemirror.py`, parallel to the
   existing `_is_attribute_required()` (same kind of traversal: a child is
   `required` if reachable without passing through `<optional>` or an
   unchosen `<choice>` branch or `<zeroOrMore>`; `repeatable` if reachable
   through `<oneOrMore>`/`<zeroOrMore>`). Added to `TagDefinition` as
   `childCardinality`.

Response shape:

```python
class ChildCardinality(TypedDict):
    required: bool
    repeatable: bool

class TeiHeaderTagDefinition(TypedDict):
    description: str | None
    children: list[str]
    attributes: list[TagAttribute]  # existing shape, reused
    childCardinality: dict[str, ChildCardinality]

class TeiHeaderStructureResponse(BaseModel):
    roots: list[str]                        # ["titleStmt", "publicationStmt", "sourceDesc"]
    tags: dict[str, TeiHeaderTagDefinition]  # keyed by tag name, flat closure
```

The frontend builds the nested tree client-side by recursing from each root
through `children`/`childCardinality`, exactly as the existing autocomplete
map is consumed today.

### 3. Frontend: `TeiHeaderEditorPlugin`

New file `app/src/plugins/tei-header-editor.js`, registered in
`app/src/plugins.js`. Depends on `xmleditor`, `client`, `logger`.

**Toolbar button**: `PanelUtils.createButton({ icon: 'card-heading', tooltip:
'Edit header metadata', name: 'headerEditorBtn' })`, added via
`xmlEditorApi.addToolbarWidget()` (same call `tei-tools.js` uses for its
revision-history button). Hidden for pure annotators
(`userIsAnnotatorOnly()`, checked in `onStateUpdate`/`onUserChange`, same
pattern as the existing header-visibility toggle). Disabled when no document
is open; otherwise always enabled — the dialog shows its sections even if
the current document has none of `titleStmt`/`publicationStmt`/`sourceDesc`
yet, per the core-schema-fallback behavior above.

**Dialog**: new template `app/src/templates/tei-header-editor-dialog.html` +
`.types.js`, an `sl-dialog` with one collapsible section per root
(`sl-details`), built by a generic recursive renderer:

- A tag with a non-empty `children` list renders as a nested fieldset
  (`sl-details` or a bordered `<div>`), recursing into each child.
- A tag with no element children renders as a leaf field: `sl-input` for a
  single-line value, `sl-textarea` for anything already containing
  newlines/longer text (e.g. `bibl`). The tag's `description` (from the
  merged schema data) becomes the field's `help-text`.
- A child marked `repeatable` gets an "Add" button appending another
  instance and a per-instance remove button; a child marked `required`
  shows a required marker (`*`/`sl-input[required]`) and blocks Save while
  empty with an inline validation message — enforced only by this dialog,
  not a document-wide constraint.
- An attribute with enumerated `values` renders as `sl-select`; a free
  attribute as a small adjacent `sl-input`; a `required` attribute is
  non-clearable once set (mirrors the existing annotation-chip properties
  popup's own rule for the same `required` flag).
- Recursion depth is capped at 6 levels, and any element whose content
  model mixes text and element children in a way the renderer can't model
  (anything beyond the explicit cases above) falls back to a single
  read/write `sl-textarea` of its raw inner XML — avoids needing full RNG
  pattern-algebra (interleave/choice) support for v1.

**Reading current values**: on open, read `xmlEditorApi.getXmlTree()` and
populate the form by walking the existing DOM in parallel with the schema
tree (tag-name + position matching, same style `tei-tools.js`'s
`buildRespStmtMap()` uses) — no new read endpoint; this is a pure DOM query.

**Writing values back** (on Save, "update and persist" per product
decision): mutate the same DOM tree directly — `createElementNS`/
`appendChild`/`textContent`/`removeChild` as needed, creating ancestor
elements (`fileDesc`, `titleStmt`, etc.) that don't exist yet only when the
user actually filled in something under them — then call
`updateEditorFromNode()` on the mutated subtree's closest existing ancestor,
followed by `xmlEditorApi.saveIfDirty()`. No new backend write endpoint.

## Error handling

| Condition | Behavior |
|---|---|
| Document has no schema location (`<?xml-model?>`) | Structure request still succeeds, built entirely from the core schema (`roots`/`tags` all `source: core`-equivalent, i.e. no document-schema data to merge). |
| Structure request fails (network/parse error fetching the document's schema) | Dialog opens using core-schema-only structure, with a toast warning that live document-specific descriptions couldn't be loaded. |
| Save: required field left empty | Inline validation message on that field; Save button stays disabled until resolved. |
| Save: `saveIfDirty()` fails (e.g. malformed XML elsewhere in the document) | Same handling `xmleditor.js` already has — local draft is preserved, user is notified via toast + persistent header-bar widget; this plugin does not need its own duplicate error path. |

## Testing

- Backend: unit tests for `_extract_child_cardinality()` against small
  fixture RNG snippets (required vs. optional vs. `oneOrMore` vs.
  `zeroOrMore`, including inside a `<choice>`); a test for the new
  `/teiheader-structure` endpoint's merge logic (document schema missing a
  description → core schema's used; tag absent from document schema
  entirely → included from core schema; `respStmt` never appears in
  `titleStmt`'s children regardless of what the document schema allows).
- Frontend: unit tests for the recursive form-tree builder against a fixture
  structure response (nesting, repeatable add/remove, required-field
  validation) and for the DOM-mutation writeback (creating missing ancestor
  elements, not creating elements for untouched optional sections).
- E2E: open a document, add a missing `publicationStmt/publisher`, save,
  reload, assert it round-trips; pure-annotator role sees no header-editor
  button.
- Run the full suite (`npm run test:unit`, `npm run test:e2e`) before
  finishing, per project rules.

## Migration

None. No stored data or API-breaking changes; the new endpoint is additive.

## Deferred / explicitly out of scope

- `profileDesc`, `notesStmt`, `xenoData` — unused by this app.
- `encodingDesc`, `revisionDesc`, `titleStmt/respStmt` — app-managed, have
  their own read/write paths already.
- Full RNG pattern-algebra support (`interleave`/`choice`-aware conditional
  field sets) — the generic renderer's textarea fallback covers whatever it
  can't model structurally.
- Annotating `shared/bibl-struct.rng`/`shared/common-elements.rng` in
  `grobid-footnote-flavour` — only `shared/tei-header.rng` is in scope for
  this change; the runtime core-schema fallback covers the gap at render
  time regardless.
- A write endpoint for teiHeader content — all writes go through existing
  DOM-mutation + `saveIfDirty()`, no new backend mutation surface.
