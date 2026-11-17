"""
Unit tests for the navigation XPath list: merging the extractor defaults, validating user entries and the REST endpoints.

@testCovers fastapi_app/lib/utils/navigation_xpath.py
@testCovers fastapi_app/routers/navigation_xpath.py
@testCovers fastapi_app/lib/models/models_navigation_xpath.py
"""

import json
import os
import shutil
import tempfile
import unittest
from pathlib import Path
from typing import Any
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from fastapi_app.config import get_settings
from fastapi_app.lib.core.dependencies import require_annotator_reviewer_or_admin, require_authenticated_user
from fastapi_app.lib.utils.navigation_xpath import (
    InvalidXpathError,
    extractor_defaults,
    load_navigation_xpath,
    merge_navigation_xpath,
    save_custom_entries,
    validate_navigation_xpath,
)
from fastapi_app.routers import navigation_xpath as navigation_router

EXTRACTORS: list[dict[str, Any]] = [
    {
        "id": "a",
        "variants": ["v1", "v2"],
        "navigation_xpath": {
            "v1": [{"value": "//tei:listBibl/tei:bibl", "label": "&lt;bibl&gt;"}],
            "v2": [{"value": "//tei:div", "label": "&lt;div&gt;"}, {"value": None, "label": "none"}],
        },
    },
    {"id": "b", "variants": ["v1", "v3"], "navigation_xpath": {"v1": [{"value": "//tei:listBibl/tei:bibl", "label": "dup"}]}},
]


class TestValidation(unittest.TestCase):
    def test_valid(self) -> None:
        for xpath in ["//tei:bibl", "/tei:TEI/tei:text//tei:pb", '//tei:bibl[@type="cited"]', "//tei:*[@xml:id]"]:
            validate_navigation_xpath(xpath)

    def test_invalid(self) -> None:
        for xpath in ["tei:bibl", "//tei:bibl[", "//foo:bar", "count(//tei:bibl)", "//tei:bibl/@type = 'x'"]:
            with self.assertRaises(InvalidXpathError, msg=xpath):
                validate_navigation_xpath(xpath)


class TestMerge(unittest.TestCase):
    def test_defaults_deduplicated_and_not_editable(self) -> None:
        defaults = extractor_defaults(EXTRACTORS)
        self.assertEqual(defaults["v1"], [{"value": "//tei:listBibl/tei:bibl", "label": "&lt;bibl&gt;", "edit": False}])
        self.assertEqual([e["value"] for e in defaults["v2"]], ["//tei:div"])

    def test_merge_keeps_custom_drops_stale_defaults(self) -> None:
        stored = {
            "v1": [
                {"value": "//tei:old", "label": "old", "edit": False},
                {"value": "//tei:listBibl/tei:bibl", "label": "custom duplicate"},
                {"value": "//tei:pb", "label": "&lt;pb&gt;"},
            ],
            "gone": [{"value": "//tei:x", "label": "x", "edit": False}],
            "custom-only": [{"value": "//tei:p", "label": ""}],
        }
        merged = merge_navigation_xpath(stored, extractor_defaults(EXTRACTORS))
        self.assertEqual([e["value"] for e in merged["v1"]], ["//tei:listBibl/tei:bibl", "//tei:pb"])
        self.assertNotIn("gone", merged)
        self.assertEqual(merged["custom-only"], [{"value": "//tei:p", "label": "//tei:p"}])


class TestStorage(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp())

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_load_writes_defaults_into_file(self) -> None:
        data = load_navigation_xpath(self.tmp, EXTRACTORS)
        stored = json.loads((self.tmp / "navigation_xpath.json").read_text())
        self.assertEqual(stored, data)
        self.assertFalse(stored["v1"][0]["edit"])

    def test_save_custom_entries(self) -> None:
        entries = save_custom_entries(self.tmp, EXTRACTORS, "v1", [("//tei:pb", ""), ("//tei:note", "<note> & co")])
        self.assertEqual([e["value"] for e in entries], ["//tei:listBibl/tei:bibl", "//tei:pb", "//tei:note"])
        self.assertEqual(entries[1]["label"], "//tei:pb")
        self.assertEqual(entries[2]["label"], "&lt;note&gt; &amp; co")
        # replacing the list deletes the entries left out
        entries = save_custom_entries(self.tmp, EXTRACTORS, "v1", [("//tei:note", "note")])
        self.assertEqual([e["value"] for e in entries], ["//tei:listBibl/tei:bibl", "//tei:note"])
        self.assertEqual(load_navigation_xpath(self.tmp, EXTRACTORS)["v1"], entries)

    def test_save_rejects_defaults_and_duplicates(self) -> None:
        with self.assertRaises(InvalidXpathError):
            save_custom_entries(self.tmp, EXTRACTORS, "v1", [("//tei:listBibl/tei:bibl", "")])
        with self.assertRaises(InvalidXpathError):
            save_custom_entries(self.tmp, EXTRACTORS, "v1", [("//tei:pb", ""), ("//tei:pb", "again")])
        self.assertFalse((self.tmp / "navigation_xpath.json").exists())


class TestRouter(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp())
        (self.tmp / "db").mkdir()
        self.env = patch.dict(os.environ, {"DATA_ROOT": str(self.tmp)})
        self.env.start()
        get_settings.cache_clear()
        app = FastAPI()
        app.include_router(navigation_router.router)
        user = {"username": "alice", "roles": ["annotator"]}
        app.dependency_overrides[require_authenticated_user] = lambda: user
        app.dependency_overrides[require_annotator_reviewer_or_admin] = lambda: user
        app.dependency_overrides[navigation_router.get_extractors] = lambda: EXTRACTORS
        self.client = TestClient(app)

    def tearDown(self) -> None:
        self.env.stop()
        get_settings.cache_clear()
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_list_and_save(self) -> None:
        response = self.client.get("/navigation-xpath")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["variants"]["v1"][0]["edit"], False)

        response = self.client.put("/navigation-xpath/v1", json={"entries": [{"value": " //tei:pb ", "label": ""}]})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["entries"][1], {"value": "//tei:pb", "label": "//tei:pb", "edit": True})
        self.assertTrue((self.tmp / "db" / "navigation_xpath.json").exists())

    def test_save_errors(self) -> None:
        self.assertEqual(self.client.put("/navigation-xpath/unknown", json={"entries": []}).status_code, 404)
        response = self.client.put("/navigation-xpath/v1", json={"entries": [{"value": "//tei:bibl["}]})
        self.assertEqual(response.status_code, 422)
        self.assertIn("Invalid XPath", response.json()["detail"])


if __name__ == "__main__":
    unittest.main()
