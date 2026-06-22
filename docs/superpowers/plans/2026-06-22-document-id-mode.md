# Document ID Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `document.id.mode` config key controlling how `doc_id` is derived for newly uploaded PDFs, with four modes: `filename`, `doi` (default/current), `collection`, and `uuid`.

**Architecture:** Extract doc_id generation from `files_upload.py` into a new `doc_id_utils.py` utility module. Add `get_max_collection_counter` to `FileRepository` for the `collection` mode counter. Wire the upload router to read the config key and delegate to the utility. New uploads only — re-uploads are unaffected.

**Tech Stack:** Python 3.11, FastAPI, SQLite (via `FileRepository`), `unittest` + `unittest.mock`, `uv run python`

**Spec:** `docs/superpowers/specs/2026-06-22-document-id-mode-design.md`

---

## File Map

| Action | Path | Responsibility |
| --- | --- | --- |
| Create | `fastapi_app/lib/utils/doc_id_utils.py` | `resolve_doc_id()` and private helpers |
| Modify | `fastapi_app/lib/repository/file_repository.py` | Add `get_max_collection_counter()` + `import re` |
| Modify | `fastapi_app/routers/files_upload.py` | Add `collection_id` Form param, use `resolve_doc_id` |
| Modify | `config/config.json` | Add `document.id.mode` key |
| Create | `tests/unit/fastapi/test_doc_id_utils.py` | Unit tests for both `get_max_collection_counter` and `resolve_doc_id` |
| Modify | `docs/user-manual/app-config.md` | Document the four modes |

---

## Task 1: Add `get_max_collection_counter` to `FileRepository`

**Files:**
- Modify: `fastapi_app/lib/repository/file_repository.py`
- Test: `tests/unit/fastapi/test_doc_id_utils.py` (create)

- [ ] **Step 1.1: Write the failing test**

Create `tests/unit/fastapi/test_doc_id_utils.py`:

```python
"""
Unit tests for doc_id_utils and the FileRepository counter method it depends on.

@testCovers fastapi_app/lib/utils/doc_id_utils.py
@testCovers fastapi_app/lib/repository/file_repository.py
"""
import shutil
import tempfile
import unittest
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).parent.parent.parent.parent))

from fastapi_app.lib.core.database import DatabaseManager
from fastapi_app.lib.repository.file_repository import FileRepository
from fastapi_app.lib.models.models import FileCreate


class TestGetMaxCollectionCounter(unittest.TestCase):
    """Test FileRepository.get_max_collection_counter."""

    def setUp(self):
        self.test_dir = Path(tempfile.mkdtemp())
        self.db = DatabaseManager(self.test_dir / "test.db")
        self.repo = FileRepository(self.db)

    def tearDown(self):
        import gc
        gc.collect()
        shutil.rmtree(self.test_dir)

    def _insert(self, file_id: str, doc_id: str) -> None:
        self.repo.insert_file(FileCreate(
            id=file_id, filename=f"{file_id}.pdf",
            doc_id=doc_id, file_type='pdf', file_size=100
        ))

    def test_returns_zero_when_no_files(self):
        """Returns 0 when no files match the prefix."""
        self.assertEqual(self.repo.get_max_collection_counter("mycol"), 0)

    def test_returns_max_of_multiple_entries(self):
        """Returns the highest numeric suffix."""
        self._insert("f1", "mycol-0001")
        self._insert("f2", "mycol-0003")
        self._insert("f3", "mycol-0002")
        self.assertEqual(self.repo.get_max_collection_counter("mycol"), 3)

    def test_ignores_different_prefix(self):
        """Does not count files with a different prefix."""
        self._insert("f1", "other-0005")
        self.assertEqual(self.repo.get_max_collection_counter("mycol"), 0)

    def test_ignores_non_numeric_suffixes(self):
        """Files whose suffix is not all digits are not counted."""
        self._insert("f1", "mycol-0001")
        self._insert("f2", "mycol-extra")
        self.assertEqual(self.repo.get_max_collection_counter("mycol"), 1)
```

- [ ] **Step 1.2: Run test to verify it fails**

```bash
uv run python tests/unit-test-runner.py tests/unit/fastapi/test_doc_id_utils.py -v
```

Expected: `AttributeError: 'FileRepository' object has no attribute 'get_max_collection_counter'`

- [ ] **Step 1.3: Add `import re` to `file_repository.py`**

In `fastapi_app/lib/repository/file_repository.py`, change the import block at the top:

```python
# old
import json
import sqlite3
from typing import Optional, List
```

```python
# new
import json
import re
import sqlite3
from typing import Optional, List
```

- [ ] **Step 1.4: Add `get_max_collection_counter` to `FileRepository`**

In `fastapi_app/lib/repository/file_repository.py`, insert the following method directly after the `get_files_by_doc_id` method (which ends just before `get_pdf_for_document`). Find the line that starts `def get_pdf_for_document` and insert before it:

```python
    def get_max_collection_counter(self, prefix: str) -> int:
        """Return the max numeric suffix N in non-deleted doc_ids '{prefix}-NNNN', or 0."""
        suffix_re = re.compile(rf"^{re.escape(prefix)}-(\d+)$")
        with self.db.get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                "SELECT doc_id FROM files WHERE doc_id LIKE ? AND deleted = 0",
                (f"{prefix}-%",)
            )
            rows = cursor.fetchall()
        max_n = 0
        for row in rows:
            m = suffix_re.match(row['doc_id'])
            if m:
                n = int(m.group(1))
                if n > max_n:
                    max_n = n
        return max_n

```

- [ ] **Step 1.5: Run test to verify it passes**

```bash
uv run python tests/unit-test-runner.py tests/unit/fastapi/test_doc_id_utils.py -v
```

Expected: `OK` with 4 tests passing.

- [ ] **Step 1.6: Commit**

```bash
git add fastapi_app/lib/repository/file_repository.py tests/unit/fastapi/test_doc_id_utils.py
git commit -m "feat: add FileRepository.get_max_collection_counter for collection-mode doc IDs"
```

---

## Task 2: Create `doc_id_utils.py`

**Files:**
- Create: `fastapi_app/lib/utils/doc_id_utils.py`
- Modify: `tests/unit/fastapi/test_doc_id_utils.py` (extend)

- [ ] **Step 2.1: Append failing tests to `test_doc_id_utils.py`**

Add the following import block at the top of the file (after `from fastapi_app.lib.models.models import FileCreate`):

```python
from unittest.mock import MagicMock, patch
```

Then append the following class to the end of `tests/unit/fastapi/test_doc_id_utils.py`:

```python
class TestResolveDocId(unittest.TestCase):
    """Test resolve_doc_id() for all four modes."""

    def test_filename_mode_strips_extension(self):
        from fastapi_app.lib.utils.doc_id_utils import resolve_doc_id
        self.assertEqual(resolve_doc_id('filename', 'my-doc.pdf', b'', 'pdf'), 'my-doc')

    def test_filename_mode_replaces_whitespace(self):
        from fastapi_app.lib.utils.doc_id_utils import resolve_doc_id
        self.assertEqual(resolve_doc_id('filename', 'My Document.pdf', b'', 'pdf'), 'My_Document')

    def test_filename_mode_decodes_double_underscore(self):
        from fastapi_app.lib.utils.doc_id_utils import resolve_doc_id
        self.assertEqual(resolve_doc_id('filename', '10.1111__eulj.12049.pdf', b'', 'pdf'), '10.1111/eulj.12049')

    def test_filename_mode_decodes_single_underscore_doi(self):
        from fastapi_app.lib.utils.doc_id_utils import resolve_doc_id
        self.assertEqual(resolve_doc_id('filename', '10.1111_eulj.12049.pdf', b'', 'pdf'), '10.1111/eulj.12049')

    def test_filename_mode_does_not_extract_doi(self):
        """filename mode must not call extract_doi_from_pdf."""
        from fastapi_app.lib.utils.doc_id_utils import resolve_doc_id
        with patch('fastapi_app.lib.utils.doc_id_utils.extract_doi_from_pdf') as mock_ex:
            resolve_doc_id('filename', 'my-doc.pdf', b'fake-bytes', 'pdf')
            mock_ex.assert_not_called()

    def test_doi_mode_extracts_doi_from_pdf_content(self):
        from fastapi_app.lib.utils.doc_id_utils import resolve_doc_id
        with patch('fastapi_app.lib.utils.doc_id_utils.extract_doi_from_pdf', return_value='10.5678/found'):
            result = resolve_doc_id('doi', 'my-doc.pdf', b'fake-pdf', 'pdf')
        self.assertEqual(result, '10.5678/found')

    def test_doi_mode_falls_back_to_filename_when_no_doi(self):
        from fastapi_app.lib.utils.doc_id_utils import resolve_doc_id
        with patch('fastapi_app.lib.utils.doc_id_utils.extract_doi_from_pdf', return_value=None):
            result = resolve_doc_id('doi', 'my-doc.pdf', b'', 'pdf')
        self.assertEqual(result, 'my-doc')

    def test_doi_mode_skips_extraction_for_xml(self):
        """DOI extraction is only attempted for file_type='pdf'."""
        from fastapi_app.lib.utils.doc_id_utils import resolve_doc_id
        with patch('fastapi_app.lib.utils.doc_id_utils.extract_doi_from_pdf') as mock_ex:
            result = resolve_doc_id('doi', 'my-doc.xml', b'', 'xml')
            mock_ex.assert_not_called()
        self.assertEqual(result, 'my-doc')

    def test_doi_mode_skips_extraction_when_filename_is_already_doi(self):
        """If filename already is a valid DOI, skip PDF extraction."""
        from fastapi_app.lib.utils.doc_id_utils import resolve_doc_id
        with patch('fastapi_app.lib.utils.doc_id_utils.extract_doi_from_pdf') as mock_ex:
            result = resolve_doc_id('doi', '10.1111__eulj.12049.pdf', b'', 'pdf')
            mock_ex.assert_not_called()
        self.assertEqual(result, '10.1111/eulj.12049')

    def test_collection_mode_first_doc_is_0001(self):
        from fastapi_app.lib.utils.doc_id_utils import resolve_doc_id
        mock_repo = MagicMock()
        mock_repo.get_max_collection_counter.return_value = 0
        result = resolve_doc_id('collection', 'irrelevant.pdf', b'', 'pdf', 'mycol', mock_repo)
        self.assertEqual(result, 'mycol-0001')
        mock_repo.get_max_collection_counter.assert_called_once_with('mycol')

    def test_collection_mode_increments_counter(self):
        from fastapi_app.lib.utils.doc_id_utils import resolve_doc_id
        mock_repo = MagicMock()
        mock_repo.get_max_collection_counter.return_value = 5
        result = resolve_doc_id('collection', 'irrelevant.pdf', b'', 'pdf', 'mycol', mock_repo)
        self.assertEqual(result, 'mycol-0006')

    def test_collection_mode_pads_to_four_digits(self):
        from fastapi_app.lib.utils.doc_id_utils import resolve_doc_id
        mock_repo = MagicMock()
        mock_repo.get_max_collection_counter.return_value = 99
        result = resolve_doc_id('collection', 'irrelevant.pdf', b'', 'pdf', 'mycol', mock_repo)
        self.assertEqual(result, 'mycol-0100')

    def test_collection_mode_falls_back_to_doi_without_collection_id(self):
        from fastapi_app.lib.utils.doc_id_utils import resolve_doc_id
        with patch('fastapi_app.lib.utils.doc_id_utils.extract_doi_from_pdf', return_value=None):
            result = resolve_doc_id('collection', 'my-doc.pdf', b'', 'pdf', None, None)
        self.assertEqual(result, 'my-doc')

    def test_collection_mode_falls_back_to_doi_on_counter_failure(self):
        from fastapi_app.lib.utils.doc_id_utils import resolve_doc_id
        mock_repo = MagicMock()
        mock_repo.get_max_collection_counter.side_effect = Exception("DB error")
        with patch('fastapi_app.lib.utils.doc_id_utils.extract_doi_from_pdf', return_value=None):
            result = resolve_doc_id('collection', 'my-doc.pdf', b'', 'pdf', 'mycol', mock_repo)
        self.assertEqual(result, 'mycol-0001')

    def test_uuid_mode_returns_valid_uuid4(self):
        import uuid as _uuid
        from fastapi_app.lib.utils.doc_id_utils import resolve_doc_id
        result = resolve_doc_id('uuid', 'irrelevant.pdf', b'', 'pdf')
        parsed = _uuid.UUID(result)
        self.assertEqual(parsed.version, 4)

    def test_unknown_mode_falls_back_to_doi_with_warning(self):
        from fastapi_app.lib.utils.doc_id_utils import resolve_doc_id
        with patch('fastapi_app.lib.utils.doc_id_utils.extract_doi_from_pdf', return_value=None):
            with self.assertLogs('fastapi_app.lib.utils.doc_id_utils', level='WARNING') as log:
                result = resolve_doc_id('bogus', 'my-doc.pdf', b'', 'pdf')
        self.assertEqual(result, 'my-doc')
        self.assertTrue(any('bogus' in line for line in log.output))
```

- [ ] **Step 2.2: Run tests to verify they fail**

```bash
uv run python tests/unit-test-runner.py tests/unit/fastapi/test_doc_id_utils.py -v
```

Expected: `ModuleNotFoundError: No module named 'fastapi_app.lib.utils.doc_id_utils'` (or similar import error)

- [ ] **Step 2.3: Create `fastapi_app/lib/utils/doc_id_utils.py`**

```python
"""
Document ID resolution utilities.

Provides resolve_doc_id() which derives a stable doc_id for a newly uploaded file
according to the configured strategy.
"""
import os
import re
import uuid as _uuid
import logging
from typing import Optional, TYPE_CHECKING

from fastapi_app.lib.utils.doi_utils import extract_doi_from_pdf, validate_doi

if TYPE_CHECKING:
    from fastapi_app.lib.repository.file_repository import FileRepository

logger = logging.getLogger(__name__)


def resolve_doc_id(
    mode: str,
    filename: str,
    content: bytes,
    file_type: str,
    collection_id: Optional[str] = None,
    repo: Optional['FileRepository'] = None,
) -> str:
    """
    Resolve a doc_id for a newly uploaded file according to the configured strategy.

    Args:
        mode: One of 'filename', 'doi', 'collection', 'uuid'.
        filename: Original upload filename (with extension).
        content: Raw file bytes (used for DOI extraction from PDFs).
        file_type: 'pdf' or 'xml'.
        collection_id: Target collection ID (required for 'collection' mode).
        repo: FileRepository instance (required for 'collection' mode).

    Returns:
        Resolved doc_id string.
    """
    if mode == 'filename':
        return _derive_from_filename(filename)
    if mode == 'doi':
        return _resolve_doi(filename, content, file_type)
    if mode == 'collection':
        return _resolve_collection(filename, content, file_type, collection_id, repo)
    if mode == 'uuid':
        return str(_uuid.uuid4())
    logger.warning(f"Unknown document.id.mode '{mode}', falling back to 'doi'")
    return _resolve_doi(filename, content, file_type)


def _derive_from_filename(filename: str) -> str:
    """Strip extension and decode filesystem-safe DOI encoding from a filename."""
    name = os.path.splitext(filename)[0]
    label = name.replace("__", "/")
    label = re.sub(r'^(10\.\d{4,9})_(?!_)', r'\1/', label)
    return re.sub(r'\s+', '_', label)


def _resolve_doi(filename: str, content: bytes, file_type: str) -> str:
    """Return filename-derived doc_id, overridden by a DOI extracted from PDF content."""
    base = _derive_from_filename(filename)
    if file_type == 'pdf' and not validate_doi(base):
        extracted = extract_doi_from_pdf(content)
        if extracted:
            return extracted
    return base


def _resolve_collection(
    filename: str,
    content: bytes,
    file_type: str,
    collection_id: Optional[str],
    repo: Optional['FileRepository'],
) -> str:
    """Return '{collection_id}-{NNNN}'; falls back to doi mode if no collection context."""
    if not collection_id or not repo:
        logger.debug("'collection' mode: no collection_id or repo, falling back to 'doi'")
        return _resolve_doi(filename, content, file_type)
    try:
        current_max = repo.get_max_collection_counter(collection_id)
    except Exception as e:
        logger.warning(f"'collection' mode: counter query failed ({e}), using counter 1")
        current_max = 0
    return f"{collection_id}-{current_max + 1:04d}"
```

- [ ] **Step 2.4: Run tests to verify they pass**

```bash
uv run python tests/unit-test-runner.py tests/unit/fastapi/test_doc_id_utils.py -v
```

Expected: `OK` with all tests passing (4 from Task 1 + 15 from Task 2 = 19 tests).

- [ ] **Step 2.5: Commit**

```bash
git add fastapi_app/lib/utils/doc_id_utils.py tests/unit/fastapi/test_doc_id_utils.py
git commit -m "feat: add doc_id_utils.resolve_doc_id with filename/doi/collection/uuid modes"
```

---

## Task 3: Add config key to `config/config.json`

**Files:**
- Modify: `config/config.json`

- [ ] **Step 3.1: Add `document.id.mode` to `config/config.json`**

In `config/config.json`, add the following four lines after the closing `}` of `"tei.pretty-print.inline-elements.type"` (i.e., just before the final `}`). The file ends with:

```json
  "tei.pretty-print.inline-elements.type": "array"
}
```

Change it to:

```json
  "tei.pretty-print.inline-elements.type": "array",
  "document.id.mode": "doi",
  "document.id.mode.description": "Strategy for generating doc_id on new PDF upload: filename (as-is), doi (filename with DOI override from PDF content, default), collection ({collection_id}-{NNNN}), uuid (UUID4)",
  "document.id.mode.type": "string",
  "document.id.mode.values": ["filename", "doi", "collection", "uuid"]
}
```

- [ ] **Step 3.2: Commit**

```bash
git add config/config.json
git commit -m "config: add document.id.mode key (default: doi)"
```

---

## Task 4: Update `files_upload.py`

**Files:**
- Modify: `fastapi_app/routers/files_upload.py`

- [ ] **Step 4.1: Update import line for `fastapi`**

In `fastapi_app/routers/files_upload.py`, change:

```python
from fastapi import APIRouter, UploadFile, File, Depends, HTTPException, Request
```

to:

```python
from fastapi import APIRouter, UploadFile, File, Form, Depends, HTTPException, Request
```

- [ ] **Step 4.2: Remove now-unused `doi_utils` imports**

Remove the line:

```python
from ..lib.utils.doi_utils import validate_doi, extract_doi_from_pdf
```

- [ ] **Step 4.3: Add new imports for `doc_id_utils` and `get_config`**

After the existing `from ..lib.utils.logging_utils import get_logger` line, add:

```python
from ..lib.utils.doc_id_utils import resolve_doc_id
from ..lib.utils.config_utils import get_config
```

- [ ] **Step 4.4: Add `collection_id` parameter to `upload_file`**

In the `upload_file` function signature, add `collection_id` as the second parameter (after `request`):

```python
async def upload_file(
    request: Request,
    collection_id: Optional[str] = Form(None),
    file: UploadFile = File(...),
    storage: FileStorage = Depends(get_file_storage),
    repo: FileRepository = Depends(get_file_repository),
    session_id: Optional[str] = Depends(get_session_id),
    user: dict = Depends(get_current_user)
):
```

- [ ] **Step 4.5: Replace inline doc_id derivation block**

In `files_upload.py`, replace this block (lines 126–148 in the original, starting with the comment `# Compute doc_id and label`):

```python
    # Compute doc_id and label from filename before duplicate check so they can
    # be applied to existing files when the same content is re-uploaded with a
    # different (e.g. DOI-based) name.
    import os
    import re
    original_name = os.path.splitext(file.filename)[0]
    # Decode filesystem-safe DOI encoding back to display form:
    # "10.1111__eulj.12049" -> "10.1111/eulj.12049" (double underscore)
    label = original_name.replace("__", "/")
    # Also accept a single underscore as the DOI prefix/suffix separator:
    # "10.1111_eulj.12049" -> "10.1111/eulj.12049"
    label = re.sub(r'^(10\.\d{4,9})_(?!_)', r'\1/', label)
    # Derive doc_id from the decoded label (replace remaining whitespace with _)
    doc_id = re.sub(r'\s+', '_', label)

    # For PDFs whose filename is not already a valid DOI, try to extract one
    # from the text layer (first two pages only, to avoid bibliography DOIs).
    if file_type == 'pdf' and not validate_doi(doc_id):
        extracted_doi = extract_doi_from_pdf(content)
        if extracted_doi:
            logger.info(f"Extracted DOI from PDF content: {extracted_doi}")
            doc_id = extracted_doi
            label = extracted_doi
```

with:

```python
    # Resolve doc_id according to the configured strategy.
    mode = get_config().get('document.id.mode', default='doi')
    doc_id = resolve_doc_id(mode, file.filename, content, file_type, collection_id, repo)
    label = doc_id
```

- [ ] **Step 4.6: Run the existing upload tests**

```bash
uv run python tests/unit-test-runner.py tests/unit/fastapi/test_upload_doc_id.py -v
```

Expected: All tests pass. (These tests replicate the filename-derivation logic inline and remain valid because the behaviour is unchanged for the default `doi` mode.)

- [ ] **Step 4.7: Run the full FastAPI unit test suite**

```bash
npm run test:unit:fastapi
```

Expected: All tests pass.

- [ ] **Step 4.8: Commit**

```bash
git add fastapi_app/routers/files_upload.py
git commit -m "feat: wire upload router to resolve_doc_id with configurable mode and optional collection_id"
```

---

## Task 5: Document `document.id.mode` in the user manual

**Files:**
- Modify: `docs/user-manual/app-config.md`

- [ ] **Step 5.1: Add documentation section**

In `docs/user-manual/app-config.md`, append the following after the existing screenshot line:

```markdown

## Configuration reference

The following settings can be changed via the Configuration Editor (admin role required).

### `document.id.mode`

Controls how the **document ID** (`doc_id`) is derived when a new PDF is uploaded. The document ID connects the PDF to its extracted TEI annotations and is used as the base name of exported files.

| Value | Behaviour |
| --- | --- |
| `doi` (default) | Uses the filename as the ID. If the filename is not already a valid DOI, the first two pages of the PDF are scanned and the extracted DOI is used instead. |
| `filename` | Always uses the filename as the ID (no DOI extraction). |
| `collection` | Generates `{collection_id}-{NNNN}` (e.g. `my-corpus-0003`). Requires the upload request to include a `collection_id` form field; without one, falls back to `doi` mode. The counter is per collection and zero-padded to four digits. |
| `uuid` | Generates a random UUID v4 as the ID. |

**Example** — set in `data/db/config.json` or via the Configuration Editor:

```json
"document.id.mode": "collection"
```

**Frontend note:** To use `collection` mode, the upload call must pass the target `collection_id` as a form field alongside the file. Without it, the mode silently falls back to `doi`.
```

- [ ] **Step 5.2: Commit**

```bash
git add docs/user-manual/app-config.md
git commit -m "docs: document document.id.mode config key and its four values"
```

---

## Self-Review

**Spec coverage:**
- [x] `filename` mode — Task 2 (`_derive_from_filename`, test: `test_filename_mode_*`)
- [x] `doi` mode (default) — Task 2 (`_resolve_doi`, test: `test_doi_mode_*`)
- [x] `collection` mode — Tasks 1 + 2 (`get_max_collection_counter` + `_resolve_collection`, tests: `test_collection_mode_*`)
- [x] `uuid` mode — Task 2 (test: `test_uuid_mode_returns_valid_uuid4`)
- [x] Unknown mode fallback — Task 2 (test: `test_unknown_mode_falls_back_to_doi_with_warning`)
- [x] Config key `document.id.mode` — Task 3
- [x] Upload router wired — Task 4
- [x] `collection_id` Form param on upload — Task 4.4
- [x] New uploads only (re-upload path unchanged) — the re-upload branches in `files_upload.py` are untouched
- [x] Documentation — Task 5

**No placeholders found.**

**Type consistency:**
- `resolve_doc_id(mode, filename, content, file_type, collection_id, repo)` — defined Task 2.3, called Task 4.5 with identical signature ✓
- `repo.get_max_collection_counter(collection_id)` — defined Task 1.4, called inside `_resolve_collection` Task 2.3 ✓
- `get_config().get('document.id.mode', default='doi')` — matches `config_utils` API used elsewhere in the codebase ✓
