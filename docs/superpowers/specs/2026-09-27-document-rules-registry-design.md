# Document Rules Registry — Design

Status: draft for review. Date: 2026-09-27.

Visual concept (interactive mockup): [Document Rules Editor — concept](https://claude.ai/artifact/LUWtPTkDJgtS4vsdpdmUeq). Concept only — the real dialog uses Shoelace components and CodeMirror, not the mockup's plain HTML/CSS. Predates the terminology below: read "Variant" there as "Override".

## Terminology note

This spec uses **override** for "a user-owned, editable copy of a resource" (the thing the editing UI lets you create, select, and delete). It deliberately avoids "variant", which the app already uses for an extractor's document/model variant (`variant_id`, the `variant-id` label in `appInfo`, e.g. `"grobid.training.segmentation"`) — a document-level concept unrelated to this feature. Both terms appear in this spec; where a passage says "variant" it always means the existing extractor/document sense.

## Goal

Give users a workflow to override the rules that govern a document — both **validation rules** (the schema referenced by the document's `<?xml-model?>` PI or `schemaRef`) and **agent instructions** (the prompt/rule fragments referenced by `editorialDecl/interpretation`, consumed by extraction, review, or other processes that alter or control the PDF-TEI conversion). The **document is the source of truth**: only the resources a document actually references are visible or editable; there is no global catalogue.

The mechanism is deliberately generic and pluggable, so further ways of overriding document-linked resources can be added later without changing core: core defines a **resource-kind registry** that plugins (including core itself, for the two kinds this version ships) register into, plus one generic override/selection storage and REST layer shared by every kind. This spec covers that basic structure; extensions are listed under [Deferred](#deferred).

Workflow the design serves: (1) diagnose a problem in how a schema, an LLM annotator, or a reviewer applied a rule, (2) edit an override of the offending resource and re-run to see whether the outcome changes, (3) later, contribute the change upstream as a PR against the resource's source file.

## Current state

- `config/prompt.json` / `data/db/prompt.json`: list of `{label, extractor[], text[]}` instruction sets, served by `GET/POST /api/v1/config/instructions` ([config.py](../../../fastapi_app/api/config.py)).
- Frontend: [prompt-editor.js](../../../app/src/plugins/prompt-editor.js) (global dialog, `client.loadInstructions/saveInstructions`) and [extraction.js](../../../app/src/plugins/extraction.js) (instruction-set select; sends the text as `options.instructions`).
- llamore-extractor appends `options["instructions"]` to the upstream `LineByLinePrompter` user prompt ([extractor.py](../../../fastapi_app/plugins/llamore_extractor/extractor.py)).
- `encodingDesc/editorialDecl/interpretation` links a document to annotation-rule excerpts; see [tei-header-integrations.md](../../development/tei-header-integrations.md#encodingdeceditorialdecl-annotation-rules) for the current shape and [2026-09-22-editorial-decl-annotation-rules-design.md](2026-09-22-editorial-decl-annotation-rules-design.md) for its rationale. Rule excerpts are fetched via `UrlCache` and the git-forge adapters ([url_cache.py](../../../fastapi_app/lib/core/url_cache.py), [git_forge_adapters.py](../../../fastapi_app/lib/core/git_forge_adapters.py)).
- "Refresh Annotation Rules" is today a **GROBID-specific** backend-plugin endpoint: `GrobidPlugin.metadata["endpoints"]` declares it under `category: "grobid"` ([plugin.py](../../../fastapi_app/plugins/grobid/plugin.py)), so it shows up as a generic entry in the "Backend Plugins" toolbar dropdown ([backend-plugins.js](../../../app/src/plugins/backend-plugins.js), which groups all plugins' `get_endpoints()` entries by category). It follows a reviewer-confirmed preview-then-execute pattern (`outputUrl`/`executeUrl`, HTML confirmation page) and its logic — resolving the document's variant, regenerating `editorialDecl` entries from GROBID's own `AnnotationGuide` config, replacing the element, appending a `revisionDesc/change` — lives in [annotation_rules_refresh.py](../../../fastapi_app/plugins/grobid/annotation_rules_refresh.py), which imports GROBID's `build_editorial_decl_entries` directly. It does **not** touch the schema PI.
- The schema PI has its own, separate, manual refresh path: the `tei-wizard` "Add RNG Schema Definition" **enhancement** ([add-rng-schema-definition.js](../../../fastapi_app/plugins/tei_wizard/enhancements/add-rng-schema-definition.js)), a client-side transform a user runs explicitly. It reads a `.rng` ref from the document's own `appInfo/application[@type="extractor"]`, falling back to `config.get('schema.base-url') + '/' + state.variant + '.rng'`, removes any existing `xml-model`/`xsi:schemaLocation`/`_relaxng_schema` declaration, and inserts a fresh `xml-model` PI.
- `fastapi_app/lib/core/schema_validator.py` locates the document's schema (`extract_schema_locations`: `xml-model` PI, falling back to `schemaRef`; XSD via `xsi:schemaLocation`), downloads and caches it (its own `get_schema_cache_info`/`is_schema_cache_stale`/`download_schema_file`, thin wrappers kept for backward-compatible import names around the same logic `UrlCache` now generalizes), and validates against it (`validate()`).
- Each LLM/GROBID extractor plugin already has its own `get_schema_url(variant_id) -> str` (e.g. [grobid/config/\_\_init\_\_.py](../../../fastapi_app/plugins/grobid/config/__init__.py), [llamore_extractor/config.py](../../../fastapi_app/plugins/llamore_extractor/config.py)), both `f"{SCHEMA_BASE_URL}/{variant_id}.rng"`, called at extraction time together with `create_schema_processing_instruction()` ([tei_utils.py](../../../fastapi_app/lib/utils/tei_utils.py)) to write the initial PI.

## Concepts

### Document as source of truth

No registry keeps a catalogue of resources. A resource exists for the user only because the open document references it:

- each `ref/@target` under `editorialDecl/interpretation/p` (an **interpretation-ref** resource), or
- the document's schema location, from `schemaRef/@target` or the `<?xml-model?>` PI href (a **schema** resource).

Extractor plugins introduce interpretation-ref resources only at extraction time, writing them into the new document's `editorialDecl` (per the editorial-decl spec, Part B). A schema resource is written by `create_schema_processing_instruction()` at extraction time and is otherwise unrelated to any plugin. From then on, everything — including the list shown in the UI — is derived by reading the open document, never stored separately.

### Resource kind

The pluggable core abstraction. A kind knows how to find its resources in a document and how to fetch one's original text:

```python
class ResourceKind(ABC):
    name: str  # "interpretation-ref", "schema", ...

    def discover(self, xml_string: str) -> list[ResourceDescriptor]:
        """Find this kind's resources referenced by the document."""

    def resolve_original(self, url: str) -> str:
        """Fetch/read the resource's original text."""

@dataclass
class ResourceDescriptor:
    kind: str
    url: str            # exact URL as found in the document (may be SHA-pinned)
    key: str            # normalized resource key (see below)
    label: str          # human-readable label for the UI
    format: Literal["markdown", "text", "xml"]
```

`register_resource_kind(kind: ResourceKind)` is the one core entry point. Core registers `InterpretationRefKind` and `SchemaKind` (below) through this same call at startup — they are not special-cased — so a future plugin (e.g. one reading a `classDecl`/taxonomy resource) adds a third kind the same way, without touching the registry or the storage/REST layer.

### Resource key

Storage and selection use a normalized key per resource: the URL with the commit SHA path segment removed (`blob/<sha>/…` and `blob/main/…` map to the same key), any line range retained, using the existing git-forge adapters; URLs no adapter recognizes are used verbatim. A selection therefore applies to a resource regardless of which commit a document happens to pin. Storage and lookups are always scoped by `(kind, key)` — a coincidental key collision between two kinds is not possible.

### Original

The resource's text as found at its URL. Read-only.

- `InterpretationRefKind.resolve_original(url)`: fetched through `UrlCache` and the git-forge adapters (raw fetch, line range sliced). Content behind a SHA-pinned URL is immutable, so it is cached without expiry; unpinned URLs use the normal TTL. At extraction time the plugin supplies its shipped file's text, which is stored in that cache under the pinned URL, so documents stay resolvable offline and in development.
- `SchemaKind.resolve_original(url)`: delegates entirely to the existing `schema_validator` functions — `resolve_schema_location()`, then `get_schema_cache_info()`/`is_schema_cache_stale()`/`download_schema_file()` — and reads the resulting cache file. One fetch/cache implementation for schemas, reused rather than duplicated (see [Schema validation integration](#schema-validation-integration)).

### Override

A user-owned, editable copy of a resource with a free-text **note** describing what it changes. No title. In the UI overrides appear as "Original", "Override 1", "Override 2", … with the note as subtitle.

### Selection

Per user and `(kind, key)`: the original (nothing stored) or one of the user's overrides. Selecting an override is what "using" it means — for a schema resource, this is what `validate()` uses instead of the cached original (see below); for an interpretation-ref resource, this is what the consuming extractor or review call uses.

### Editable-portion rule

A resource contains only text that's safe to edit wholesale. Text that code parses or depends on (e.g. the JSON response contract of annotation review) stays in code, not in a resource. Prompts owned by an upstream dependency (llamore) cannot be edited; the extractor plugin instead contributes a separate "additional instructions" interpretation-ref, which may be empty or contain one generic sentence. The annotation-review system prompt is not editable in this version, since it isn't referenced by any document; only the annotation rules the document references are.

## Schema validation integration

Two ways to let a schema override affect validation were considered:

- **Replace**: move schema fetching onto the same generic mechanism used for interpretation-refs. Rejected — `schema_validator.py` already has tested, non-trivial logic for locating the schema (PI vs. `schemaRef` vs. `xsi:schemaLocation`), for XSD (`xmlschema.download_schemas`, which resolves includes/imports into several files), for per-schema validation timeouts, and for schema-location redirects (`register_schema_redirect`). Reimplementing this would duplicate all of it for no benefit, and would risk the two caches (the existing schema cache dir and a new generic one) drifting apart.
- **Integrate** (chosen): keep `schema_validator.py` untouched for locating, downloading, caching, and validating. Add one seam: `validate()` gains an optional parameter, `schema_text_override: dict[str, str] | None = None`, keyed by the resolved `schema_location`. When a caller supplies text for a location, `validate()` parses that text directly (`etree.fromstring`) instead of reading the on-disk schema cache file for that location — the shared cache other users' validation reads from is never touched by a per-user override. `schema_text_override=None` (the default) is byte-for-byte today's behavior. The `/validate` route builds the dict from `document_rules.get_selected_override_text("schema", location, user)` for each location the document declares, omitting any location with no selection.

**Scope**: v1 covers RelaxNG only, the only schema type actually in use by this app's documents. An XSD schema that expands into multiple included/imported files has no single "original text" to present as one editable resource — deferred (see [Deferred](#deferred)).

## Backend design

### Extraction-time contribution (interpretation-ref only)

Extractor plugins ship their editable prompt text as markdown files in the plugin (`prompts/*.md`) and pass descriptors when they extract:

```python
fragments = doc_rules.for_extraction(
    user,
    [ExtractionFragment(
        url="https://github.com/mpilhlt/pdf-tei-editor/blob/main/fastapi_app/plugins/llamore_extractor/prompts/additional-instructions.md",
        file=plugin_dir / "prompts/additional-instructions.md",
        label="Reference extraction instructions",
    )],
)
# fragments: list[ResolvedFragment(url_pinned, label, text)]
```

`for_extraction` returns, per descriptor, the text to use (the user's selected override if any, else the shipped file), and the pinned URL and label that the extractor hands to the `editorialDecl` generation (which also writes the `@n` label, see below). It seeds the cache as described under Original. Schema resources are not extraction-time-contributed in this sense — the schema location is fixed per app version and written by `create_schema_processing_instruction()` independently of this mechanism.

### Registry (`fastapi_app/lib/doc_rules/`)

Two layers: the kind registry (above) and the sync storage/resolution API (matching the existing sqlite helpers):

| Method | Behaviour |
| --- | --- |
| `register_resource_kind(kind)` | called once per kind, by core at startup for the two built-in kinds |
| `list_resources(xml_string)` | concatenates every registered kind's `discover(xml_string)` |
| `for_extraction(user, descriptors)` | interpretation-ref only; see above |
| `get(kind, url, user=None)` | text to use: the user's selected override for `(kind, key)` if any, else `kind.resolve_original(url)` |
| `get_selected_override_text(kind, url, user)` | the selected override's text only, or `None` if the resource uses the original — used by `validate()`'s override dict, so an unselected resource costs it nothing beyond the existing download/cache path |
| `query(kind, url, user)` | original text, the user's overrides, current selection (used by the REST API) |
| override CRUD, `select`, `reset(resources, user)` | see REST API |

### Consumers

- Extractors (llamore-extractor first): resolve their fragments with `for_extraction`; `options["instructions"]` and the instruction-set list in `extraction.js` are removed. llamore adds `prompts/additional-instructions.md` (the former "Default instructions" text for llamore-gemini); other sets from `config/prompt.json` get a fragment file only if their plugin consumes them (verified during planning).
- Annotation review: rule excerpts are resolved with `doc_rules.get("interpretation-ref", rule_url, user)` instead of a raw URL fetch. Its system prompt stays in code.
- `/validate` route: builds `schema_text_override` from `get_selected_override_text("schema", …)` per schema location and passes it to `validate()`.

### Refreshing document rules (generalized from GROBID; also replaces the schema-PI enhancement)

"Refresh Annotation Rules" moves out of GROBID's plugin-specific "Backend Plugins" dropdown entry (`category: "grobid"`) and becomes a core action, **"Refresh document rules"**, in the "Inference tools" menu alongside "Edit prompts/schemas". It is widened to regenerate **both** halves of what governs a document: the interpretation-ref entries (today's GROBID-only behavior) **and** the schema PI (today's separate, manual `tei-wizard` "Add RNG Schema Definition" enhancement). One action, one confirmation, both parts brought current.

**Tracing a resource back to its contributing plugin.** Neither half is recorded per-resource — `editorialDecl/interpretation` doesn't say which plugin wrote it, and the schema PI is just a URL. Provenance instead comes from the one thing every extracted document already carries: `encodingDesc/appInfo/application[@type="extractor"]/@ident` plus its `label[@type="variant-id"]` (see [tei-header-integrations.md](../../development/tei-header-integrations.md#encodingdescappinfoapplication--extractor-provenance)) — **all** of a document's interpretation-ref entries and its schema PI were produced by the one extractor that ran at extraction time, so this single document-level fact is enough to dispatch refresh to the right plugin. It is not a general answer to "which plugin owns this one resource" if a document ever gains resources from more than one contributor (not possible today) — noted under [Deferred](#deferred) as a limit, not solved further here. `@ident` is the lookup key (confirmed; a plugin renaming its own `@ident` across versions is an acceptable, self-inflicted breakage, same as it would be for any other reader of that field).

A small new registry, `fastapi_app/lib/doc_rules/rules_providers.py`:

```python
class DocumentRulesProvider(Protocol):
    def build_editorial_decl_entries(self, variant_id: str, cache: UrlCache) -> list[AnnotationRuleRef]:
        """Current interpretation-ref entries for variant_id. Return [] if this extractor has none."""

    def get_schema_url(self, variant_id: str) -> str | None:
        """Current schema URL for variant_id, or None if this extractor has no schema mapping."""

def register_document_rules_provider(extractor_ident: str, plugin_id: str, provider: DocumentRulesProvider) -> None: ...
def get_document_rules_provider_for_document(xml_string: str) -> tuple[str, DocumentRulesProvider] | None:
    """Reads the document's extractor @ident and variant-id; looks up a registered provider."""
```

`GrobidPlugin.initialize()` calls `register_document_rules_provider("GROBID", "grobid", self)`; its `build_editorial_decl_entries` delegates to the existing `annotation_rules.build_editorial_decl_entries()`, its `get_schema_url` to the existing `grobid/config.get_schema_url()` — no change to either's own logic, only to how they're discovered and driven. llamore-extractor registers the same way, delegating to its own `llamore_extractor/config.get_schema_url()` (it has no `AnnotationGuide`-style config yet, so `build_editorial_decl_entries` returns `[]` until it does). A plugin that doesn't register at all simply has nothing to refresh; the action reports "No rule-refresh provider for this document's extractor" rather than erroring.

**Precondition — works on legacy documents.** Resolving a target requires only `appInfo/application[@type="extractor"]` with a readable `@ident` and `variant-id` — **not** an existing `editorialDecl`. A document extracted before either `editorialDecl` or this feature existed still has that `appInfo` block (it's the oldest, most stable provenance record in the header — see [tei-header-integrations.md](../../development/tei-header-integrations.md)), so refresh works on it unchanged: it gains a freshly generated `editorialDecl` (if the provider returns entries) and/or a corrected schema PI (replacing whatever it has, if anything — mirroring the enhancement's remove-then-insert), exactly as if it had just been re-extracted.

The orchestration itself — `resolve_refresh_target`, `_replace_editorial_decl`, a new `_replace_schema_pi` (the same remove-then-insert `add-rng-schema-definition.js` already does, ported server-side using `create_schema_processing_instruction()`), `_add_revision_change`, the changed/unchanged comparison — moves from `fastapi_app/plugins/grobid/annotation_rules_refresh.py` to a core module (e.g. `fastapi_app/lib/doc_rules/rules_refresh.py`), with its one GROBID-specific import replaced by `get_document_rules_provider_for_document()`. The reviewer-confirmed preview-then-execute HTTP flow moves with it, onto the same router as the rest of this spec's REST API: `POST /api/v1/document-rules/refresh/preview` and `POST /api/v1/document-rules/refresh/execute`, both `{xml: stable_id}`, both requiring the `reviewer`/`admin` role — same shape as today's `/api/plugins/grobid/refresh-annotation-rules/{preview,execute}`, just no longer plugin-owned and now covering the schema PI too. GROBID's `metadata["endpoints"]` entry and its two grobid-scoped routes are removed once the core action replaces them.

The `tei-wizard` "Add RNG Schema Definition" enhancement is **obsolete** and removed: "Refresh document rules" supersedes it (server-side, reviewer-confirmed, and bundled with the rules refresh rather than a separate manual step), and its config-fallback branch (`schema.base-url` + `state.variant`) is no longer needed once `get_schema_url()` is reached through the registered provider instead.

### Storage

Two tables in `data/db/metadata.db`, created by a migration in `fastapi_app/lib/core/migrations/versions/`:

```sql
CREATE TABLE resource_overrides (
    id TEXT PRIMARY KEY,           -- uuid
    kind TEXT NOT NULL,            -- "interpretation-ref" | "schema" | ...
    resource_key TEXT NOT NULL,
    owner TEXT NOT NULL,           -- username
    note TEXT NOT NULL DEFAULT '',
    text TEXT NOT NULL,
    format TEXT NOT NULL,          -- "markdown" | "text" | "xml"
    base_url TEXT NOT NULL,        -- exact URL incl. SHA and line range the override was created from
    base_hash TEXT NOT NULL,       -- sha256 of the original text at creation
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX idx_resource_overrides_owner_key ON resource_overrides (owner, kind, resource_key);

CREATE TABLE resource_selection (
    owner TEXT NOT NULL,
    kind TEXT NOT NULL,
    resource_key TEXT NOT NULL,
    override_id TEXT NOT NULL REFERENCES resource_overrides (id) ON DELETE CASCADE,
    PRIMARY KEY (owner, kind, resource_key)
);
```

`base_url` and `base_hash` are only stored in this version; they enable the deferred "upstream changed" notice and PR creation. Follow [database-connections.md](../../code-assistant/database-connections.md). Both tables are fully generic — neither references "prompt" or "schema" — so a future kind needs no schema change.

### REST API

Router `/api/v1/document-rules`, authenticated; write endpoints only touch the caller's own rows.

| Endpoint | Purpose |
| --- | --- |
| `POST /list` | `{xml: string}` → `[{kind, url, key, label, format}]`, from `list_resources()` against the posted (possibly unsaved) document content — same pattern as the existing `/validate` endpoint. Used to build the submenu. |
| `POST /query` | `{kind, url}` → original text, caller's overrides (id, note, text, created_at), selected override id or `null`. Used when one resource's editor is opened. |
| `POST /overrides` | `{kind, fragment_url, note, text?}`; text defaults to the original; fills `base_url`/`base_hash`/`format` |
| `PUT /overrides/{id}` | update note and text (owner only) |
| `DELETE /overrides/{id}` | owner only; clears a selection pointing at it |
| `PUT /selection` | `{kind, fragment_url, override_id: string \| null}` (`null` = original) |
| `POST /selection/reset` | `{resources: [{kind, url}, ...]}` → clears the caller's selections for these; overrides are kept |
| `POST /refresh/preview` | `{xml: stable_id}` → confirmation page URL (reviewer/admin); see [Refreshing document rules](#refreshing-document-rules-generalized-from-grobid-also-replaces-the-schema-pi-enhancement) |
| `POST /refresh/execute` | `{xml: stable_id}` → performs the refresh (reviewer/admin) |

Removed: `GET/POST /api/v1/config/instructions`, `InstructionItem`, `config/prompt.json`, `data/db/prompt.json` handling. `api-client-v1.js` is regenerated.

## `interpretation/@n` — category label

`interpretation`'s content model is `oneOrMore(p|ab)` only (per `schema/rng/tei-bib.rng`); a `desc` child is **not legal**. The label shown for a category instead uses `@n`, from TEI's generic `att.global.attribute.n` (a standard "alternative name" attribute, legal on any element with global attributes). Extractor plugins that write `editorialDecl` entries add `n="<short title>"` alongside the existing `type="<category>"` (e.g. `n="Data correction"` next to `type="data-correction"`). It is optional and purely presentational: readers fall back to `@type` when absent (documents written before this addition). Updated: `docs/development/example.tei.xml` (both `interpretation` elements) and `docs/development/tei-header-integrations.md` (Shape section). See the addendum note added to [2026-09-22-editorial-decl-annotation-rules-design.md](2026-09-22-editorial-decl-annotation-rules-design.md).

## Frontend design

The `prompt-editor` plugin is rewritten and renamed in its menu entry: **"Edit prompts/schemas"**, in the "Inference tools" menu, enabled only when `list_resources()` on the open document returns at least one resource. It is now a **dynamically generated submenu**, one entry per resource:

- one entry per `editorialDecl/interpretation` (label = `@n`, falling back to `@type`), and
- one entry for the document's schema, if present (label: `"Schema (<type>)"`, e.g. `"Schema (RelaxNG)"`).

Clicking an entry opens the editor for **only that one resource** — not a dialog covering every resource at once. The editor's shell (header, override row, footer) is shared; the body swaps by `format`:

- `markdown`/`text`: an `Edit` tab (plain textarea) and a `Preview` tab (existing `markdown-it`, styled with the existing `github-markdown*.css`).
- `xml`: a CodeMirror instance (existing `@codemirror/lang-xml`, already a dependency), read-only when "Original" is selected, editable for an override.

Shared controls, per the [visual concept](https://claude.ai/artifact/LUWtPTkDJgtS4vsdpdmUeq) (predates this terminology; read its "Variant" as "Override"):

- an override row ("Original", "Override 1", …); clicking one **uses it immediately** (sets the selection) and shows a toast naming what's now selected and for which resource;
- a note field, editable for an override, hidden for the original;
- "New override" (copies the text currently shown into a new override and selects it), Save, Delete override;
- "Reset to original" (confirmed first: "This will reload the resource from its origin and remove all overrides.") re-fetches the resource's current original text and **permanently deletes every one of the caller's overrides for it** - not just clearing the selection, as an earlier revision of this design did. Selecting "Original" from the row above remains the non-destructive way to switch away from an override without deleting it. Rationale: the use case is an override whose change was proposed upstream (see the propose-upstream-change addendum spec) and accepted there, making the override stale/redundant against the new upstream content.

No new dependencies. Element typedefs in `app/src/ui.js`, templates in `app/src/templates/`, JSDoc per project rules. The document-resource discovery used to build the submenu is a backend call (`POST /list`), not a second, separate frontend parser — consistent with how `/validate` already extracts schema locations server-side. The extraction dialog's former instruction-set select is removed; the user's stored selections apply automatically at extraction.

A second, plain (non-dynamic) item, **"Refresh document rules"**, sits next to "Edit prompts/schemas" in the same "Inference tools" menu, visible to `reviewer`/`admin` only. It calls `POST /api/v1/document-rules/refresh/preview` and, on confirmation, `.../execute` — the same preview-then-execute confirmation page pattern GROBID's action already uses, just reached from this menu, covering both the interpretation-ref entries and the schema PI, and no longer requiring a document to already have an `editorialDecl`. GROBID's `refresh_annotation_rules` entry is removed from `metadata["endpoints"]` (so it no longer appears in the "Backend Plugins" dropdown), and the `tei-wizard` "Add RNG Schema Definition" enhancement is deleted from its enhancements list.

## Testing

- Backend unit: kind registration and `list_resources` concatenation, key normalization, selection resolution and fallback after delete, `for_extraction` (cache seeding, pinned URL, label), `query` with unresolvable URLs (mocked `UrlCache`), storage CRUD and cascade, API auth and ownership, reset keeps overrides, `validate()`'s `schema_text_override` seam (override used when present, existing cache path used when absent, shared cache file never written by an override).
- Consumer tests: llamore additional-instructions resolution; annotation-review rule excerpts via the registry; `/validate` route building the override dict; adjust existing prompt tests.
- Rules-provider tests: `register_document_rules_provider`/`get_document_rules_provider_for_document` (ident lookup, unregistered ident → `None`); relocated refresh unit tests (moved from GROBID's `test_annotation_rules_refresh.py`/`test_annotation_rules_refresh_routes.py`, GROBID's provider registration exercised as one concrete case, not the only case the core logic is tested against); schema-PI regeneration on a document with no PI at all (legacy) and on one with a stale PI; a document whose extractor has no registered provider reports the no-op message rather than erroring.
- Frontend unit for the dialog logic (override switching, format-based body swap); E2E: open a document with an `editorialDecl` and a schema, open the submenu, create and select an override of each kind, reset; "Refresh document rules" preview/execute from the Inference tools menu, including on a legacy fixture document with `appInfo` but no `editorialDecl`. Run the full suite (`npm run test:unit`, `npm run test:e2e`) before finishing.
- UI check with `scripts/dev/ui-screenshot.js`.

## Migration

None. Defaults from `config/prompt.json` become shipped fragment files in the consuming plugins; custom entries in existing `data/db/prompt.json` are dropped. Both JSON files and their handling code are deleted. Documents extracted before this feature have no interpretation-ref resources in their `editorialDecl` and offer nothing to edit there until re-extracted; their schema resource is unaffected (schema location has always been present) and is editable immediately, and can be brought current with "Refresh document rules" regardless (see the precondition note above). `fastapi_app/plugins/grobid/annotation_rules_refresh.py` and its two grobid-scoped routes are deleted once the core `rules_refresh.py`/`/api/v1/document-rules/refresh/*` replacement lands; GROBID keeps only its `DocumentRulesProvider` registration and its existing `annotation_rules.build_editorial_decl_entries()`/`config.get_schema_url()`. `fastapi_app/plugins/tei_wizard/enhancements/add-rng-schema-definition.js` is deleted.

## Deferred

- PR creation from an override to the source repo — now designed in [2026-09-28-document-rules-propose-upstream-design.md](2026-09-28-document-rules-propose-upstream-design.md) — and the "upstream changed" notice and diff (data stored: `base_url`, `base_hash`), still deferred.
- Recording in the document which override was applied at extraction or at validation. Until then a document may cite the original URL although an override was used; the note is the only trace, and only in the DB.
- XSD schema resources (multi-file, via `xmlschema` includes/imports) — RelaxNG only in v1.
- Per-run override selection (outside the stored selection).
- Sharing overrides between users, admin-defined defaults.
- Making tool-internal prompts (e.g. the review system prompt) editable.
- Refresh policy for unpinned remote resources beyond the existing `UrlCache` TTL.
- Additional resource kinds (e.g. `classDecl`/taxonomy) — the registry is built to accept them without further core changes.
- Per-resource plugin provenance. `get_document_rules_provider_for_document` traces the whole document to one extractor `@ident`; it cannot say which plugin contributed one specific `interpretation` entry (or the schema PI) if a document ever gains resources from more than one contributor (not possible today — only the one extractor that ran writes any). Recording provenance on the resource itself (e.g. an attribute on `interpretation`) would be the fix, deferred until something actually needs it.
- Refresh for kinds other than interpretation-ref/schema, if a future kind turns out to need regenerating rather than just editing.

## Open points for planning

- Which sets from `config/prompt.json` are actually consumed by a plugin.
- Exact `label` wording for the schema submenu entry per schema type (RelaxNG only in v1, so likely just `"Schema (RelaxNG)"`).
