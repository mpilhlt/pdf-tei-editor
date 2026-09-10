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

from fastapi import FastAPI
from fastapi.testclient import TestClient

from fastapi_app.routers.validation import router
from fastapi_app.config import get_settings
from fastapi_app.lib.core.dependencies import require_authenticated_user
from fastapi_app.lib.core.schema_validator import get_schema_cache_info

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


if __name__ == "__main__":
    unittest.main()
