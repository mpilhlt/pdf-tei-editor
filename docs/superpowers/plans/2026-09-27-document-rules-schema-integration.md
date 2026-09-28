# Document Rules Registry — Schema Validation Integration (Plan 2 of 5) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user's selected schema override (from Plan 1's `/api/v1/document-rules` registry) actually affect `/api/v1/validate`, per [docs/superpowers/specs/2026-09-27-document-rules-registry-design.md](../specs/2026-09-27-document-rules-registry-design.md)'s "Schema validation integration" section — without touching the shared, TTL-cached schema files other users' validation reads from.

**Architecture:** One new seam on the existing, well-tested `schema_validator.validate()`: an optional `schema_text_override: dict[str, str] | None` keyed by *resolved* schema location. When a location has override text, `validate()` writes it to a private temporary file (never the shared cache file for that location) and validates against that instead — every other line of `validate()`'s existing locate/parse/validate logic is unchanged and reused as-is. A new small module bridges Plan 1's `DocumentRulesStore` into this seam by building that dict from the document's RelaxNG schema locations and the caller's selections. `POST /api/v1/validate` is updated to use it.

**Tech Stack:** FastAPI, lxml, Python `unittest`, the existing `fastapi_app/lib/core/schema_validator.py` module (untouched otherwise) and `fastapi_app/lib/doc_rules/` package (from Plan 1, untouched otherwise).

---

## Prerequisite

Plan 1 (`docs/superpowers/plans/2026-09-27-document-rules-core.md`) must already be merged into this branch: `fastapi_app/lib/doc_rules/{kinds,resource_key,storage,__init__}.py`, migration 009, and `fastapi_app/routers/document_rules.py` must exist. Confirm with:

```bash
uv run python -c "from fastapi_app.lib.doc_rules.storage import DocumentRulesStore; from fastapi_app.routers.document_rules import router; print('ok')"
```

## File Structure

Modify:

- `fastapi_app/lib/core/schema_validator.py` — add the `schema_text_override` parameter to `validate()`
- `fastapi_app/routers/document_rules.py` — `get_document_rules_store` moves out of this file (Task 1)
- `fastapi_app/lib/core/dependencies.py` — `get_document_rules_store` moves into this file (Task 1), alongside the existing `get_file_repository`/`get_file_storage`-style DI helpers
- `fastapi_app/routers/validation.py` — `validate_xml` builds and passes `schema_text_override`

Create:

- `fastapi_app/lib/doc_rules/schema_override.py` — `build_schema_text_override()`
- `tests/unit/fastapi/test_schema_validator_override.py`
- `tests/unit/fastapi/test_doc_rules_schema_override.py`
- Test additions to `tests/unit/fastapi/test_validation_router.py` and `tests/unit/fastapi/test_document_rules_router.py` (Task 1's regression check)

---

### Task 1: Move `get_document_rules_store` into `dependencies.py`

**Files:**
- Modify: `fastapi_app/lib/core/dependencies.py`
- Modify: `fastapi_app/routers/document_rules.py`

**Why:** Task 4 below needs the same dependency function in `validation.py`. Every other cross-router DI helper in this codebase (`get_file_repository`, `get_file_storage`, `get_session_manager`, ...) lives in `fastapi_app/lib/core/dependencies.py`, not in a router file — `get_document_rules_store` was defined locally in `document_rules.py` in Plan 1 only because nothing else needed it yet. Moving it now (before a second router needs it) matches the established pattern instead of duplicating the function.

- [ ] **Step 1: Move the function**

`fastapi_app/lib/core/dependencies.py` already imports `FileRepository`/`FileStorage` directly at module scope (top of file, alongside `DatabaseManager`) — no `TYPE_CHECKING`/deferred-import convention exists in this file for repository classes, so follow that same direct pattern. Add to the existing import block near the top of the file:

```python
from fastapi_app.lib.doc_rules.storage import DocumentRulesStore
```

Then add the function itself near `get_file_repository` (after its definition):

```python
def get_document_rules_store(db: DatabaseManager = Depends(get_db)) -> DocumentRulesStore:
    """Get DocumentRulesStore instance with database"""
    return DocumentRulesStore(db)
```

- [ ] **Step 2: Remove it from `document_rules.py` and import it instead**

In `fastapi_app/routers/document_rules.py`, remove this function definition:

```python
def get_document_rules_store(db: DatabaseManager = Depends(get_db)) -> DocumentRulesStore:
    return DocumentRulesStore(db)
```

and instead import it from `dependencies.py`:

```python
from ..lib.core.dependencies import get_db, get_document_rules_store, require_authenticated_user
```

(replacing the existing `from ..lib.core.dependencies import get_db, require_authenticated_user` line). Every `Depends(get_document_rules_store)` call site in this file stays exactly as it is — only where the function is *defined* changes.

- [ ] **Step 3: Run the existing tests to confirm no regression**

Run: `uv run python tests/unit-test-runner.py tests/unit/fastapi/test_document_rules_router.py -v`
Expected: PASS (all 7 tests, unchanged behavior — this is a pure refactor)

- [ ] **Step 4: Commit**

```bash
git add fastapi_app/lib/core/dependencies.py fastapi_app/routers/document_rules.py
git commit -m "$(cat <<'EOF'
refactor(doc-rules): move get_document_rules_store into dependencies.py

Matches the existing convention (get_file_repository, get_file_storage,
...) of keeping cross-router DI helpers in dependencies.py rather than
a specific router file. Needed because validation.py's route will use
the same dependency in the next task.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: `schema_text_override` seam on `schema_validator.validate()`

**Files:**
- Modify: `fastapi_app/lib/core/schema_validator.py`
- Test: `tests/unit/fastapi/test_schema_validator_override.py`

**Design.** `validate()`'s existing per-location loop resolves a schema location to a **file path** (the shared TTL-cached file, downloading first if stale), then does two things with that file path: parses it to determine `root_namespace`, and passes the path to `validate_with_timeout()` (which runs validation in a subprocess for timeout isolation — including on data the caller doesn't control, so this isolation must be preserved for an override's text too, not bypassed). The seam adds a second way to arrive at a file path for a given location — a private temporary file holding the override text — chosen instead of the cache path when the caller supplies override text for that location. Every downstream line (namespace detection, RelaxNG `xsi:schemaLocation` stripping, `validate_with_timeout`) is unchanged; only *which file* it operates on changes, based on one `if` near the top of the loop body.

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/fastapi/test_schema_validator_override.py`:

```python
"""
Unit tests for schema_validator.validate()'s schema_text_override seam.

@testCovers fastapi_app/lib/core/schema_validator.py:validate
"""

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi_app.lib.core.schema_validator import get_schema_cache_info, validate

SCHEMA_LOCATION = "https://example.com/schema/tei.rng"

XML_DOC = f"""<?xml version="1.0"?>
<?xml-model href="{SCHEMA_LOCATION}" schematypens="http://relaxng.org/ns/structure/1.0"?>
<root xmlns="http://www.tei-c.org/ns/1.0"><child/></root>
"""

# Permissive: any single root element with any content is valid.
PERMISSIVE_SCHEMA = """<?xml version="1.0" encoding="UTF-8"?>
<grammar xmlns="http://relaxng.org/ns/structure/1.0" datatypeLibrary="">
  <start>
    <element name="root" ns="http://www.tei-c.org/ns/1.0">
      <zeroOrMore><element name="child" ns="http://www.tei-c.org/ns/1.0"><empty/></element></zeroOrMore>
    </element>
  </start>
</grammar>
"""

# Strict: forbids the "child" element the test document actually has.
STRICT_SCHEMA_FORBIDDING_CHILD = """<?xml version="1.0" encoding="UTF-8"?>
<grammar xmlns="http://relaxng.org/ns/structure/1.0" datatypeLibrary="">
  <start>
    <element name="root" ns="http://www.tei-c.org/ns/1.0">
      <empty/>
    </element>
  </start>
</grammar>
"""


class TestSchemaTextOverride(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.cache_root = Path(self.temp_dir.name)
        # Pre-populate the shared cache with the permissive schema, as if
        # a prior, non-overriding validation had already cached it.
        cache_dir, cache_file, _ = get_schema_cache_info(SCHEMA_LOCATION, self.cache_root)
        cache_dir.mkdir(parents=True, exist_ok=True)
        cache_file.write_text(PERMISSIVE_SCHEMA, encoding="utf-8")
        self.cache_file = cache_file

    def tearDown(self):
        self.temp_dir.cleanup()

    def test_no_override_uses_the_shared_cache_and_validates_clean(self):
        errors = validate(XML_DOC, cache_root=self.cache_root)
        self.assertEqual(errors, [])

    def test_override_is_used_instead_of_cache_and_changes_the_result(self):
        errors = validate(
            XML_DOC,
            cache_root=self.cache_root,
            schema_text_override={SCHEMA_LOCATION: STRICT_SCHEMA_FORBIDDING_CHILD},
        )
        self.assertTrue(errors, "expected the stricter override schema to reject <child/>")

    def test_override_never_writes_to_the_shared_cache_file(self):
        original_cache_content = self.cache_file.read_text(encoding="utf-8")
        validate(
            XML_DOC,
            cache_root=self.cache_root,
            schema_text_override={SCHEMA_LOCATION: STRICT_SCHEMA_FORBIDDING_CHILD},
        )
        self.assertEqual(self.cache_file.read_text(encoding="utf-8"), original_cache_content)

    def test_override_does_not_trigger_a_download(self):
        with patch("fastapi_app.lib.core.schema_validator.download_schema_file") as mock_download:
            validate(
                XML_DOC,
                cache_root=self.cache_root,
                schema_text_override={SCHEMA_LOCATION: STRICT_SCHEMA_FORBIDDING_CHILD},
            )
        mock_download.assert_not_called()

    def test_override_for_a_different_location_is_ignored(self):
        errors = validate(
            XML_DOC,
            cache_root=self.cache_root,
            schema_text_override={"https://example.com/other-schema.rng": STRICT_SCHEMA_FORBIDDING_CHILD},
        )
        self.assertEqual(errors, [], "override keyed by an unrelated location must not affect this document")

    def test_default_schema_text_override_is_none_and_behaves_like_before(self):
        # No schema_text_override argument at all - byte-for-byte today's behavior.
        errors = validate(XML_DOC, cache_root=self.cache_root)
        self.assertEqual(errors, [])

    def test_temp_file_used_for_override_does_not_linger(self):
        import glob
        import os
        before = set(glob.glob(os.path.join(tempfile.gettempdir(), "*")))
        validate(
            XML_DOC,
            cache_root=self.cache_root,
            schema_text_override={SCHEMA_LOCATION: STRICT_SCHEMA_FORBIDDING_CHILD},
        )
        after = set(glob.glob(os.path.join(tempfile.gettempdir(), "*")))
        self.assertEqual(before, after, "the override's temporary schema file must be cleaned up")
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `uv run python tests/unit-test-runner.py tests/unit/fastapi/test_schema_validator_override.py -v`
Expected: FAIL — `TypeError: validate() got an unexpected keyword argument 'schema_text_override'` on every test that passes it; `test_no_override_uses_the_shared_cache_and_validates_clean` and `test_default_schema_text_override_is_none_and_behaves_like_before` should already PASS (they exercise only existing behavior).

- [ ] **Step 3: Implement**

In `fastapi_app/lib/core/schema_validator.py`, change the `validate()` signature:

```python
def validate(
    xml_string: str,
    cache_root: Optional[Path] = None,
    schema_text_override: Optional[Dict[str, str]] = None,
) -> List[Dict]:
    """
    Validate an XML string using the schema declaration in the document.

    Framework-agnostic validation function with dependency injection.

    Args:
        xml_string: XML document to validate
        cache_root: Root directory for schema cache (default: schema/cache)
        schema_text_override: Optional map of resolved schema location -> schema
            text to validate against instead of the shared, TTL-cached file for
            that location. Keyed by the location *after* resolve_schema_location()
            is applied (i.e. after any registered redirect), matching how this
            function resolves each location internally. A location with no entry
            uses the shared cache exactly as before; None (the default) is
            byte-for-byte today's behavior. The override text is written to a
            private temporary file for the duration of this call and never
            touches the shared schema cache other callers read from.

    Returns:
        List of error dictionaries with keys: message, line, column, severity (optional)
    """
```

Then, inside the `for sl in schema_locations:` loop, replace the block from `schema_cache_dir, schema_cache_file, _ = get_schema_cache_info(...)` through the `else: logger.debug(f"Using cached version at {schema_cache_file}")` line with:

```python
        override_text = (schema_text_override or {}).get(schema_location)
        temp_schema_path: Optional[Path] = None
        if override_text is not None:
            with tempfile.NamedTemporaryFile(mode='w', suffix='.schema', delete=False, encoding='utf-8') as tmp:
                tmp.write(override_text)
                temp_schema_path = Path(tmp.name)
            schema_file_to_validate = temp_schema_path
            logger.debug(f"Using override text for {schema_location} instead of the shared cache")
        else:
            schema_cache_dir, schema_cache_file, _ = get_schema_cache_info(schema_location, cache_root)

            # Download schema if not cached, or if the cached copy is older than the TTL
            if is_schema_cache_stale(schema_cache_file):
                logger.debug(f"Downloading schema from {schema_location} and caching it at {schema_cache_file}")
                schema_cache_dir.mkdir(parents=True, exist_ok=True)
                try:
                    if schema_type == "relaxng":
                        # Download the RelaxNG schema file
                        download_schema_file(schema_location, schema_cache_dir, schema_cache_file)
                    else:
                        # For XSD, use xmlschema which handles includes/imports
                        xmlschema.download_schemas(str(schema_location), target=str(schema_cache_dir), save_remote=True)
                except requests.HTTPError as e:
                    raise ValidationError(
                        f"Failed to download schema for {namespace} from {schema_location} - check the URL: {e}"
                    )
                except xmlschema.XMLSchemaParseError as e:
                    raise ValidationError(
                        f"Failed to parse schema for {namespace} from {schema_location}: {str(e)}"
                    )
            else:
                logger.debug(f"Using cached version at {schema_cache_file}")
            schema_file_to_validate = schema_cache_file
```

Then, in the two places below this that reference `schema_cache_file` (the `etree.parse(str(schema_cache_file))` line, and the `validate_with_timeout(str(schema_cache_file), ...)` call), replace `schema_cache_file` with `schema_file_to_validate`.

Finally, wrap the remainder of this loop iteration (from the `etree.parse` call through the end of the `except ValidationError` block, i.e. everything that uses `schema_file_to_validate`) so the temp file is always cleaned up, by adding a `finally` clause. Concretely, restructure the tail of the loop body from:

```python
        # Parse schema to determine actual type from file content
        try:
            schema_tree = etree.parse(str(schema_file_to_validate))
            root_namespace = schema_tree.getroot().tag.split('}')[0][1:]
        except Exception as e:
            raise ValidationError(f"Failed to parse schema file {schema_file_to_validate}: {str(e)}")

        if root_namespace not in [XSD_NAMESPACE, RELAXNG_NAMESPACE]:
            raise ValidationError(f'Unsupported schema namespace: {root_namespace}')

        # Prepare XML document for validation based on schema type
        if root_namespace == RELAXNG_NAMESPACE:
            # For RelaxNG, remove schemaLocation attribute if present to avoid validation errors
            validation_xml = re.sub(r'\s+xmlns:xsi="[^"]*"', '', xml_string)
            validation_xml = re.sub(r'\s+xsi:schemaLocation="[^"]*"', '', validation_xml)
            validation_xml_bytes = validation_xml.encode('utf-8') if isinstance(validation_xml, str) else validation_xml
        else:
            # For XSD, use original XML
            validation_xml_bytes = xml_string.encode('utf-8') if isinstance(xml_string, str) else xml_string

        # Perform validation with timeout protection using subprocess isolation
        try:
            logger.debug(f"Starting validation with {validation_timeout}s timeout")
            validation_errors = validate_with_timeout(
                str(schema_file_to_validate),
                validation_xml_bytes,
                root_namespace,
                timeout=validation_timeout
            )
            errors.extend(validation_errors)
            logger.debug(f"Validation completed with {len(validation_errors)} errors")

        except ValidationTimeoutError as e:
            logger.warning(
                f"VALIDATION TIMEOUT: {namespace} schema validation timed out after "
                f"{validation_timeout}s - {schema_location}"
            )
            errors.append({
                "message": (
                    f"Schema validation timed out after {validation_timeout} seconds. "
                    "The schema may be too complex or the document too large. "
                    "Validation was skipped for performance reasons."
                ),
                "line": 1,
                "column": 1,
                "severity": "warning"
            })
        except ValidationError as e:
            logger.error(f"Validation failed for {namespace}: {str(e)}")
            errors.append({
                "message": f"Validation error: {str(e)}",
                "line": 1,
                "column": 1
            })
```

to the same body wrapped in `try: ... finally:`:

```python
        try:
            # Parse schema to determine actual type from file content
            try:
                schema_tree = etree.parse(str(schema_file_to_validate))
                root_namespace = schema_tree.getroot().tag.split('}')[0][1:]
            except Exception as e:
                raise ValidationError(f"Failed to parse schema file {schema_file_to_validate}: {str(e)}")

            if root_namespace not in [XSD_NAMESPACE, RELAXNG_NAMESPACE]:
                raise ValidationError(f'Unsupported schema namespace: {root_namespace}')

            # Prepare XML document for validation based on schema type
            if root_namespace == RELAXNG_NAMESPACE:
                # For RelaxNG, remove schemaLocation attribute if present to avoid validation errors
                validation_xml = re.sub(r'\s+xmlns:xsi="[^"]*"', '', xml_string)
                validation_xml = re.sub(r'\s+xsi:schemaLocation="[^"]*"', '', validation_xml)
                validation_xml_bytes = validation_xml.encode('utf-8') if isinstance(validation_xml, str) else validation_xml
            else:
                # For XSD, use original XML
                validation_xml_bytes = xml_string.encode('utf-8') if isinstance(xml_string, str) else xml_string

            # Perform validation with timeout protection using subprocess isolation
            try:
                logger.debug(f"Starting validation with {validation_timeout}s timeout")
                validation_errors = validate_with_timeout(
                    str(schema_file_to_validate),
                    validation_xml_bytes,
                    root_namespace,
                    timeout=validation_timeout
                )
                errors.extend(validation_errors)
                logger.debug(f"Validation completed with {len(validation_errors)} errors")

            except ValidationTimeoutError as e:
                logger.warning(
                    f"VALIDATION TIMEOUT: {namespace} schema validation timed out after "
                    f"{validation_timeout}s - {schema_location}"
                )
                errors.append({
                    "message": (
                        f"Schema validation timed out after {validation_timeout} seconds. "
                        "The schema may be too complex or the document too large. "
                        "Validation was skipped for performance reasons."
                    ),
                    "line": 1,
                    "column": 1,
                    "severity": "warning"
                })
            except ValidationError as e:
                logger.error(f"Validation failed for {namespace}: {str(e)}")
                errors.append({
                    "message": f"Validation error: {str(e)}",
                    "line": 1,
                    "column": 1
                })
        finally:
            if temp_schema_path is not None:
                temp_schema_path.unlink(missing_ok=True)
```

`Dict` and `Optional` are already imported at the top of the file (`from typing import List, Dict, Optional, Tuple`) — no new imports needed; `tempfile` and `Path` are also already imported.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `uv run python tests/unit-test-runner.py tests/unit/fastapi/test_schema_validator_override.py -v`
Expected: PASS (all 7 tests)

- [ ] **Step 5: Regression-check existing schema_validator consumers**

Run: `uv run python tests/unit-test-runner.py tests/unit/fastapi/test_validation_router.py -v` and `npm run test:api -- --grep validate`
Expected: PASS, unchanged (this task only adds an optional parameter defaulting to `None`, which is byte-for-byte today's behavior per the docstring)

- [ ] **Step 6: Commit**

```bash
git add fastapi_app/lib/core/schema_validator.py tests/unit/fastapi/test_schema_validator_override.py
git commit -m "$(cat <<'EOF'
feat(doc-rules): schema_text_override seam on schema_validator.validate()

Lets a caller supply schema text for a specific resolved location,
validated against instead of the shared TTL-cached file - via a
private temporary file, so a per-user override never touches the
cache other users' validation reads from. schema_text_override=None
(the default) is byte-for-byte today's behavior; every existing
locate/parse/validate code path is otherwise unchanged and reused.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: `build_schema_text_override()`

**Files:**
- Create: `fastapi_app/lib/doc_rules/schema_override.py`
- Test: `tests/unit/fastapi/test_doc_rules_schema_override.py`

**Design note.** `SchemaKind.discover()` (Plan 1) keys a resource by `normalize_resource_key(raw_schema_location)` — the *raw* URL as found in the document, before any redirect. `schema_validator.validate()`'s per-location loop, and thus the new `schema_text_override` seam (Task 2), keys by `resolve_schema_location(raw_schema_location)` — the *resolved*, post-redirect URL. This function is the one place that bridges the two: it looks up the override by the resource's raw-URL-derived key (matching how the override was created/selected via `/api/v1/document-rules`), then re-keys the result by the resolved URL (matching what `validate()` needs). Get this backwards and overrides will silently never apply.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/fastapi/test_doc_rules_schema_override.py`:

```python
"""
Unit tests for bridging document-rules schema overrides into
schema_validator.validate()'s schema_text_override seam.

@testCovers fastapi_app/lib/doc_rules/schema_override.py
"""

import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock

from fastapi_app.lib.core.database import DatabaseManager
from fastapi_app.lib.doc_rules.resource_key import normalize_resource_key
from fastapi_app.lib.doc_rules.schema_override import build_schema_text_override
from fastapi_app.lib.doc_rules.storage import DocumentRulesStore

RELAXNG_LOCATION = "https://example.com/schema/tei.rng"

XML_RELAXNG = f"""<?xml version="1.0"?>
<?xml-model href="{RELAXNG_LOCATION}" schematypens="http://relaxng.org/ns/structure/1.0"?>
<TEI xmlns="http://www.tei-c.org/ns/1.0"/>
"""

XML_XSD = """<?xml version="1.0"?>
<root xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
      xsi:schemaLocation="http://example.com/ns https://example.com/schema/doc.xsd">
</root>
"""


class TestBuildSchemaTextOverride(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.db = DatabaseManager(Path(self.temp_dir.name) / "test.db")
        self.store = DocumentRulesStore(self.db)

    def tearDown(self):
        self.temp_dir.cleanup()

    def test_no_selection_yields_empty_dict(self):
        result = build_schema_text_override(XML_RELAXNG, self.store, "alice")
        self.assertEqual(result, {})

    def test_selected_override_is_keyed_by_resolved_location(self):
        override = self.store.create_override(
            kind="schema",
            resource_key=normalize_resource_key(RELAXNG_LOCATION),
            owner="alice",
            note="",
            text="<grammar/>",
            format="xml",
            base_url=RELAXNG_LOCATION,
            base_hash="hash",
        )
        self.store.set_selection("schema", normalize_resource_key(RELAXNG_LOCATION), "alice", override["id"])

        result = build_schema_text_override(XML_RELAXNG, self.store, "alice")

        self.assertEqual(result, {RELAXNG_LOCATION: "<grammar/>"})

    def test_selection_belonging_to_a_different_user_is_ignored(self):
        override = self.store.create_override(
            kind="schema",
            resource_key=normalize_resource_key(RELAXNG_LOCATION),
            owner="alice",
            note="",
            text="<grammar/>",
            format="xml",
            base_url=RELAXNG_LOCATION,
            base_hash="hash",
        )
        self.store.set_selection("schema", normalize_resource_key(RELAXNG_LOCATION), "alice", override["id"])

        result = build_schema_text_override(XML_RELAXNG, self.store, "bob")

        self.assertEqual(result, {})

    def test_xsd_locations_are_never_included(self):
        # Even a real selected override for this key must be skipped, since
        # XSD is out of scope for the schema resource kind (v1) - discover()
        # never surfaces it, so nothing could legitimately be selected for
        # it, but build_schema_text_override must not assume that and should
        # filter by type itself too.
        result = build_schema_text_override(XML_XSD, self.store, "alice")
        self.assertEqual(result, {})

    def test_respects_a_registered_schema_redirect(self):
        from fastapi_app.lib.core import schema_validator

        old_location = "https://old.example.com/schema/tei.rng"
        new_location = "https://new.example.com/schema/tei.rng"
        schema_validator.register_schema_redirect(old_location, new_location)
        self.addCleanup(schema_validator.unregister_schema_redirect, old_location)

        xml = f"""<?xml version="1.0"?>
        <?xml-model href="{old_location}" schematypens="http://relaxng.org/ns/structure/1.0"?>
        <TEI xmlns="http://www.tei-c.org/ns/1.0"/>
        """
        override = self.store.create_override(
            kind="schema",
            resource_key=normalize_resource_key(old_location),
            owner="alice",
            note="",
            text="<grammar/>",
            format="xml",
            base_url=old_location,
            base_hash="hash",
        )
        self.store.set_selection("schema", normalize_resource_key(old_location), "alice", override["id"])

        result = build_schema_text_override(xml, self.store, "alice")

        # Selected/keyed by the raw (old) URL, but the dict validate() needs
        # must be keyed by the resolved (new) URL.
        self.assertEqual(result, {new_location: "<grammar/>"})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `uv run python tests/unit-test-runner.py tests/unit/fastapi/test_doc_rules_schema_override.py -v`
Expected: FAIL — `ModuleNotFoundError`

- [ ] **Step 3: Implement**

Create `fastapi_app/lib/doc_rules/schema_override.py`:

```python
"""
Bridges the document rules registry's per-user schema overrides into
schema_validator.validate()'s schema_text_override seam. See
docs/superpowers/specs/2026-09-27-document-rules-registry-design.md
("Schema validation integration").
"""

from fastapi_app.lib.core.schema_validator import extract_schema_locations, resolve_schema_location
from fastapi_app.lib.doc_rules.resource_key import normalize_resource_key
from fastapi_app.lib.doc_rules.storage import DocumentRulesStore


def build_schema_text_override(xml_string: str, store: DocumentRulesStore, owner: str) -> dict[str, str]:
    """
    For each RelaxNG schema location the document declares, look up
    `owner`'s selected override (if any) and return a dict keyed by the
    *resolved* schema location - matching how validate() itself resolves
    redirects before looking up this dict - so validate() reads a
    per-user override instead of the shared schema cache for that
    location. A resource's override is looked up by the raw (pre-redirect)
    URL's normalized key, matching how it was created/selected via
    /api/v1/document-rules and how SchemaKind.discover() keys it; only the
    dict's own keys are re-expressed in resolved form for validate()'s
    benefit. Locations with no selection, and non-RelaxNG locations (XSD
    is out of scope for v1 - see the design spec's Deferred section), are
    omitted entirely.
    """
    overrides: dict[str, str] = {}
    for location in extract_schema_locations(xml_string):
        if location["type"] != "relaxng":
            continue
        raw_url = location["schemaLocation"]
        resource_key = normalize_resource_key(raw_url)
        text = store.get_selected_override_text("schema", resource_key, owner)
        if text is not None:
            overrides[resolve_schema_location(raw_url)] = text
    return overrides
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `uv run python tests/unit-test-runner.py tests/unit/fastapi/test_doc_rules_schema_override.py -v`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add fastapi_app/lib/doc_rules/schema_override.py tests/unit/fastapi/test_doc_rules_schema_override.py
git commit -m "$(cat <<'EOF'
feat(doc-rules): bridge document-rules schema overrides into validate()

build_schema_text_override() re-keys a resource's raw-URL-derived
override lookup into the resolved-location form
schema_validator.validate()'s new seam expects, so a registered schema
redirect doesn't silently break the override.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Wire into `POST /api/v1/validate`

**Files:**
- Modify: `fastapi_app/routers/validation.py`
- Test: additions to `tests/unit/fastapi/test_validation_router.py`

- [ ] **Step 1: Write the failing test**

Add to `tests/unit/fastapi/test_validation_router.py` (append a new test class; keep existing imports/classes untouched, but add these two imports at the top alongside the existing ones):

```python
from fastapi_app.lib.core.database import DatabaseManager
from fastapi_app.lib.core.dependencies import get_document_rules_store
from fastapi_app.lib.doc_rules.resource_key import normalize_resource_key
from fastapi_app.lib.doc_rules.storage import DocumentRulesStore
```

Then append:

```python
PERMISSIVE_RELAXNG_SCHEMA = """<?xml version="1.0" encoding="UTF-8"?>
<grammar xmlns="http://relaxng.org/ns/structure/1.0" datatypeLibrary="">
  <start>
    <element name="root" ns="http://www.tei-c.org/ns/1.0">
      <zeroOrMore><element name="child" ns="http://www.tei-c.org/ns/1.0"><empty/></element></zeroOrMore>
    </element>
  </start>
</grammar>
"""

STRICT_RELAXNG_SCHEMA_FORBIDDING_CHILD = """<?xml version="1.0" encoding="UTF-8"?>
<grammar xmlns="http://relaxng.org/ns/structure/1.0" datatypeLibrary="">
  <start>
    <element name="root" ns="http://www.tei-c.org/ns/1.0">
      <empty/>
    </element>
  </start>
</grammar>
"""


class TestValidateXmlWithSchemaOverride(unittest.TestCase):
    """A selected schema override must actually change /validate's outcome."""

    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.cache_root = Path(self.temp_dir.name) / "schema-cache"
        self.db = DatabaseManager(Path(self.temp_dir.name) / "test.db")
        self.store = DocumentRulesStore(self.db)

        self.schema_location = "https://example.com/schema/tei.rng"
        cache_dir, cache_file, _ = get_schema_cache_info(self.schema_location, self.cache_root)
        cache_dir.mkdir(parents=True, exist_ok=True)
        cache_file.write_text(PERMISSIVE_RELAXNG_SCHEMA, encoding="utf-8")

        self.xml = (
            '<?xml version="1.0"?>'
            f'<?xml-model href="{self.schema_location}" schematypens="http://relaxng.org/ns/structure/1.0"?>'
            '<root xmlns="http://www.tei-c.org/ns/1.0"><child/></root>'
        )

        self.app = FastAPI()
        self.app.include_router(router)
        self.mock_settings = MagicMock()
        self.mock_settings.schema_cache_dir = self.cache_root
        self.app.dependency_overrides[get_settings] = lambda: self.mock_settings
        self.app.dependency_overrides[require_authenticated_user] = lambda: {"username": "alice"}
        self.app.dependency_overrides[get_document_rules_store] = lambda: self.store
        self.client = TestClient(self.app)

    def tearDown(self):
        self.temp_dir.cleanup()

    def test_no_selection_uses_the_cached_schema(self):
        response = self.client.post("/validate", json={"xml_string": self.xml})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["errors"], [])

    def test_selected_override_changes_the_validation_outcome(self):
        override = self.store.create_override(
            kind="schema",
            resource_key=normalize_resource_key(self.schema_location),
            owner="alice",
            note="",
            text=STRICT_RELAXNG_SCHEMA_FORBIDDING_CHILD,
            format="xml",
            base_url=self.schema_location,
            base_hash="hash",
        )
        self.store.set_selection(
            "schema", normalize_resource_key(self.schema_location), "alice", override["id"]
        )

        response = self.client.post("/validate", json={"xml_string": self.xml})

        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.json()["errors"], "expected the override's stricter schema to reject <child/>")

    def test_another_users_selection_does_not_affect_this_caller(self):
        override = self.store.create_override(
            kind="schema",
            resource_key=normalize_resource_key(self.schema_location),
            owner="bob",
            note="",
            text=STRICT_RELAXNG_SCHEMA_FORBIDDING_CHILD,
            format="xml",
            base_url=self.schema_location,
            base_hash="hash",
        )
        self.store.set_selection(
            "schema", normalize_resource_key(self.schema_location), "bob", override["id"]
        )

        response = self.client.post("/validate", json={"xml_string": self.xml})

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["errors"], [])
```

(`unittest`, `tempfile`, `Path`, `FastAPI`, `TestClient`, `MagicMock`, `router`, `get_settings`, `require_authenticated_user`, `get_schema_cache_info` are all already imported at the top of this file from the existing test class — reuse them, don't re-import.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `uv run python tests/unit-test-runner.py tests/unit/fastapi/test_validation_router.py -v`
Expected: `test_no_selection_uses_the_cached_schema` PASSES already (no behavior change needed for the no-override path); `test_selected_override_changes_the_validation_outcome` and `test_another_users_selection_does_not_affect_this_caller` FAIL — the route doesn't consult the store yet, so both currently see empty `errors` (the override is created but never applied), making the "expected...to reject" assertion fail on the first and the second pass only coincidentally.

- [ ] **Step 3: Implement**

In `fastapi_app/routers/validation.py`, add to the imports:

```python
from ..lib.core.dependencies import get_document_rules_store
from ..lib.doc_rules.schema_override import build_schema_text_override
from ..lib.doc_rules.storage import DocumentRulesStore
```

Change the `validate_xml` route:

```python
@router.post("", response_model=ValidateResponse)
def validate_xml(
    request: ValidateRequest,
    settings=Depends(get_settings),
    user: dict = Depends(require_authenticated_user),
    store: DocumentRulesStore = Depends(get_document_rules_store),
) -> ValidateResponse:
    """
    Validate XML document against embedded schema references.

    Supports both XSD (xsi:schemaLocation) and RelaxNG (xml-model) schemas.
    Automatically downloads and caches schemas on first use.
    Uses subprocess isolation for timeout protection on complex schemas.
    If the caller has selected a schema override via the document rules
    registry, validates against that instead of the shared cached schema.

    Returns:
        List of validation errors. Empty list if validation passed.
    """
    try:
        schema_text_override = build_schema_text_override(request.xml_string, store, user["username"])

        # Perform validation using framework-agnostic library
        errors = validate(
            request.xml_string,
            cache_root=settings.schema_cache_dir,
            schema_text_override=schema_text_override,
        )

        # Convert to Pydantic models
        error_models = [
            ValidationErrorModel(
                message=err["message"],
                line=err["line"],
                column=err["column"],
                severity=err.get("severity")
            )
            for err in errors
        ]

        return ValidateResponse(errors=error_models)

    except ValidationError as e:
        if "404" not in str(e) and "Not Found" not in str(e):
            logger.error(f"Validation error: {e}")
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error(f"Unexpected error during validation: {e}")
        raise HTTPException(status_code=500, detail=f"Validation failed: {str(e)}")
```

(Only the function signature, docstring, and the two new lines building `schema_text_override` plus passing it to `validate()` change — the rest of the function body is unchanged.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `uv run python tests/unit-test-runner.py tests/unit/fastapi/test_validation_router.py -v`
Expected: PASS (all tests in the file, including the pre-existing `TestAutocompleteDataInvalidateCache` class and the 3 new tests)

- [ ] **Step 5: Regenerate the API client and confirm it's a no-op**

`ValidateRequest`'s shape is unchanged (still just `xml_string`), so this shouldn't change the generated client at all — confirm that, don't just skip it:

Run: `npm run generate-client:check`
Expected: reports the client is already up to date (no regeneration needed, since the route's request/response schema didn't change)

- [ ] **Step 6: Commit**

```bash
git add fastapi_app/routers/validation.py tests/unit/fastapi/test_validation_router.py
git commit -m "$(cat <<'EOF'
feat(doc-rules): apply the caller's selected schema override in /validate

POST /api/v1/validate now builds schema_text_override from the caller's
document-rules selections before validating, so switching to a schema
override actually changes validation results - completing the seam
added in the previous two tasks.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Full suite and final review

**Files:** none (verification only)

- [ ] **Step 1: Run the full unit suite**

Run: `npm run test:unit`
Expected: PASS. The only pre-existing, unrelated failure this branch has ever shown is `tests/unit/fastapi/test_plugin_tools_sandbox_client.py::TestGenerateSandboxClientScript::test_uses_cached_script_when_source_missing` (confirmed via `git log` to predate this branch, nothing to do with document-rules) — if that's the only failure, this task's work is clean; anything else is a real regression to investigate.

- [ ] **Step 2: Run the API test suite**

Run: `npm run test:api`
Expected: PASS, in particular the existing `tests/api/v1/validate*.test.js` files (grep for the exact filenames first: `ls tests/api/v1/ | grep -i valid`), since this task changed `/api/v1/validate`'s route function.

- [ ] **Step 3: Run the full E2E suite**

Run: `npm run test:e2e`
Expected: PASS. This plan adds no user-visible feature (no frontend creates a schema override yet — that's a later plan), so this is a pure regression check, in particular for any E2E test that exercises document validation (`grep -rl "validate" tests/e2e/tests/*.spec.js`).

- [ ] **Step 4: Manual sanity check against a real document**

Since no frontend exists yet to create an override through the UI, do this check via the API client script instead, against a document already in the demo/dev data if one is running, or skip this step with a note if no server is available: `node scripts/dev/debug-api.js POST /api/v1/validate '{"xml_string": "<TEI xmlns=\"http://www.tei-c.org/ns/1.0\"/>"}'` should still return `{"errors": []}` (or whatever it already returned before this change, since a bare `TEI` root with no schema PI has nothing to override) — this just confirms the route still responds normally end-to-end through a real running server, not just the test client.

- [ ] **Step 5: Report completion**

Summarize for the user: `/api/v1/validate` now honors a caller's selected schema override; the extraction-time contribution/consumer migration (including deleting `config/prompt.json`/`data/db/prompt.json` outright, per the user's confirmation that they were never used), the generalized "Refresh document rules" action, and the frontend are still separate follow-up plans.
