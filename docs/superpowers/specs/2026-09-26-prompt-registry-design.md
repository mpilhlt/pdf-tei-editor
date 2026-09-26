# Prompt Registry — Design

Status: draft for review. Date: 2026-09-26.

## Goal

Replace the global `prompt.json` instruction sets with a core **prompt registry**. Plugins contribute prompt fragments identified by their source URL; consumers request a fragment from the registry and receive either the original or the user's edited copy. A frontend plugin provides the editing UX. This spec covers the basic structure only; extensions are listed under [Deferred](#deferred).

Motivation: prompts are consumed by plugins, so they should be contributed by them. Today they live in `config/prompt.json` (defaults) and `data/db/prompt.json` (custom), edited through a global dialog and unrelated to the code that uses them.

Intended workflow the design must support: (1) a problem is observed in how an LLM annotator/reviewer applies a rule or prompt, (2) the user edits a copy and re-runs to see whether the outcome changes, (3) if it does, the change is later proposed upstream as a PR against the source file (deferred, but the data model supports it).

## Current state

- `config/prompt.json` / `data/db/prompt.json`: list of `{label, extractor[], text[]}` instruction sets, served by `GET/POST /api/v1/config/instructions` ([config.py](../../../fastapi_app/api/config.py)).
- Frontend: [prompt-editor.js](../../../app/src/plugins/prompt-editor.js) (dialog, uses `client.loadInstructions/saveInstructions`) and [extraction.js](../../../app/src/plugins/extraction.js) (instruction-set select in the extraction options dialog; sends the selected text as `options.instructions`).
- llamore-extractor appends `options["instructions"]` to the upstream `LineByLinePrompter` user prompt ([extractor.py](../../../fastapi_app/plugins/llamore_extractor/extractor.py)).
- annotation-review builds its system prompt inline in code ([prompts.py](../../../fastapi_app/plugins/annotation_review/prompts.py)).
- Rule excerpts for review are fetched from `editorialDecl/interpretation/p/ref/@target` URLs via `UrlCache` and the git-forge adapters ([url_cache.py](../../../fastapi_app/lib/core/url_cache.py), [git_forge_adapters.py](../../../fastapi_app/lib/core/git_forge_adapters.py); see [editorial-decl spec](2026-09-22-editorial-decl-annotation-rules-design.md)).

## Concepts

### Fragment

A markdown or plaintext piece of prompt text, identified by its **source URL**, optionally with a `#L{first}-L{last}` line range. The URL is canonical, for example `https://github.com/mpilhlt/pdf-tei-editor/blob/main/fastapi_app/plugins/annotation_review/prompts/system.md`. The line range is part of the identity, so two ranges of one file are two fragments.

**Fragment key** (used for storage and selection): the URL with the commit SHA path segment normalized away (`blob/<sha>/…` and `blob/main/…` map to the same key), the line range retained. Normalization is implemented on top of the existing git-forge adapters; URLs no adapter recognizes are used verbatim.

Fragments have two sources:

| Source | Contributed by | Text read from |
| --- | --- | --- |
| local | plugin metadata, at registration | file inside the plugin directory |
| remote | on-demand, on first `get(url)` | the URL, via `UrlCache` and git-forge adapter (line range sliced) |

Remote fragments are how rule URLs found in documents' `editorialDecl` become editable: the first request for such a URL registers it (title defaults to the URL) and it then appears in the editor.

A commit-pinned URL (`blob/<sha>/…`) is fetched exactly as pinned when the original is requested. Selections apply by fragment key, so a user's copy applies regardless of the commit a document pins.

### Variant

Either the **original** (the fragment's own text, read-only, always available) or a **copy**: a user-owned, editable text with a short `title` and a `description` of the modifications.

### Selection

Per user and fragment key: the original (no selection stored) or one of the user's copies.

### Editable-portion rule

A fragment contains only text that is safe to edit. Text that code depends on (e.g. the JSON response contract that `parse_and_validate_findings` parses) stays in code or in a separate fragment that the plugin does not contribute. Dynamic assembly (e.g. `build_user_prompt`) stays in code. Prompts from an upstream dependency (llamore) cannot be edited; the plugin instead contributes an "additional instructions" file, which may be empty or contain a single generic sentence, and appends it in its own code.

## Backend design

### Contribution

A plugin declares fragments in its metadata (declarative, like `dependencies`):

```python
"prompts": [
    {
        "url": "https://github.com/mpilhlt/pdf-tei-editor/blob/main/fastapi_app/plugins/annotation_review/prompts/system.md",
        "file": "prompts/system.md",
        "title": "Annotation review: system prompt",
        "description": "Task description for the review LLM call.",
    }
]
```

- `file` is relative to the plugin directory; it must exist, otherwise registration of that fragment fails with a logged error (the plugin still loads).
- Declarative rather than a call in `initialize()`, so that plugin enable/disable (see [plugin-management spec](2026-09-26-plugin-management-design.md)) can hide and show fragments without running plugin code. Fragments of a disabled plugin are not listed or resolved; their copies are kept.
- Duplicate fragment keys across plugins are a registration error (first wins, logged).
- Fragments are shipped as `.md` files in the plugin's `prompts/` directory.

### Registry (`fastapi_app/lib/prompts/`)

Sync API (matching the existing sqlite helpers):

| Method | Behaviour |
| --- | --- |
| `register_plugin(plugin_id, plugin_dir, fragments)` / `unregister_plugin(plugin_id)` | called by the plugin manager during registration and on soft toggle |
| `list_fragments()` | fragment metadata (`key`, `url`, `title`, `description`, `plugin_id`, `source`) |
| `get_original(url)` | original text; local files read on each call, cached by mtime; remote via `UrlCache` |
| `list_variants(url, user)` | `[original, *user's copies]` |
| `get(url, user=None, variant_id=None)` | resolution order below |

Resolution order for `get`:

1. `variant_id` given (per-run override): it must be a copy owned by `user` and belong to the fragment key, otherwise `PermissionError`/`ValueError`. Returns its text.
2. `user` given and a selection exists for the fragment key and the copy still exists: its text.
3. The original. (Also the result when `user` is `None`.)

Unknown remote URLs are registered on first `get`/`get_original`; a fetch failure raises and is not registered.

### Consumers

- annotation-review: the editable system-prompt part moves to `prompts/system.md` and is loaded with `registry.get(URL, user)`. Rule excerpts fetched for review are resolved through `registry.get(rule_url, user, variant_id)` instead of a raw URL fetch. `prompt_variants` from the request is passed through.
- llamore-extractor: adds `prompts/additional-instructions.md` (the former "Default instructions" text for llamore-gemini), resolved with `registry.get`, then appended as it currently appends `options["instructions"]`. `options["instructions"]` and the instructions list in `extraction.js` are removed.
- Other LLM extractors (`gemini-pro`, `claude-sonnet`, `kisski-neural-chat` sets in `config/prompt.json`) follow the same pattern in their plugins if they consume the text; unconsumed sets are dropped (verified during planning).

### Storage

Two tables in `data/db/metadata.db`, created by a migration in `fastapi_app/lib/core/migrations/versions/`:

```sql
CREATE TABLE prompt_variants (
    id TEXT PRIMARY KEY,           -- uuid
    fragment_key TEXT NOT NULL,
    owner TEXT NOT NULL,           -- username
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    text TEXT NOT NULL,
    base_url TEXT NOT NULL,        -- exact URL incl. SHA and line range the copy was made from
    base_hash TEXT NOT NULL,       -- sha256 of the original text at copy time
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX idx_prompt_variants_owner_key ON prompt_variants (owner, fragment_key);

CREATE TABLE prompt_selection (
    owner TEXT NOT NULL,
    fragment_key TEXT NOT NULL,
    variant_id TEXT NOT NULL REFERENCES prompt_variants (id) ON DELETE CASCADE,
    PRIMARY KEY (owner, fragment_key)
);
```

`base_url` and `base_hash` are unused in this version except being stored; they enable the deferred "upstream changed" notice and PR creation. Follow the connection/transaction rules in [database-connections.md](../../code-assistant/database-connections.md).

### REST API

Router `/api/v1/prompts`, all endpoints require an authenticated user; write endpoints only touch the caller's own rows.

| Endpoint | Purpose |
| --- | --- |
| `GET /fragments` | fragments with the caller's variants (id, title, description) and selection |
| `GET /fragments/text?url=` | original text of a fragment |
| `POST /variants` | `{fragment_url, title, description, text?}`; text defaults to the original; fills `base_url`/`base_hash` |
| `PUT /variants/{id}` | update title, description, text (owner only) |
| `DELETE /variants/{id}` | owner only; clears a selection pointing at it |
| `PUT /selection` | `{fragment_url, variant_id: string \| null}` (`null` = use original) |

Per-run overrides: extraction and review requests accept `prompt_variants: {fragment_url: variant_id}` and pass it to `registry.get`. Removed: `GET/POST /api/v1/config/instructions`, `InstructionItem`, `config/prompt.json`, `data/db/prompt.json` handling. `api-client-v1.js` is regenerated.

## Frontend design

The `prompt-editor` plugin is rewritten; same "Inference tools" menu entry, still visible only when an inference provider is configured.

Dialog:

- **Fragment picker**: `sl-select`, options grouped by contributing plugin, showing title; the description is shown beneath.
- **Variant picker**: "Original (read-only)" plus the user's copies with title and description; a marker on the variant currently in use.
- **Make a copy**: prompts for title and description (the description explains the modification), creates the copy from the current variant's text, selects it in the dialog.
- **Editor**: `Edit` tab (plain textarea) and `Preview` tab (rendered with the existing `markdown-it`, styled by the existing `github-markdown*.css`). Read-only for the original. No new dependencies.
- **Actions**: Save, "Use this variant" (sets selection), "Use original" (clears selection), Delete copy.

Extraction dialog: the instruction-set select becomes a select of `list_variants` for the extractor's fragment. The extractor declares the fragment URL in its `get_info()` (new optional field `prompt_fragment`); the dialog sends the chosen variant as `prompt_variants`. Default preselection is the user's stored selection.

UI conventions: element typedefs in `app/src/ui.js`, templates in `app/src/templates/`, JSDoc per project rules; storage of transient UI state via UIStorage where needed.

## Testing

- Backend unit: registry (register/unregister, key normalization, resolution order, foreign-variant rejection, fallback after delete, on-demand remote registration with mocked `UrlCache`), storage CRUD and cascade, API auth and ownership.
- Consumer tests: annotation-review prompt loading from the fragment file; llamore additional-instructions resolution; existing `test_prompts.py` adjusted.
- Frontend unit for the dialog logic; E2E: create copy, edit, select, run extraction option list shows the variant. Run the full suite (`npm run test:unit`, `npm run test:e2e`) before finishing.
- UI check with `scripts/dev/ui-screenshot.js`.

## Migration

None. The defaults in `config/prompt.json` are re-created as shipped fragment files in the consuming plugins; custom entries in existing `data/db/prompt.json` files are dropped. Both JSON files and their handling code are deleted.

## Deferred

- PR creation from a copy to the source repo, and the "upstream changed" notice/diff (data is stored: `base_url`, `base_hash`).
- Sharing copies between users, admin-defined defaults.
- Tags / filtering.
- Cache/refresh policy for remote fragments beyond the existing `UrlCache` TTL.
- Per-run variant override UI in annotation-review.

## Open points to resolve during planning

- Exact home of the `prompt_fragment` field in extractor `get_info()` and how `extraction.js` maps it.
- Which of the `config/prompt.json` sets are actually consumed by a plugin (only those get a fragment file).
- Line-range fragments of local files: supported by the identity scheme; whether any shipped plugin needs them in v1 (none planned).
