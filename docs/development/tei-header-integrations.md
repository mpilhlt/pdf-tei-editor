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
| `fileDesc/titleStmt` | extractors (`create_tei_header()`), metadata-extraction enhancement, `saveRevision()` (respStmt only), `TeiHeaderEditorPlugin` (title only) | `extract_tei_metadata()` (title/author fallback), revision-history UI (respStmt), `TeiHeaderEditorPlugin` (title only) |
| `fileDesc/publicationStmt`, `fileDesc/sourceDesc` | extractors, metadata-update job, metadata-extraction enhancement, metadata-extraction collection backfill (`sourceDesc/biblStruct` only), `addLicenseElement()` (licence only), `TeiHeaderEditorPlugin` (fixed field list) | `extract_tei_metadata()` (biblStruct-first, publicationStmt-fallback), `TeiHeaderEditorPlugin` (fixed field list) |
| `encodingDesc/appInfo/application` | extractors, `ensureExtractorVariant()` (copy-on-save) | variant/extractor-provenance readers across backend and frontend (see below) |
| `encodingDesc/editorialDecl` | extractors (at extraction time), "Refresh document rules" action | `getEditorialDeclGuides()`, `extract_annotation_rule_refs()`, Annotation Guide drawer |
| Schema location (`<?xml-model?>` PI, or `encodingDesc/schemaRef` fallback) | "Refresh document rules" action (PI only - see below) | `extract_schema_locations()`, `SchemaKind.discover()`, document-rules registry decorations |
| `profileDesc/langUsage/language/@ident` | `create_tei_header()` (registry language), extraction route (`add_document_language()`, after every extractor), metadata-update job, metadata-extraction enhancement, metadata-extraction collection backfill, `TeiHeaderEditorPlugin` ("Language" field) | `get_document_language()`, `TeiHeaderEditorPlugin` |
| `revisionDesc/change` | `create_tei_header()` (seed), extractors (replace), "Save Revision" action, "Refresh document rules" action | revision-history UI, edit-history/annotation-history reporting plugins, `extract_tei_metadata()` (last status/label) |

Not used anywhere in this app: `notesStmt`, `xenoData`, and `profileDesc` children other than `langUsage`.

## fileDesc/@xml:id — document identity

The primary identifier for a document. Encoded/decoded for NCName-safety (leading digits, legacy `$XX$` escaping) via `encodeFileIdForXmlId()`/`decodeXmlIdToFileId()` in [tei-utils.js](../../app/src/modules/tei-utils.js).

- Write: `update_fileref_in_xml()` in [tei_utils.py](../../fastapi_app/lib/utils/tei_utils.py) sets `fileDesc/@xml:id`.
- Read: `extract_tei_metadata()` and `extract_fileref()`, both in the same module, read `fileDesc/@xml:id`. `fastapi_app/routers/files_save.py`'s `_extract_metadata_from_xml()` (run on every save) also goes through `extract_fileref()`.

## fileDesc/titleStmt

`titleStmt/title[@level="a"]` and (legacy) `titleStmt/author` are seeded by extractors via `create_tei_header()`, and filled in when missing by the metadata-extraction enhancement ([enrich-tei-header.js](https://github.com/mpilhlt/pte-plugins/tree/main/plugins/metadata-extraction/src/pte_plugin_metadata_extraction/enhancements/enrich-tei-header.js)). Author is considered redundant here once a `sourceDesc/biblStruct/analytic/author` exists — `update_biblstruct_in_tei()` removes `titleStmt/author` once it builds a `biblStruct`. `extract_tei_metadata()` reads title from `sourceDesc/biblStruct/analytic/title[@level="a"]` first, `titleStmt/title` as fallback only; it does not read `titleStmt/author` at all.

`TeiHeaderEditorPlugin` ([tei-header-editor.js](../../app/src/plugins/tei-header-editor.js)) adds a toolbar-triggered dialog that also reads/writes `titleStmt/title` specifically — one fixed field out of a small, hand-picked list (see `FIELD_DEFS` in [tei-header-form.js](../../app/src/modules/tei-header-form.js)), not the rest of `titleStmt`. It is hidden for pure-annotator-role users. `titleStmt/respStmt` is untouched by this dialog — that's covered below.

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
- `TeiHeaderEditorPlugin` ([tei-header-editor.js](../../app/src/plugins/tei-header-editor.js)) — UI-driven writer/reader, via a fixed, hand-picked field list (see `FIELD_DEFS` in [tei-header-form.js](../../app/src/modules/tei-header-form.js)): `publisher`, `date[@type="publication"]`, `idno[@type="DOI"]`, `sourceDesc/bibl`, and `sourceDesc/biblStruct/analytic`'s `author/persName` (repeatable) and `title`, plus `biblStruct/monogr/title`. Nothing else under `publicationStmt`/`sourceDesc` is read or written by this dialog. Does not touch `encodingDesc` or `revisionDesc`, which are covered by the writers/rows elsewhere in this doc.

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

Other readers: `parse_encoding_labels()` in `pte-plugins/plugins/grobid/src/pte_plugin_grobid/sync.py` (used by the training-feature-tokens route to locate cached GROBID artifacts by variant/revision/flavor); `extract_extractor_provenance()` in `fastapi_app/lib/doc_rules/rules_providers.py` (used by the "Refresh document rules" action to dispatch to the right extractor's `DocumentRulesProvider`, generically across extractors - see [2026-09-27-document-rules-registry-design.md](../superpowers/specs/2026-09-27-document-rules-registry-design.md)); `extract_variant_id()` in `tei_utils.py` (used by `local_sync` and `files_save.py` to populate the DB `variant` column on every save).

`ensureExtractorVariant()` in `tei-utils.js` is the one frontend writer: it re-stamps `label[@type="variant-id"]` when a document is saved as a new copy, so the variant survives the copy.

GROBID also stores a training-data-id label on its own `application[@ident="GROBID"]` element via `get_training_data_id()`/`set_training_data_id()` in `tei_utils.py` — GROBID-specific, not part of the generic shape above.

## encodingDesc/editorialDecl: annotation rules

Links each document to the annotation-guide rules that apply to it, split into one or more independent **categories** (e.g. the main per-variant guide a human annotator should read, plus optional category-specific excerpts for automated checks). This is the element a validation/linting plugin should read to find out which rules apply to the document it's validating.

Design rationale: [2026-09-22-editorial-decl-annotation-rules-design.md](../superpowers/specs/2026-09-22-editorial-decl-annotation-rules-design.md) (why editorialDecl at all), [2026-09-22-annotation-guide-dual-target-refs-design.md](../superpowers/specs/2026-09-22-annotation-guide-dual-target-refs-design.md) (why each ref has a human/machine pair), and [2026-09-27-document-rules-registry-design.md](../superpowers/specs/2026-09-27-document-rules-registry-design.md) (the `@n` label, added so a category can be shown to a user without exposing its `@type` slug or its `ref/@target` URL).

### Shape

```xml
<encodingDesc>
  <editorialDecl>
    <interpretation type="primary" n="Document segmentation">
      <p>
        <ref target="https://github.com/mpilhlt/fossil/blob/<sha>/docs/guidelines.md#document-segmentation-model" subtype="human" type="markdown"/>
        <ref target="https://github.com/mpilhlt/fossil/blob/<sha>/docs/guidelines.md#L42-L88" subtype="machine"/>
      </p>
    </interpretation>
    <interpretation type="data-correction" n="Data correction">
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
- `interpretation/@n` — a short, human-readable label for the category (e.g. `"Data correction"`), from TEI's generic `att.global.attribute.n`. `interpretation`'s content model (`oneOrMore(p|ab)`, per `schema/rng/tei-bib.rng`) does not allow a `desc` child, so `@n` is the label's home; a category can therefore be shown to a user (e.g. a menu of the document's rule categories) without exposing its `@type` slug. Optional — a document written before this addition simply has none; readers fall back to `@type`.
- Each `interpretation` holds one or two `<ref>` children, distinguished by `@subtype`:
  - `subtype="human"` — a heading-anchor URL (`#some-heading`) meant for a human to open in the Annotation Guide drawer. `@type` on the ref is its content type, `"markdown"`, `"html"`, or `"xml"` (the latter only for a `"schema-fragment"` category entry — see below; it has no heading-anchor/machine-ref concept since it targets a whole RNG file, not a guide document).
  - `subtype="machine"` — auto-derived from the human ref's heading anchor by scanning the target Markdown document for ATX headings and translating the anchor to a line-range URL fragment (`#L42-L88`). Never hand-authored; regenerating it re-derives it from the human ref, so the two can't drift out of sync. Has no `@type` (line-range content isn't associated with a content type the same way). May be absent if anchor-to-line-range translation failed (e.g. the anchor wasn't found) — treat a missing machine ref as "fall back to fetching the whole document" rather than an error.
  - A `ref` missing `@target`, or with an unrecognized/missing `@subtype`, is dropped by both readers below (not surfaced as a malformed entry).
- `@target` URLs are branch-relative git-forge blob links, resolved to commit-SHA-pinned permalinks (`resolve_forge_permalink()`) when embedded — so the reference stays valid even if the guide document is later edited on its branch.

### Config: what generates editorialDecl entries

Each extractor plugin declares its own `AnnotationGuide` list (see [annotation_guides.py](https://github.com/mpilhlt/pte-plugins/tree/main/plugins/grobid/src/pte_plugin_grobid/config/annotation_guides.py) for GROBID, `ANNOTATION_GUIDES` in [llamore_extractor/config.py](https://github.com/mpilhlt/pte-plugins/tree/main/plugins/llamore-extractor/src/pte_plugin_llamore_extractor/config.py)):

```python
class AnnotationGuide(TypedDict):
    variant_ids: list[str]  # or ["*"] to apply to every variant
    category: str
    type: Literal["markdown", "html"]
    url: str
    label: str  # interpretation/@n
```

At extraction time, `build_editorial_decl_entries(variant_id, cache)` (per-plugin, e.g. `pte-plugins/plugins/grobid/src/pte_plugin_grobid/annotation_rules.py`) matches the document's variant against each guide's `variant_ids` (exact match or `"*"` wildcard), resolves the permalink, derives the machine ref, and returns the `AnnotationRuleRef` list that `create_encoding_desc_with_extractor()` writes into `editorialDecl`. A reviewer-facing "Refresh document rules" core action (`fastapi_app/lib/doc_rules/rules_refresh.py`, exposed at `POST /api/v1/document-rules/refresh/{preview,execute}`) re-runs the same resolution on demand, dispatching to whichever extractor plugin produced the document via `get_document_rules_provider_for_document()`/`DocumentRulesProvider` (`fastapi_app/lib/doc_rules/rules_providers.py`) — so an already-extracted document can pick up rules changes without re-extraction, regardless of which extractor produced it; it preserves each entry's `@n` and appends a `revisionDesc/change` noting the update, and regenerates the schema processing instruction while pretty-printing the whole header, matching extraction-time formatting.

GROBID additionally emits one `"schema-fragment"` category entry per training variant that has a dedicated upstream source file in `mpilhlt/fossil` (`get_schema_fragment_url()`/`SCHEMA_FRAGMENT_VARIANTS`/`SCHEMA_FRAGMENT_LABELS` in [`pte-plugins/plugins/grobid/src/pte_plugin_grobid/config/__init__.py`](https://github.com/mpilhlt/pte-plugins/tree/main/plugins/grobid/src/pte_plugin_grobid/config/__init__.py)), appended directly in `build_editorial_decl_entries()` alongside the `AnnotationGuide`-derived entries rather than through the `AnnotationGuide` table itself — deliberately, since `get_annotation_guides()` is returned verbatim as the `annotationGuides` API field consumed by the frontend's Annotation Guide drawer, and a schema-source pointer is not annotation guidance. It has a single `subtype="human"`, `type="xml"` ref (no machine sibling — there's no heading-anchor/line-range concept for a whole RNG file), pointing at the hand-editable upstream source, distinct from the generated/validated-against schema the `<?xml-model?>` PI (below) points at:

```xml
<interpretation type="schema-fragment" n="Segmentation schema source">
  <p>
    <ref target="https://github.com/mpilhlt/fossil/blob/<sha>/schema/grobid.training.segmentation.rng"
         type="xml" subtype="human"/>
  </p>
</interpretation>
```

See [2026-09-28-grobid-schema-fragment-refs-design.md](../superpowers/specs/2026-09-28-grobid-schema-fragment-refs-design.md) for the full rationale.

### Reading editorialDecl

- Backend: `extract_annotation_rule_refs(xml_string)` in [annotation_rules_utils.py](../../fastapi_app/lib/utils/annotation_rules_utils.py) → `list[AnnotationRuleRef]`, one entry per `category` with its `refs` list (`target`, `content_type`, `subtype`). An interpretation missing `@type`, or that ends up with no usable refs, is skipped rather than returned empty. Use this from a Python validation plugin.
- Frontend: `getEditorialDeclGuides(xmlDoc)` in [tei-utils.js](../../app/src/modules/tei-utils.js) → the same shape (camelCase: `contentType`). Uses plain tag-name traversal, not XPath (JSDOM's XPath doesn't reliably resolve namespaces — see "JSDOM Limitations for Browser-Targeted Code" in [testing-guide.md](../code-assistant/testing-guide.md)).
- Consumer example: [annotation-guide.js](../../app/src/plugins/annotation-guide.js)'s `#getDocumentPrimaryGuide()` — finds the `category === 'primary'` entry, picks its `subtype === 'human'` ref, and falls back to the runtime per-variant config (the extractor's `AnnotationGuide` list directly, bypassing editorialDecl) if the document has none — e.g. for documents extracted before this feature existed.

**To hook in a new consumer** (e.g. an annotation validation plugin that checks output against category-specific rules): call the reader above, find your category by `category ===` your rule's name, and use the `machine` ref's line-range target with `fetch_rule_excerpt(url, cache)` (same module) to fetch just the relevant slice of the guide document rather than the whole file — this is precisely what the machine ref exists for.

**Document rules overrides** ("Edit document rules", `InterpretationRefKind` in [interpretation_ref_kind.py](../../fastapi_app/lib/doc_rules/interpretation_ref_kind.py)) are stored per **layer** of a rule category (#666). `discover()` emits one `ResourceDescriptor` per layer, with `layer` (`"human"` or `"machine"`) and a shared `group` (`interpretation-ref:<category>`). `layer_refs()` decides the layers of an interpretation entry: `"human"` is its human ref; `"machine"` is its machine ref, unless that points into the same file as the human ref, in which case it is an excerpt of the human section and is folded into the human layer (no separate machine layer). The frontend shows the layers as the tabs `Guide (human)` and `Machine rules`, each with its own overrides and selection.

- **Resource key** = file + heading anchor (`resource_key()`): a ref whose line-range start is a Markdown heading is keyed by that heading's anchor (`file.md#heading`), so upstream edits that shift line numbers do not orphan overrides. If the start line is no heading or the file cannot be fetched, the legacy line-range key is used (`legacy_resource_key()`).
- **Human override** = the text of that heading's section only (`fetch_rule_section()`); "Propose change upstream" splices it into the file with `splice_heading_section()`. **Machine override** = the text of the machine ref's excerpt or file; proposals splice with `splice_line_range()`.
- **Outdated flag**: an override stores the hash of the original it was based on (`base_hash`); `/query` returns `outdated` when it differs from the current original. A migrated row has an empty `base_hash` and is not flagged. Saving an override with `fragment_url` (as the editor's Save does) rebases it on the current original and clears the flag.
- **Reviewer layer choice**: `selected_rule_override_text()` returns the owner's selected override for the machine layer if the entry has one, else for the human layer. Consumers (e.g. the LLM reviewer's `gather_rule_excerpts()`) must use it, or `representative_ref()` where they need the single ref the reviewer reads, rather than picking a subtype themselves. It only reads; it never moves rows.
- **Legacy line-range keys**: `migrate_legacy_override_keys()` ([legacy_key_migration.py](../../fastapi_app/lib/doc_rules/legacy_key_migration.py)) moves overrides stored under a pre-#666 line-range key to the heading-anchor key. It runs once per process start, in a background thread started from `lifespan()` in `main.py`. Each row is resolved against its own stored, possibly SHA-pinned `base_url` (legacy keys are SHA-stripped) and moved with `DocumentRulesStore.rekey_override()`; the owner's selection of the row moves with it unless the owner already has a selection under the new key, which then wins. Rows whose file cannot be fetched are retried on the next start; rows whose start line is no heading keep their line-range key. Request handlers never migrate.
- **Strict keys on writes**: `resource_key(url, strict=True)` raises `RuleFetchError` instead of falling back to the legacy key. The routes that write or select (`/overrides` create and update, `/selection`, `/selection/reset`) use it and return 502, so a fetch failure cannot pass for a different resource; read routes keep the fallback.
- **Migration m011** ([m011_document_rules_section_overrides.py](../../fastapi_app/lib/core/migrations/versions/m011_document_rules_section_overrides.py)) cuts legacy whole-file human overrides (heading-anchor keys written before #645, which held entire guide files) down to their section, sets their `base_hash` to empty, and deletes a row, with its selections, only when its anchor is not found in its text and the text is not a single section (a heading whose section spans the whole text, as rows saved by the new code are); such single-section rows are kept as they are. Line-range and fragment-less rows are untouched.
- The Annotation Guide drawer ([annotation-guide.js](../../app/src/plugins/annotation-guide.js)) replaces the open document's human-ref section with the reviewer's selected human override and shows the `Personal version` badge.

### Sync status between the layers (#666 Phase 2)

[guide_sync.py](../../fastapi_app/lib/doc_rules/guide_sync.py) tells whether a machine section is up to date with its human section.

- **Marker**: the machine section carries `<!-- sync: guide=<sha256> llm=<sha256> -->`, optionally with ` base=<commit>` (a commit id, see below). `guide` is the hash of the human section and `llm` the hash of the machine section when they were last synced. `parse_sync_marker()` and `format_sync_marker()` read and write it (`SyncMarker`).
- **Hashing**: `section_hash()` is the algorithm of fossil's `scripts/check-llm-digest.py`: remove the sync comment, drop blank lines, `rstrip` each line, join with `\n`, SHA-256 hex of the UTF-8 text. `human_section_hash()` first applies `derelativize_markdown_urls(section, human_url)`, because core makes relative links absolute when it fetches a guide, and the marker has to match the text as the repository holds it. That function turns every absolute link into the same repository back into a relative one, including links the human guide itself wrote as absolute. Such a guide hashes differently here than in fossil's check, so write same-repository links in a human guide as relative links.
- **Status**: `sync_status(human_section, machine_section, human_url)` returns one of `in_sync`, `machine_outdated` (human hash differs from `guide`), `machine_edited` (machine hash differs from `llm`), `both_changed` or `no_marker`.
- **History search**: `find_synced_human_commit(human_url, marker, cache, limit=20, deadline_seconds=20.0)` walks the guide file's commits newest first, on the URL's branch, or on the default branch for a SHA-pinned URL (`list_file_commits()` and `url_at_commit()` of the `GitForgeAdapter`, see [git_forge_adapters.py](../../fastapi_app/lib/core/git_forge_adapters.py)), hashes the section at each commit and returns the first commit whose hash equals `marker.guide_hash`. It checks at most 20 commits, stops after `marker.base`, and gives up before the next fetch once about 20 seconds have passed. It returns None if nothing matches, the URL has no heading anchor or no forge adapter, the deadline passes, or a request fails. The adapters drop listing entries that are not full 40-hex SHAs.
- **Route**: `POST /api/v1/document-rules/sync-status` (`human_url`, `machine_url`) returns `status`, `human_source` and `machine_source` (`"original"` or `"override"`), `base` and `synced_commit`. Each layer's text is the caller's selected override, else the original. The commit search runs only for `machine_outdated` and `both_changed`. The route is a plain `def` as it fetches over the network. Client method: `documentRulesSyncStatus()` in [api-client-v1.js](../../app/src/modules/api-client-v1.js).
- **Editor**: the status line (`syncStatus` in [document-rules-editor-dialog.html](../../app/src/templates/document-rules-editor-dialog.html)) is filled by `_refreshSyncStatus()` in [document-rules.js](../../app/src/plugins/document-rules.js). It is only shown for a group with both layers.
- **Condensing prompt**: [condense_prompt.py](../../fastapi_app/lib/doc_rules/condense_prompt.py) defines `DEFAULT_CONDENSE_PROMPT`, the instruction for condensing a guide section into machine rules. `resolve_condense_prompt(xml_string, guide_url)` returns the prompt of the document's extractor `DocumentRulesProvider` if it implements the optional `get_condense_prompt(guide_url)` hook (see [rules_providers.py](../../fastapi_app/lib/doc_rules/rules_providers.py)), else the default. A provider without the method, or one returning None or an empty string, gets the default. A non-string result is logged as a warning and replaced by the default. An exception raised by the provider propagates.

### Update from guide (#666 Phase 3)

[guide_update.py](../../fastapi_app/lib/doc_rules/guide_update.py) has a language model update a machine section after its human section changed. Nothing is stored by the routes; the frontend saves an accepted proposal as a machine-layer override (note `Updated from guide with <model label>`).

- **Inputs** (`gather_guide_change()` returns a `GuideChange`): `new_human` and the machine text are the owner's selected overrides, else the originals (`layer_text()`). If the machine text has a sync marker and `find_synced_human_commit()` finds the guide commit it was synced with, `old_human` is the human section at that commit (`human_section_at_commit()`) and the mode is `delta`; otherwise `old_human` is None and the mode is `align`.
- **Link forms**: the texts given to the model (`old_human`, `new_human`, `machine`) have same-repository links relative (`derelativize_markdown_urls()`), so the ref a text was fetched at does not show up as a change in the prompt. `machine` in the route responses (`machine_full`) and `proposed` have them absolute against the machine url (`absolutize_markdown_urls()`), the form of originals and overrides, so that they render in the preview and their diff shows only the model's changes. `old_human` and `new_human` in the responses stay relative.
- **Prompts**: `build_update_prompts()` takes the system prompt from `resolve_condense_prompt()` (stripped; `DEFAULT_CONDENSE_PROMPT` if empty) and the user prompt from `DELTA_PROMPT_TEMPLATE` or `ALIGN_PROMPT_TEMPLATE`. The completion runs with `temperature=0.2`. See the module for the templates.
- **Answer cleanup**: `clean_model_answer()` unwraps a surrounding code fence, drops sync markers the model emitted, prepends the machine section's heading if the answer has none, re-inserts the original marker line after the heading and makes links absolute. An empty answer raises `ValueError`.
- **Routes** (both `require_reviewer_or_admin`; client methods `documentRulesHumanChange()` and `documentRulesUpdateFromGuide()` in [api-client-v1.js](../../app/src/modules/api-client-v1.js)):
  - `POST /api/v1/document-rules/human-change` (`human_url`, `machine_url`) returns `mode`, `old_human`, `new_human`, `machine`, `base_commit` and `unchanged` (delta mode only: whether `old_human` and `new_human` have the same section hash). A plain `def`, as it fetches over the network.
  - `POST /api/v1/document-rules/update-from-guide` (`xml`, `human_url`, `machine_url`, `provider_id`, `model_id`) returns the same fields plus `proposed`. `xml` selects the condensing prompt of the document's extractor. An `async def` that runs its blocking parts with `run_in_threadpool()`. The provider and model access are checked before the guide is fetched.
- **Errors**: 404 unknown provider; 428 the provider needs a secret the user has not stored (`secret_required_detail()`); 403 model not allowed (`ModelAccessDenied`); 502 a rule original could not be fetched, the provider request failed (`LLM provider request failed: ...`) or the model returned no machine rules; 500 the condensing prompt could not be resolved.
- **Frontend**: the `Update from guide` sub-dialog ([document-rules.js](../../app/src/plugins/document-rules.js), template `document-rules-update-dialog.html`) lists models with `inference-settings.getModels()`.

### Paired upstream proposals

[upstream_proposal.py](../../fastapi_app/lib/doc_rules/upstream_proposal.py) builds one patch for a human/machine pair. `POST /api/v1/document-rules/propose-patch` (`human_url`, `machine_url`, `include_human`, `include_machine`, `label`; `require_reviewer_or_admin`; a plain `def`, as it fetches) returns `files` (`path`, `before`, `after`), `patch`, `filename`, `branch`, `upstream_changed` and `in_sync`. Nothing is stored. Client method: `documentRulesProposePatch()`. Single-layer resources (and layers outside a pair) keep the forge edit-page flow of `documentRulesProposeChangeUrl()` (`POST /api/v1/document-rules/propose-change-url`).

- **Splicing**: each layer's text is the caller's selected override. It is spliced by its heading anchor into the file as it is on the repository's default branch (not at the ref in the url), so the patch applies to the current file. Both urls must resolve to one repository, else 422. The proposed text must start with the section's heading (leading blank lines are dropped), else 422 `The proposed text for <path> must start with the heading of the section "<anchor>".`
- **`upstream_changed`**: the repository paths (human first, included layers only) whose section on the default branch differs from the pinned original section, compared with `section_hash()` in relative-link form (`derelativize_markdown_urls()`), ignoring markers. The patch replaces those changes; the dialog warns per path.
- **Marker**: when the machine layer is included, its marker is recomputed as `format_sync_marker(SyncMarker(guide_hash, llm_hash, base=None))`, with no `base=`, on its own line after the machine heading with a blank line on each side. `guide_hash` is always the hash of the caller's current human text (selected override, else the pinned original, made relative), whether or not the human layer is included: the guide text the machine rules were derived from, never the default branch's section. `in_sync` is true iff the machine layer is included and the human section upstream after the patch (the proposed one if included, else the default branch's) has that hash; otherwise the machine rules read as outdated there and the dialog says so. With only the human layer included, the machine file is untouched and so reads as outdated.
- **Patch**: a unified diff for `git apply` at the repository root. A preamble of lines starting with `#` (`# Annotation rules update: <label>`, `# Proposed with the PDF-TEI-Editor by <user>`, `# Includes: ...`) (label and user name collapsed to one line, so they cannot add lines to the patch) precedes `diff --git a/<path> b/<path>` blocks (human file first, then machine file) with 3 lines of context, and `\ No newline at end of file` where the upstream file has no trailing newline. The file name is `<category-slug>-rules.patch`.
- **Errors**: 422 with a user message (different repositories, no layer selected, nothing to change, a heading anchor missing on the default branch); 502 when a file cannot be fetched or resolved, including the default branch (an adapter's `KeyError`/`NotImplementedError`/`ValueError` is raised as `RuleFetchError`).
- **Pull requests**: [github_pull_request.py](../../fastapi_app/lib/doc_rules/github_pull_request.py) `open_pull_request()` behind `POST /api/v1/document-rules/propose-pull-request` (the propose-patch fields plus `title`, `body` and `base_hashes`; response `url`, `number`, `branch`, `fork`). The propose-patch response carries `can_open_pull_request` (guide on GitHub), `pull_request_repository` (its `owner/repo`, else null; the dialog shows it above the title field), `pull_request_title` and `pull_request_body`, the dialog's defaults, and `base_hashes` (SHA-256 hex of each changed file's `before`, by path), which the dialog sends back unchanged. The token is the user's secret `github` (registered in the `lifespan` of `main.py`; 428 when missing, never logged or returned). Errors: 422 empty title or not a GitHub guide, 409 a file changed upstream, 422 token rejected or without access, 502 other GitHub errors or fork not ready; GitLab guides keep the patch only.
  - **Sequence**: the route rebuilds the proposal; if its set of paths or any hash of the rebuilt `before` differs from the request's `base_hashes` (the previewed state), it answers 409 without calling GitHub. `open_pull_request()` then validates `owner/repo` (also the fork's full name; `^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$`, no `.`/`..` segment, else 422 without a request); checks read access to the repository; resolves the head commit of the default branch (the base commit) and its tree; compares each file at the base commit (contents API with `Accept: application/vnd.github.raw+json`, raw body, no 1 MB limit; percent-encoded paths are decoded) with the previewed `before` (differs or gone → 409); uses the repository itself if the token has push access, else forks it (an existing fork is reused) and polls until it exists, up to 10 s; creates a tree with the files' contents inline (base tree = the base commit's tree), a commit with the base commit as parent and the ref `pdf-tei-editor/<slug>-<YYYYMMDD-HHMMSS>` (UTC) via the Git Data API, for a fork all three in the fork; opens the PR with `maintainer_can_modify`, head `<fork_owner>:<branch>` for a fork. If opening the PR fails, the branch is deleted again (best effort, errors ignored) and the original error is returned.
- **Frontend**: the `Propose upstream` sub-dialog ([document-rules.js](../../app/src/plugins/document-rules.js), template `document-rules-propose-dialog.html`) is opened by `_openProposeDialog()` for a pair and calls the route again whenever a checkbox changes, clearing the shown diffs while the request is pending. It warns when the editor shows unsaved changes of the shown layer (they are not in the patch, which uses the stored texts).
- **Upstream cleanup**: `POST /api/v1/document-rules/upstream-status` and `POST /api/v1/document-rules/remove-overrides-in-upstream`, both with `{ xml: <stable id>, url: <one of the document's refs> }` and the response `{ refs_behind, refresh_message, layers: [{ layer, url, error, in_upstream, kept }] }` (`in_upstream` and `kept` are the caller's override ids per layer; after a removal `in_upstream` holds the ids actually deleted). A `url` that is not among the document's refs gives 400 `This rule is not referenced by the document.`; read access to the document suffices, the role must be reviewer or admin. The status route compares with the section at the default branch head (it predicts what an update brings). The removal route recomputes the match server-side against the section at each layer's URL in the stored, re-pinned document (`InterpretationRefKind().resolve_original(layer.url)`), so only overrides whose text the document's pinned rules contain are removed (the caller's own only); a layer whose pinned section cannot be fetched gets an `error` and nothing of it is deleted. A failing deletion stops the removal and answers 502 naming how many overrides were deleted so far. The editor's `Update to upstream` ([document-rules.js](../../app/src/plugins/document-rules.js) `_onUpdateToUpstream()`) re-pins the document's refs via `refresh-resource`, then calls the removal route.

## Schema location

Declares the RelaxNG schema a document validates against. Two forms, in precedence order — an existing PI stays authoritative if a document somehow has both:

```xml
<?xml-model href="https://…/schema.rng" type="application/xml" schematypens="http://relaxng.org/ns/structure/1.0"?>
<TEI xmlns="http://www.tei-c.org/ns/1.0">
  <teiHeader>...</teiHeader>
```

or, the standard TEI element, inside `encodingDesc` (element order: `editorialDecl`, `schemaRef`, `appInfo`):

```xml
<encodingDesc>
  <editorialDecl>...</editorialDecl>
  <schemaRef target="https://…/schema.rng" type="RELAXNG"/>
  <appInfo>...</appInfo>
</encodingDesc>
```

- Write: this app only ever writes the `<?xml-model?>` PI — `_replace_schema_pi()` in [rules_refresh.py](../../fastapi_app/lib/doc_rules/rules_refresh.py), run by the "Refresh document rules" action (`POST /api/v1/document-rules/refresh/{preview,execute}`), text-level remove-then-insert immediately after the XML declaration (lxml's parse/serialize round-trip doesn't preserve a PI that precedes the root element). `schemaRef` is read-only support for documents produced elsewhere that use the plain TEI element instead of the PI; nothing in this app writes one.
- Read: `extract_schema_locations()` in [schema_validator.py](../../fastapi_app/lib/core/schema_validator.py) — checks the `<?xml-model?>` PI first (RelaxNG `schematypens` only in this function; XSD is handled separately via `xsi:schemaLocation` in the same function), falling back to `schemaRef/@target` only if no PI is present. Used by schema validation itself and by `rules_refresh.py`'s `_current_schema_location()` (to detect whether "Refresh document rules" needs to change anything).
- Document-rules registry: `SchemaKind.discover()` in [schema_kind.py](../../fastapi_app/lib/doc_rules/schema_kind.py) reports whichever form the document uses as one "schema" resource (see [2026-09-27-document-rules-registry-design.md](../superpowers/specs/2026-09-27-document-rules-registry-design.md)), editable the same way as an interpretation-ref resource via the "Edit document rules" submenu. In the XML editor, `buildRefDecorations()` in [document-rules-decorations.js](../../app/src/modules/document-rules-decorations.js) makes it clickable the same way as an editorialDecl `<ref target>`: the PI's `href` if present, else the `schemaRef`'s `target`, mirroring `extract_schema_locations()`'s own precedence.

## profileDesc/langUsage — document language

Every extraction result declares the language of the document as a BCP 47 code:

```xml
<profileDesc>
  <langUsage>
    <language ident="de"/>
  </langUsage>
</profileDesc>
```

- Write: the `/api/v1/extract` route calls `add_document_language()` in [language_detection.py](../../fastapi_app/lib/services/language_detection.py) on the output of every extractor, so extractor plugins do not need to handle it. It keeps a `langUsage` declaration the extractor already made, otherwise detects the language with py3langid from the text layer of the first pages of the PDF, falling back to the TEI `text` content. Only if the text is too short for a confident detection, `TEI/@xml:lang` or `text/@xml:lang` is used: GROBID declares `text/@xml:lang="en"` for German documents too, so it must not take precedence over detection. If no language can be determined (e.g. a scanned PDF without text layer), `und` (undetermined) is declared. The lookup order is implemented in `predict_document_language_with_source()`. The element is written by `set_document_language()` in `tei_utils.py`, which inserts `profileDesc` before `xenoData`/`revisionDesc`.
- Registry language: `parse_crossref_metadata()`/`parse_datacite_metadata()` in [doi_utils.py](../../fastapi_app/lib/utils/doi_utils.py) return the registry's `language` field (normalized by `normalize_language_code()`, language names such as "English" are dropped). `create_tei_header()` writes it, so during extraction it takes precedence over the extractor's declaration and the detection above. `update_biblstruct_in_tei()` (metadata-update job) overwrites the declared language with it; `enrich-tei-header.js` only fills it in when no language or `und` is declared.
- Backfill: the metadata-extraction plugin's collection backfill (`POST /api/plugins/metadata-extraction/backfill`, see the [plugin README](https://github.com/mpilhlt/pte-plugins/tree/main/plugins/metadata-extraction/src/pte_plugin_metadata_extraction/README.md)) declares a language where none or `und` is declared, using `predict_document_language_with_source()` (the same prediction path as `add_document_language()`) with the registry language from a DOI lookup ranked after text detection.

- Header editor: `TeiHeaderEditorPlugin` has a "Language" field (`FIELD_DEFS` key `language` in [tei-header-form.js](../../app/src/modules/tei-header-form.js)), the only field rooted at `teiHeader` instead of `fileDesc` and the only one whose value is an attribute (`@ident`). Clearing it removes the `language` element together with the `langUsage`/`profileDesc` wrappers it leaves empty.
- Read: `get_document_language()` in `tei_utils.py`.

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
- `_add_revision_change()` in `fastapi_app/lib/doc_rules/rules_refresh.py` — appended by "Refresh document rules"; has no `@status`.

Readers:

- `extract_tei_metadata()` — `status`/`last_revision`/`edition_title` from the **last** change only.
- `get_annotator_name()`, `buildRespStmtMap()` — `@who` resolution (see titleStmt section).
- Revision-history panel (`#showRevisionHistory()` in `tei-tools.js`) — reads **all** changes, not just the last.
- `edit_history`/`annotation_history` plugins — read-only reporting across a collection/document, both read-only consumers of the last change plus `extract_tei_metadata()`.

> **Known parallel signal:** `extract_tei_metadata()` also derives an `is_gold_standard` heuristic from `@status` being one of `gold`/`final`/`published`. This exists alongside a separate, explicit gold-standard flag in the DB (set via the "Save as Gold" action). The two can disagree; don't assume one implies the other.
