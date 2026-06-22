# Design: Configurable Document ID Creation (Issue #392)

## Overview

Add a config key `document.id.mode` that controls how `doc_id` is derived when a new PDF is uploaded. The `doc_id` is the stable identifier that links a PDF to its extracted TEI annotations and drives exported filenames.

**Scope:** New uploads only. Re-uploads of existing content keep their current `doc_id`.

---

## Architecture

The doc_id generation path during upload becomes:

```
upload_file() → resolve_doc_id(mode, filename, content, collection_id, repo) → doc_id
```

`resolve_doc_id` is extracted into a dedicated utility module, making it independently testable. The upload router reads the configured mode once per request and delegates; no other call sites change.

---

## Components

### 1. `fastapi_app/lib/utils/doc_id_utils.py` (new)

Single public function:

```python
def resolve_doc_id(
    mode: str,
    filename: str,
    content: bytes,
    file_type: str,
    collection_id: str | None = None,
    repo: FileRepository | None = None,
) -> str
```

**Mode behaviour:**

| Mode | Behaviour |
| --- | --- |
| `"filename"` | Strip extension; decode `__` → `/`; replace whitespace with `_`. No DOI extraction. |
| `"doi"` (default) | Same derivation as `"filename"`, then attempt `extract_doi_from_pdf(content)` for PDFs. DOI wins if found. |
| `"collection"` | Requires `collection_id`. Queries `repo` for `max(counter)` among `doc_id` values matching `{collection_id}-NNNN`; returns `{collection_id}-{N+1:04d}`. Falls back to `"doi"` if `collection_id` is absent. |
| `"uuid"` | Returns `str(uuid.uuid4())`. |
| unknown | Logs a warning; falls back to `"doi"`. |

The filename-to-label derivation (strip extension, decode `__`/single-underscore DOI prefix, replace whitespace) is extracted from the inline block in `files_upload.py` into a private helper `_derive_from_filename(filename: str) -> str` inside the same module.

### 2. `config/config.json` (modified)

Add the following keys:

```json
"document.id.mode": "doi",
"document.id.mode.description": "Strategy for generating document IDs on upload: filename | doi | collection | uuid",
"document.id.mode.type": "string",
"document.id.mode.values": ["filename", "doi", "collection", "uuid"]
```

### 3. `fastapi_app/routers/files_upload.py` (modified)

- Add `collection_id: str | None = Form(None)` to the `upload_file` signature.
- Replace the inline doc_id derivation block (lines 129–148) with:
  ```python
  from ..lib.utils.doc_id_utils import resolve_doc_id
  from ..lib.utils.config_utils import get_config

  mode = get_config().get('document.id.mode', default='doi')
  doc_id = resolve_doc_id(mode, file.filename, content, file_type, collection_id, repo)
  label = doc_id  # label mirrors doc_id as before
  ```
- `label` is kept as a mirror of `doc_id` (existing behaviour).

### 4. `tests/unit/fastapi/test_doc_id_utils.py` (new)

Unit tests covering:

- `"filename"` mode: whitespace → `_`, `__` → `/` decoding, no DOI side-effects
- `"doi"` mode: DOI present in PDF content wins over filename; fallback to filename when no DOI
- `"collection"` mode: zero-padded counter with 0 existing docs → `0001`; with N existing docs → `N+1`; fallback to `"doi"` when no `collection_id`
- `"uuid"` mode: result is a valid UUID4 string
- Unknown mode: returns same result as `"doi"` mode

---

## Error Handling

| Situation | Behaviour |
| --- | --- |
| Unknown `mode` value | Log warning; fall back to `"doi"` |
| `"collection"` mode, `collection_id` absent | Fall back to `"doi"` silently (debug log) |
| Counter query fails | Fall back to counter `1` |

---

## What Does Not Change

- Re-upload path (same content, new filename): existing `doc_id` may be updated via the existing filename-comparison logic — this is unchanged and not affected by the mode setting.
- The `doc_id` update endpoint (`PUT /api/v1/files/{stable_id}/doc-id`) is unchanged.
- Frontend call sites: the upload form can optionally pass `collection_id` as a form field; this is backward-compatible (field is optional).

---

## Documentation

Add a section to the user manual (`docs/user-manual/`) describing the `document.id.mode` config key and its four values.
