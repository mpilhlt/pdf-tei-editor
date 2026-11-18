"""
Unit tests for the line layout registry and the layout route.

@testCovers fastapi_app/lib/tei/layout.py
@testCovers fastapi_app/routers/files_layout.py
"""

import unittest
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from fastapi_app.lib.core.dependencies import get_file_repository, get_file_storage, require_authenticated_user
from fastapi_app.lib.tei.layout import (
    LineLayout,
    get_line_layout,
    get_zone_labels,
    has_layout_provider,
    register_layout_provider,
    unregister_layout_provider,
)
from fastapi_app.routers.files_layout import router

VARIANT = "test.zones"


class TestRegistry(unittest.TestCase):
    def tearDown(self):
        unregister_layout_provider(VARIANT)

    def test_provider_is_called_with_content_and_doc_id(self):
        calls = []

        def provider(xml: str, doc_id: str) -> LineLayout:
            calls.append((xml, doc_id))
            return LineLayout([0, 0, 1], [[], ["bold"], []])

        self.assertFalse(has_layout_provider(VARIANT))
        register_layout_provider(VARIANT, "test", provider)
        self.assertTrue(has_layout_provider(VARIANT))
        layout = get_line_layout("<TEI/>", "doc1", VARIANT)
        self.assertEqual(layout, LineLayout([0, 0, 1], [[], ["bold"], []]))
        self.assertEqual(calls, [("<TEI/>", "doc1")])
        self.assertIsNone(get_line_layout("<TEI/>", "doc1", "other"))

    def test_failing_provider_means_no_layout(self):
        def provider(xml: str, doc_id: str) -> LineLayout:
            raise RuntimeError("broken")

        register_layout_provider(VARIANT, "test", provider)
        with self.assertLogs("fastapi_app.lib.tei.layout", level="WARNING"):
            self.assertIsNone(get_line_layout("<TEI/>", "doc1", VARIANT))

    def test_unknown_hints_are_refused(self):
        with self.assertRaises(ValueError):
            LineLayout([0], [["sparkly"]])

    def test_zone_labels_from_extractor_info(self):
        infos = [
            {"id": "a"},
            {"id": "b", "zoneLabels": {VARIANT: [{"code": "note:headnote", "element": "note", "attributes": {"place": "headnote"}}]}},
        ]
        labels = get_zone_labels(VARIANT, infos)
        assert labels is not None
        self.assertEqual(labels[0].open_tag(), '<note place="headnote">')
        self.assertIsNone(get_zone_labels("other", infos))
        self.assertIsNone(get_zone_labels(None, infos))


class TestMessageExcerpts(unittest.TestCase):
    """The message indexer locates page units through the layout registry."""

    def tearDown(self):
        unregister_layout_provider(VARIANT)

    def test_page_excerpts(self):
        import json
        from pathlib import Path

        from lxml import etree

        from fastapi_app.lib.messages.indexer import _unit_order_and_excerpts

        fixtures = Path(__file__).parent.parent / "fixtures" / "zone-lines"
        layout = json.loads((fixtures / "segmentation-sample.layout.json").read_text(encoding="utf-8"))
        expected = json.loads((fixtures / "segmentation-sample.expected.json").read_text(encoding="utf-8"))
        root = etree.fromstring((fixtures / "segmentation-sample.tei.xml").read_bytes())
        register_layout_provider(VARIANT, "test", lambda xml, doc_id: LineLayout(layout["pages"]))
        file = SimpleNamespace(variant=VARIANT, doc_id="doc1")
        with patch("fastapi_app.lib.messages.indexer.get_zone_labels", return_value=get_zone_labels(VARIANT, [{"zoneLabels": {VARIANT: layout["labels"]}}])):
            order, excerpts = _unit_order_and_excerpts(root, file, "pages")
        fingerprints = [p["fingerprint"] for p in expected["pages"]]
        self.assertEqual(list(order), fingerprints)
        self.assertTrue(excerpts[fingerprints[2]].startswith("Page 3: 2 Doe and Roe"))


class TestRoute(unittest.TestCase):
    def setUp(self):
        self.file = SimpleNamespace(id="hash1", stable_id="s1", file_type="tei", variant=VARIANT, doc_id="doc1")
        self.repo = MagicMock()
        self.repo.get_file_by_stable_id.side_effect = lambda sid: self.file if sid == "s1" else None
        self.storage = MagicMock()
        self.storage.read_file.return_value = b"<TEI/>"
        app = FastAPI()
        app.include_router(router)
        app.dependency_overrides[require_authenticated_user] = lambda: {"username": "alice", "roles": ["annotator"]}
        app.dependency_overrides[get_file_repository] = lambda: self.repo
        app.dependency_overrides[get_file_storage] = lambda: self.storage
        self.client = TestClient(app)
        patcher = patch("fastapi_app.routers.files_layout.check_file_access", return_value=True)
        self.access = patcher.start()
        self.addCleanup(patcher.stop)

    def tearDown(self):
        unregister_layout_provider(VARIANT)

    def test_layout(self):
        register_layout_provider(VARIANT, "test", lambda xml, doc_id: LineLayout([0, 1], [["top"], []]))
        response = self.client.get("/files/s1/layout")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"status": "ok", "pages": [0, 1], "hints": [["top"], []], "message": None})

    def test_missing(self):
        register_layout_provider(VARIANT, "test", lambda xml, doc_id: None)
        body = self.client.get("/files/s1/layout").json()
        self.assertEqual(body["status"], "missing")
        self.assertIn("layout information", body["message"])

    def test_unsupported(self):
        self.assertEqual(self.client.get("/files/s1/layout").json()["status"], "unsupported")

    def test_not_found_and_forbidden(self):
        self.assertEqual(self.client.get("/files/nope/layout").status_code, 404)
        self.access.return_value = False
        self.assertEqual(self.client.get("/files/s1/layout").status_code, 403)


if __name__ == "__main__":
    unittest.main()
