# TEI Header Integrations

Reference for which parts of a document's `<teiHeader>` this app reads and writes, and where. Use this before adding a plugin, extractor, or validation rule that touches header data, so you reuse the existing read/write path instead of re-parsing XML ad hoc.

Canonical example: [example.tei.xml](./example.tei.xml).

Two elements have their own design specs and are only summarized here:

- `encodingDesc/editorialDecl` — see [Annotation Rules in editorialDecl](#encodingdesceditorialdecl-annotation-rules) below and the specs it links to.

For fileDesc/publicationStmt/sourceDesc metadata semantics beyond what's listed here, `fastapi_app/lib/utils/tei_utils.py`'s `extract_tei_metadata()` is the canonical backend reader — read its docstring before adding a new field.

## Overview

| Element | Written by | Read by |
| --- | --- | --- |
| `fileDesc/@xml:id` | `update_fileref_in_xml()` | `extract_tei_metadata()`, `extract_fileref()` |
| `fileDesc/titleStmt` | extractors (`create_tei_header()`), metadata-extraction enhancement, `saveRevision()` (respStmt only) | `extract_tei_metadata()` (title/author fallback), revision-history UI (respStmt) |
| `fileDesc/publicationStmt`, `fileDesc/sourceDesc` | extractors, metadata-update job, metadata-extraction enhancement, `addLicenseElement()` (licence only) | `extract_tei_metadata()` (biblStruct-first, publicationStmt-fallback) |
| `encodingDesc/appInfo/application` | extractors, `ensureExtractorVariant()` (copy-on-save) | variant/extractor-provenance readers across backend and frontend (see below) |
| `encodingDesc/editorialDecl` | extractors (at extraction time), "Refresh Annotation Rules" action | `getEditorialDeclGuides()`, `extract_annotation_rule_refs()`, Annotation Guide drawer |
| `revisionDesc/change` | `create_tei_header()` (seed), extractors (replace), "Save Revision" action, "Refresh Annotation Rules" action | revision-history UI, edit-history/annotation-history reporting plugins, `extract_tei_metadata()` (last status/label) |

Not used anywhere in this app: `notesStmt`, `profileDesc`, `xenoData`.

## fileDesc/@xml:id — document identity

The primary identifier for a document. Encoded/decoded for NCName-safety (leading digits, legacy `$XX$` escaping) via `encodeFileIdForXmlId()`/`decodeXmlIdToFileId()` in [tei-utils.js](../../app/src/modules/tei-utils.js).

- Write: `update_fileref_in_xml()` in [tei_utils.py](../../fastapi_app/lib/utils/tei_utils.py) sets `fileDesc/@xml:id`.
- Read: `extract_tei_metadata()` and `extract_fileref()`, both in the same module, read `fileDesc/@xml:id`. `fastapi_app/routers/files_save.py`'s `_extract_metadata_from_xml()` (run on every save) also goes through `extract_fileref()`.

## fileDesc/titleStmt

`titleStmt/title[@level="a"]` and (legacy) `titleStmt/author` are seeded by extractors via `create_tei_header()`, and filled in when missing by the metadata-extraction enhancement ([enrich-tei-header.js](../../fastapi_app/plugins/metadata_extraction/enhancements/enrich-tei-header.js)). Author is considered redundant here once a `sourceDesc/biblStruct/analytic/author` exists — `update_biblstruct_in_tei()` removes `titleStmt/author` once it builds a `biblStruct`. `extract_tei_metadata()` reads title from `sourceDesc/biblStruct/analytic/title[@level="a"]` first, `titleStmt/title` as fallback only; it does not read `titleStmt/author` at all.

`titleStmt/respStmt` is a separate concern: it's the **user registry** for this document, not bibliographic metadata. Every human user who has saved a revision gets one entry:

```xml
<respStmt>
  <persName xml:id="cboulanger">Christian Boulanger</persName>
  <resp>Annotator</resp>
</respStmt>
```

- Write: `add_resp_stmt()` (Python) / `addRespStmt()` (JS) in `tei_utils.py`/`tei-utils.js`, idempotent per `xml:id` (raises/throws if the id already exists). `resp` is always the literal string `"Annotator"` when written from `saveRevision()` in [document-actions.js](../../app/src/plugins/document-actions.js), regardless of the user's actual role.
- Read: `get_annotator_name(root, who_id)` (Python) resolves a `revisionDesc/change/@who` (`#id`) reference to a display name; `buildRespStmtMap()` in [tei-tools.js](../../app/src/plugins/tei-tools.js) does the same for the revision-history panel.

## fileDesc/publicationStmt and fileDesc/sourceDesc

Bibliographic metadata. `sourceDesc/biblStruct` is the source of truth once it exists; `publicationStmt` fields (`publisher`, `date[@type="publication"]`, `idno[@type="DOI"]`, `ptr/@target`) are the fallback `extract_tei_metadata()` uses only when the corresponding `biblStruct` field is absent. `sourceDesc/bibl` is a plain-text citation string kept alongside `biblStruct`, not separately read back.

Writers:

- `create_tei_header()` — initial creation, hardcodes `licence[@target]` to CC-BY-4.0.
- `update_biblstruct_in_tei()` (backend bulk job) — rebuilds `sourceDesc/biblStruct` wholesale from a DOI lookup or LLM extraction result, sets `biblStruct/@status="last-updated:<timestamp>"`.
- `enrich-tei-header.js` — same, client-side, fills only missing/empty fields.
- `addLicenseElement()` in [oa-utils.js](../../app/src/modules/oa-utils.js) — separate Unpaywall-driven writer that appends `publicationStmt/licence` based on the document's DOI. Not currently called from any plugin/UI code — check for a live caller before assuming it runs automatically.

## encodingDesc/appInfo/application — extractor provenance

Two `<application>` entries, always in this order:

```xml
<encodingDesc>
  <appInfo>
    <application version="1.0" ident="pdf-tei-editor" type="editor">
      <label>PDF-TEI Editor</label>
      <ref target="https://github.com/mpilhlt/pdf-tei-editor"/>
    </application>
    <application version="0.8.3-SNAPSHOT" ident="GROBID" when="2025-08-07T14:15:00.573667Z" type="extractor">
      <label>GROBID</label>
      <label type="revision">e13aa19</label>
      <label type="flavor">article/footnotes-refs</label>
      <label type="variant-id">grobid.training.segmentation</label>
      <ref target="https://github.com/kermitt2/grobid"/>
    </application>
  </appInfo>
</encodingDesc>
```

Built by `create_encoding_desc_with_extractor()` in `tei_utils.py`, called by every extractor plugin (`grobid/extractor.py`, `llamore_extractor/extractor.py`) at extraction time. `variant-id` is the extractor-plugin-specific variant identifier (e.g. `grobid.training.segmentation`, `llamore-default`) — the same value used by each plugin's `AnnotationGuide.variant_ids` config (see editorialDecl section below).

**This is the only place a document's own variant is recorded.** There is no live "current document variant" read in the frontend — `state.variant` in `app/src/state.js` is a UI **filter** value (populated from the DB's per-file `variant` column, itself populated at save/extraction time by the backend parsing this same `label[@type="variant-id"]`), not something re-parsed from the open document on every read. If you need the open document's own variant, read `encodingDesc/appInfo/application[@type="extractor"]/label[@type="variant-id"]` directly (e.g. via `getDocumentMetadata()`'s `variant_id` field in `tei-utils.js`) rather than assuming `state.variant` matches it.

Other readers: `parse_encoding_labels()` in `fastapi_app/plugins/grobid/sync.py` (used by the annotation-rules-refresh precondition check and the training-feature-tokens route to locate cached GROBID artifacts by variant/revision/flavor); `extract_variant_id()` in `tei_utils.py` (used by `local_sync` and `files_save.py` to populate the DB `variant` column on every save).

`ensureExtractorVariant()` in `tei-utils.js` is the one frontend writer: it re-stamps `label[@type="variant-id"]` when a document is saved as a new copy, so the variant survives the copy.

GROBID also stores a training-data-id label on its own `application[@ident="GROBID"]` element via `get_training_data_id()`/`set_training_data_id()` in `tei_utils.py` — GROBID-specific, not part of the generic shape above.

## encodingDesc/editorialDecl: annotation rules

Links each document to the annotation-guide rules that apply to it, split into one or more independent **categories** (e.g. the main per-variant guide a human annotator should read, plus optional category-specific excerpts for automated checks). This is the element a validation/linting plugin should read to find out which rules apply to the document it's validating.

Design rationale: [2026-09-22-editorial-decl-annotation-rules-design.md](../superpowers/specs/2026-09-22-editorial-decl-annotation-rules-design.md) (why editorialDecl at all) and [2026-09-22-annotation-guide-dual-target-refs-design.md](../superpowers/specs/2026-09-22-annotation-guide-dual-target-refs-design.md) (why each ref has a human/machine pair).

### Shape

```xml
<encodingDesc>
  <editorialDecl>
    <interpretation type="primary">
      <p>
        <ref target="https://github.com/mpilhlt/fossil/blob/<sha>/docs/guidelines.md#document-segmentation-model" subtype="human" type="markdown"/>
        <ref target="https://github.com/mpilhlt/fossil/blob/<sha>/docs/guidelines.md#L42-L88" subtype="machine"/>
      </p>
    </interpretation>
    <interpretation type="data-correction">
      <p>
        <ref target="https://github.com/mpilhlt/fossil/blob/<sha>/docs/guidelines.md#data-correction" subtype="human" type="markdown"/>
        <ref target="https://github.com/mpilhlt/fossil/blob/<sha>/docs/guidelines.md#L120-L145" subtype="machine"/>
      </p>
    </interpretation>
  </editorialDecl>
  <appInfo>...</appInfo>
</encodingDesc>
```

`editorialDecl` precedes `appInfo` (TEI content-model convention: editorialDecl, schemaRef, appInfo) and is only emitted at all if there's at least one entry.

- `interpretation/@type` — the rule **category**. `"primary"` is the sentinel for the one main guide a human annotator should read for this variant; other categories (e.g. `"data-correction"`, `"footnote-annotation"`) are optional, additional excerpts, typically for machine/LLM validation rather than the drawer UI. An extractor plugin's config decides which categories apply to a given variant (see below).
- Each `interpretation` holds one or two `<ref>` children, distinguished by `@subtype`:
  - `subtype="human"` — a heading-anchor URL (`#some-heading`) meant for a human to open in the Annotation Guide drawer. `@type` on the ref is its content type, `"markdown"` or `"html"`.
  - `subtype="machine"` — auto-derived from the human ref's heading anchor by scanning the target Markdown document for ATX headings and translating the anchor to a line-range URL fragment (`#L42-L88`). Never hand-authored; regenerating it re-derives it from the human ref, so the two can't drift out of sync. Has no `@type` (line-range content isn't associated with a content type the same way). May be absent if anchor-to-line-range translation failed (e.g. the anchor wasn't found) — treat a missing machine ref as "fall back to fetching the whole document" rather than an error.
  - A `ref` missing `@target`, or with an unrecognized/missing `@subtype`, is dropped by both readers below (not surfaced as a malformed entry).
- `@target` URLs are branch-relative git-forge blob links, resolved to commit-SHA-pinned permalinks (`resolve_forge_permalink()`) when embedded — so the reference stays valid even if the guide document is later edited on its branch.

### Config: what generates editorialDecl entries

Each extractor plugin declares its own `AnnotationGuide` list (see [annotation_guides.py](../../fastapi_app/plugins/grobid/config/annotation_guides.py) for GROBID, `ANNOTATION_GUIDES` in [llamore_extractor/config.py](../../fastapi_app/plugins/llamore_extractor/config.py)):

```python
class AnnotationGuide(TypedDict):
    variant_ids: list[str]  # or ["*"] to apply to every variant
    category: str
    type: Literal["markdown", "html"]
    url: str
```

At extraction time, `build_editorial_decl_entries(variant_id, cache)` (per-plugin, e.g. `fastapi_app/plugins/grobid/annotation_rules.py`) matches the document's variant against each guide's `variant_ids` (exact match or `"*"` wildcard), resolves the permalink, derives the machine ref, and returns the `AnnotationRuleRef` list that `create_encoding_desc_with_extractor()` writes into `editorialDecl`. A reviewer-facing "Refresh Annotation Rules" action (`annotation_rules_refresh.py`) re-runs the same resolution on demand, so an already-extracted document can pick up rules changes without re-extraction; it also appends a `revisionDesc/change` noting the update.

### Reading editorialDecl

- Backend: `extract_annotation_rule_refs(xml_string)` in [annotation_rules_utils.py](../../fastapi_app/lib/utils/annotation_rules_utils.py) → `list[AnnotationRuleRef]`, one entry per `category` with its `refs` list (`target`, `content_type`, `subtype`). An interpretation missing `@type`, or that ends up with no usable refs, is skipped rather than returned empty. Use this from a Python validation plugin.
- Frontend: `getEditorialDeclGuides(xmlDoc)` in [tei-utils.js](../../app/src/modules/tei-utils.js) → the same shape (camelCase: `contentType`). Uses plain tag-name traversal, not XPath (JSDOM's XPath doesn't reliably resolve namespaces — see "JSDOM Limitations for Browser-Targeted Code" in [testing-guide.md](../code-assistant/testing-guide.md)).
- Consumer example: [annotation-guide.js](../../app/src/plugins/annotation-guide.js)'s `#getDocumentPrimaryGuide()` — finds the `category === 'primary'` entry, picks its `subtype === 'human'` ref, and falls back to the runtime per-variant config (the extractor's `AnnotationGuide` list directly, bypassing editorialDecl) if the document has none — e.g. for documents extracted before this feature existed.

**To hook in a new consumer** (e.g. an annotation validation plugin that checks output against category-specific rules): call the reader above, find your category by `category ===` your rule's name, and use the `machine` ref's line-range target with `fetch_rule_excerpt(url, cache)` (same module) to fetch just the relevant slice of the guide document rather than the whole file — this is precisely what the machine ref exists for.

## revisionDesc/change

The document's edit history. One `<change>` per save/status-transition:

```xml
<revisionDesc>
  <change when="2025-07-11" status="extraction">
    <desc>Extracted 2025-07-11 14:39:36</desc>
  </change>
  <change when="2025-08-25T08:50:02.437Z" status="draft" who="#cboulanger">
    <note type="label">Grobid document segmentation</note>
    <desc>Save gold file</desc>
  </change>
</revisionDesc>
```

- `@status` — one of the ordered lifecycle states in `config/config.json`'s `annotation.lifecycle.order` (`extraction`, `unfinished`, `draft`, `checked`, `in-review`, `approved`, `candidate`, `published`). Which of these a user may set is role-gated via `annotation.lifecycle.role.<role>` in the same config.
- `@who` — always `#<username>`, normalized on write (leading `#` added if missing). Resolves against `titleStmt/respStmt/persName/@xml:id` (see above); falls back to the raw id if no matching respStmt exists.
- `<note type="label">` — optional, human-readable version label (e.g. shown in the file-selection drawer).
- `<desc>` — the change description shown in the revision-history panel.

Writers:

- `create_tei_header()` — seeds an initial `created`-status change; extractors immediately replace this with their own `extraction`-status change (`create_revision_desc_with_status()`).
- `saveRevision()` in `document-actions.js` — the "Save Revision" toolbar action; the primary way `revisionDesc` grows during normal editing. Auto-advances status from `extraction` to the next lifecycle state or `unfinished` if the user doesn't pick one.
- `_add_revision_change()` in `annotation_rules_refresh.py` — appended by "Refresh Annotation Rules"; has no `@status`.

Readers:

- `extract_tei_metadata()` — `status`/`last_revision`/`edition_title` from the **last** change only.
- `get_annotator_name()`, `buildRespStmtMap()` — `@who` resolution (see titleStmt section).
- Revision-history panel (`#showRevisionHistory()` in `tei-tools.js`) — reads **all** changes, not just the last.
- `edit_history`/`annotation_history` plugins — read-only reporting across a collection/document, both read-only consumers of the last change plus `extract_tei_metadata()`.

> **Known parallel signal:** `extract_tei_metadata()` also derives an `is_gold_standard` heuristic from `@status` being one of `gold`/`final`/`published`. This exists alongside a separate, explicit gold-standard flag in the DB (set via the "Save as Gold" action). The two can disagree; don't assume one implies the other.
