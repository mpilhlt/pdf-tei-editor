"""
Integration tests for the document rules REST router.

@testCovers fastapi_app/routers/document_rules.py
"""

import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from fastapi_app.lib.core.database import DatabaseManager
from fastapi_app.lib.core.dependencies import get_file_storage, require_authenticated_user
from fastapi_app.lib.doc_rules.rules_refresh import RefreshPreconditionError
from fastapi_app.routers.document_rules import get_db, router

XML_WITH_INTERPRETATION = """<?xml version="1.0"?>
<TEI xmlns="http://www.tei-c.org/ns/1.0">
  <teiHeader><encodingDesc><editorialDecl>
    <interpretation type="primary" n="Primary rules">
      <p><ref target="https://github.com/mpilhlt/pdf-tei-editor/blob/main/rules.md" subtype="human" type="markdown"/></p>
    </interpretation>
  </editorialDecl></encodingDesc></teiHeader>
</TEI>"""


class DocumentRulesRouterTestCase(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.db = DatabaseManager(Path(self.temp_dir.name) / "test.db")

        self.app = FastAPI()
        self.app.include_router(router)
        self.app.dependency_overrides[get_db] = lambda: self.db
        self.app.dependency_overrides[require_authenticated_user] = lambda: {"username": "alice"}
        self.client = TestClient(self.app)

    def tearDown(self):
        self.temp_dir.cleanup()


class TestListEndpoint(DocumentRulesRouterTestCase):
    def test_list_finds_interpretation_ref_resource(self):
        response = self.client.post("/document-rules/list", json={"xml_string": XML_WITH_INTERPRETATION})
        self.assertEqual(response.status_code, 200)
        resources = response.json()["resources"]
        self.assertEqual(len(resources), 1)
        self.assertEqual(resources[0]["kind"], "interpretation-ref")
        self.assertEqual(resources[0]["label"], "Primary rules")

    def test_list_empty_document_returns_no_resources(self):
        response = self.client.post(
            "/document-rules/list",
            json={"xml_string": "<TEI xmlns='http://www.tei-c.org/ns/1.0'/>"},
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["resources"], [])


class TestQueryAndOverrideLifecycle(DocumentRulesRouterTestCase):
    def setUp(self):
        super().setUp()
        self.resolve_patcher = patch(
            "fastapi_app.lib.doc_rules.interpretation_ref_kind.InterpretationRefKind.resolve_original",
            return_value="original text",
        )
        self.resolve_patcher.start()
        self.addCleanup(self.resolve_patcher.stop)
        self.url = "https://github.com/mpilhlt/pdf-tei-editor/blob/main/rules.md"

    def test_query_with_no_overrides(self):
        response = self.client.post(
            "/document-rules/query", json={"kind": "interpretation-ref", "url": self.url}
        )
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body["original_text"], "original text")
        self.assertEqual(body["overrides"], [])
        self.assertIsNone(body["selected_override_id"])

    def test_create_update_select_and_delete_override(self):
        create_response = self.client.post(
            "/document-rules/overrides",
            json={"kind": "interpretation-ref", "fragment_url": self.url, "note": "first note"},
        )
        self.assertEqual(create_response.status_code, 200)
        override = create_response.json()
        self.assertEqual(override["text"], "original text")  # defaulted
        self.assertEqual(override["note"], "first note")
        self.assertEqual(override["format"], "markdown")

        update_response = self.client.put(
            f"/document-rules/overrides/{override['id']}",
            json={"note": "updated note", "text": "edited text"},
        )
        self.assertEqual(update_response.status_code, 200)
        self.assertEqual(update_response.json()["text"], "edited text")

        select_response = self.client.put(
            "/document-rules/selection",
            json={"kind": "interpretation-ref", "fragment_url": self.url, "override_id": override["id"]},
        )
        self.assertEqual(select_response.status_code, 200)

        query_response = self.client.post(
            "/document-rules/query", json={"kind": "interpretation-ref", "url": self.url}
        )
        self.assertEqual(query_response.json()["selected_override_id"], override["id"])

        reset_response = self.client.post(
            "/document-rules/selection/reset",
            json={"resources": [{"kind": "interpretation-ref", "url": self.url}]},
        )
        self.assertEqual(reset_response.status_code, 200)
        query_after_reset = self.client.post(
            "/document-rules/query", json={"kind": "interpretation-ref", "url": self.url}
        )
        self.assertIsNone(query_after_reset.json()["selected_override_id"])
        # The override itself must survive a reset.
        self.assertEqual(len(query_after_reset.json()["overrides"]), 1)

        delete_response = self.client.delete(f"/document-rules/overrides/{override['id']}")
        self.assertEqual(delete_response.status_code, 200)

    def test_cannot_update_or_delete_someone_elses_override(self):
        create_response = self.client.post(
            "/document-rules/overrides",
            json={"kind": "interpretation-ref", "fragment_url": self.url, "note": "alice's"},
        )
        override_id = create_response.json()["id"]

        # Switch the authenticated user for this one request.
        self.app.dependency_overrides[require_authenticated_user] = lambda: {"username": "bob"}

        update_response = self.client.put(
            f"/document-rules/overrides/{override_id}", json={"note": "hijacked"}
        )
        self.assertEqual(update_response.status_code, 404)

        delete_response = self.client.delete(f"/document-rules/overrides/{override_id}")
        self.assertEqual(delete_response.status_code, 404)

    def test_cannot_select_an_override_for_a_different_resource(self):
        create_response = self.client.post(
            "/document-rules/overrides",
            json={"kind": "interpretation-ref", "fragment_url": self.url, "note": "for this resource"},
        )
        override_id = create_response.json()["id"]

        select_response = self.client.put(
            "/document-rules/selection",
            json={
                "kind": "schema",
                "fragment_url": "https://example.com/other-schema.rng",
                "override_id": override_id,
            },
        )
        self.assertEqual(select_response.status_code, 400)

    def test_unknown_resource_kind_returns_400(self):
        response = self.client.post(
            "/document-rules/query", json={"kind": "no-such-kind", "url": self.url}
        )
        self.assertEqual(response.status_code, 400)


class TestRefreshEndpoints(DocumentRulesRouterTestCase):
    def setUp(self):
        super().setUp()
        self.file_storage = MagicMock()
        self.app.dependency_overrides[get_file_storage] = lambda: self.file_storage

    def _set_user_roles(self, roles):
        self.app.dependency_overrides[require_authenticated_user] = lambda: {"username": "alice", "roles": roles}

    def test_preview_requires_reviewer_or_admin_role(self):
        self._set_user_roles(["user"])
        response = self.client.post("/document-rules/refresh/preview", json={"xml": "tei-1"})
        self.assertEqual(response.status_code, 403)

    def test_execute_requires_reviewer_or_admin_role(self):
        self._set_user_roles(["user"])
        response = self.client.post("/document-rules/refresh/execute", json={"xml": "tei-1"})
        self.assertEqual(response.status_code, 403)

    def test_preview_reports_precondition_error_as_bad_request(self):
        self._set_user_roles(["reviewer"])
        with patch(
            "fastapi_app.routers.document_rules.resolve_refresh_target",
            side_effect=RefreshPreconditionError("No TEI document open."),
        ):
            response = self.client.post("/document-rules/refresh/preview", json={"xml": "missing"})
        self.assertEqual(response.status_code, 400)
        self.assertIn("No TEI document open", response.json()["detail"])

    def test_preview_reports_unavailable_when_no_provider(self):
        self._set_user_roles(["reviewer"])
        with patch("fastapi_app.routers.document_rules.resolve_refresh_target") as mock_resolve, \
             patch("fastapi_app.routers.document_rules.preview_refresh") as mock_preview:
            mock_resolve.return_value = MagicMock()
            mock_preview.return_value = MagicMock(
                available=False, changed=False, entry_count=0, variant_id=None,
                message="No rule-refresh provider for this document's extractor.",
            )
            response = self.client.post("/document-rules/refresh/preview", json={"xml": "tei-1"})
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertFalse(body["available"])

    def test_execute_calls_perform_refresh_and_returns_outcome(self):
        self._set_user_roles(["admin"])
        with patch("fastapi_app.routers.document_rules.resolve_refresh_target") as mock_resolve, \
             patch(
                 "fastapi_app.routers.document_rules.perform_refresh",
                 new=AsyncMock(return_value=MagicMock(
                     available=True, changed=True, entry_count=2,
                     variant_id="grobid.training.segmentation", message="Updated the annotation rules reference.",
                 )),
             ):
            mock_resolve.return_value = MagicMock()
            response = self.client.post("/document-rules/refresh/execute", json={"xml": "tei-1"})
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertTrue(body["changed"])
        self.assertEqual(body["entry_count"], 2)

    def test_execute_reports_runtime_error_as_unprocessable(self):
        self._set_user_roles(["reviewer"])
        with patch("fastapi_app.routers.document_rules.resolve_refresh_target") as mock_resolve, \
             patch(
                 "fastapi_app.routers.document_rules.perform_refresh",
                 new=AsyncMock(side_effect=RuntimeError("Could not parse document XML for refresh: boom")),
             ):
            mock_resolve.return_value = MagicMock()
            response = self.client.post("/document-rules/refresh/execute", json={"xml": "tei-1"})
        self.assertEqual(response.status_code, 422)
        self.assertIn("Could not parse document XML for refresh", response.json()["detail"])


if __name__ == "__main__":
    unittest.main()
