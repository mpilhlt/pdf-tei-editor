"""
Unit tests for the validation router's autocomplete-data endpoint.

Covers the schema cache invalidation behavior: `invalidate_cache=True` must
force a re-download of the schema file itself, not just the derived
autocomplete JSON.

@testCovers fastapi_app/routers/validation.py:generate_autocomplete_data
"""

import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from fastapi_app.routers.validation import router, resolve_document_schema_cache_file
from fastapi_app.config import get_settings
from fastapi_app.lib.core.dependencies import require_authenticated_user
from fastapi_app.lib.core.schema_validator import get_schema_cache_info
from fastapi_app.lib.core.database import DatabaseManager
from fastapi_app.lib.core.dependencies import get_document_rules_store
from fastapi_app.lib.doc_rules.resource_key import normalize_resource_key
from fastapi_app.lib.doc_rules.storage import DocumentRulesStore

RELAXNG_SCHEMA = """<?xml version="1.0" encoding="UTF-8"?>
<grammar xmlns="http://relaxng.org/ns/structure/1.0">
  <start>
    <element name="root">
      <text/>
    </element>
  </start>
</grammar>
"""

SCHEMA_LOCATION = "https://example.com/schema/tei.rng"

XML_WITH_RELAXNG_MODEL = f"""<?xml version="1.0"?>
<?xml-model href="{SCHEMA_LOCATION}" schematypens="http://relaxng.org/ns/structure/1.0"?>
<root xmlns="http://www.tei-c.org/ns/1.0">test</root>
"""


class TestAutocompleteDataInvalidateCache(unittest.TestCase):
    """Test that invalidate_cache also busts the underlying schema file cache."""

    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.cache_root = Path(self.temp_dir.name)

        self.schema_cache_dir, self.schema_cache_file, _ = get_schema_cache_info(
            SCHEMA_LOCATION, self.cache_root
        )
        self.schema_cache_dir.mkdir(parents=True)
        self.schema_cache_file.write_text(RELAXNG_SCHEMA)

        self.autocomplete_cache_file = self.schema_cache_dir / "codemirror-autocomplete.json"
        self.autocomplete_cache_file.write_text(json.dumps({"root": {}}))

        self.app = FastAPI()
        self.app.include_router(router)

        self.mock_settings = MagicMock()
        self.mock_settings.schema_cache_dir = self.cache_root

        self.app.dependency_overrides[get_settings] = lambda: self.mock_settings
        self.app.dependency_overrides[require_authenticated_user] = lambda: {"username": "testuser"}

        self.client = TestClient(self.app)

    def tearDown(self):
        self.temp_dir.cleanup()

    @patch("fastapi_app.routers.validation.has_internet", return_value=True)
    @patch("fastapi_app.lib.core.schema_validator.download_schema_file")
    @patch("fastapi_app.routers.validation.generate_autocomplete_map")
    def test_invalidate_cache_redownloads_schema_file(
        self, mock_generate, mock_download, _mock_internet
    ):
        mock_generate.return_value = {"root": {}}

        response = self.client.post(
            "/validate/autocomplete-data",
            json={"xml_string": XML_WITH_RELAXNG_MODEL, "invalidate_cache": True},
        )

        self.assertEqual(response.status_code, 200)
        mock_download.assert_called_once()

    @patch("fastapi_app.routers.validation.has_internet", return_value=True)
    @patch("fastapi_app.lib.core.schema_validator.download_schema_file")
    def test_without_invalidate_cache_uses_cached_autocomplete_data(
        self, mock_download, _mock_internet
    ):
        response = self.client.post(
            "/validate/autocomplete-data",
            json={"xml_string": XML_WITH_RELAXNG_MODEL, "invalidate_cache": False},
        )

        self.assertEqual(response.status_code, 200)
        mock_download.assert_not_called()


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


class TestResolveDocumentSchemaCacheFile(unittest.TestCase):
    """Test the shared schema-resolution helper used by /autocomplete-data
    and the upcoming /teiheader-structure endpoint."""

    def test_raises_on_missing_schema_location(self):
        with self.assertRaises(HTTPException) as ctx:
            resolve_document_schema_cache_file(
                '<TEI xmlns="http://www.tei-c.org/ns/1.0"><teiHeader/></TEI>',
                cache_root=Path(tempfile.mkdtemp()),
                invalidate_cache=False,
            )
        self.assertEqual(ctx.exception.status_code, 400)


if __name__ == "__main__":
    unittest.main()
