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
from fastapi_app.lib.doc_rules.rules_refresh import RefreshPreconditionError, ResourceRefreshOutcome
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
        self.app.dependency_overrides[require_authenticated_user] = lambda: {"username": "alice", "roles": ["reviewer"]}
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

        # Switch the authenticated user for this one request. bob needs the
        # same reviewer role as alice so these requests reach the ownership
        # check (404) instead of being rejected earlier by the role gate (403).
        self.app.dependency_overrides[require_authenticated_user] = lambda: {"username": "bob", "roles": ["reviewer"]}

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


class TestSelectionsEndpoint(DocumentRulesRouterTestCase):
    def setUp(self):
        super().setUp()
        self.resolve_patcher = patch(
            "fastapi_app.lib.doc_rules.interpretation_ref_kind.InterpretationRefKind.resolve_original",
            return_value="original text",
        )
        self.resolve_patcher.start()
        self.addCleanup(self.resolve_patcher.stop)
        self.url = "https://github.com/mpilhlt/pdf-tei-editor/blob/main/rules.md"

    def test_reports_false_for_a_resource_with_no_selection(self):
        response = self.client.post(
            "/document-rules/selections",
            json={"resources": [{"kind": "interpretation-ref", "url": self.url}]},
        )
        self.assertEqual(response.status_code, 200)
        selections = response.json()["selections"]
        self.assertEqual(selections, [{"kind": "interpretation-ref", "url": self.url, "selected": False}])

    def test_reports_true_once_an_override_is_selected(self):
        create_response = self.client.post(
            "/document-rules/overrides",
            json={"kind": "interpretation-ref", "fragment_url": self.url, "note": ""},
        )
        override_id = create_response.json()["id"]
        self.client.put(
            "/document-rules/selection",
            json={"kind": "interpretation-ref", "fragment_url": self.url, "override_id": override_id},
        )

        response = self.client.post(
            "/document-rules/selections",
            json={"resources": [{"kind": "interpretation-ref", "url": self.url}]},
        )
        selections = response.json()["selections"]
        self.assertEqual(selections, [{"kind": "interpretation-ref", "url": self.url, "selected": True}])

    def test_reports_false_again_after_reset(self):
        create_response = self.client.post(
            "/document-rules/overrides",
            json={"kind": "interpretation-ref", "fragment_url": self.url, "note": ""},
        )
        override_id = create_response.json()["id"]
        self.client.put(
            "/document-rules/selection",
            json={"kind": "interpretation-ref", "fragment_url": self.url, "override_id": override_id},
        )
        self.client.post(
            "/document-rules/selection/reset",
            json={"resources": [{"kind": "interpretation-ref", "url": self.url}]},
        )

        response = self.client.post(
            "/document-rules/selections",
            json={"resources": [{"kind": "interpretation-ref", "url": self.url}]},
        )
        selections = response.json()["selections"]
        self.assertEqual(selections, [{"kind": "interpretation-ref", "url": self.url, "selected": False}])

    def test_handles_multiple_resources_and_an_empty_list(self):
        other_url = "https://github.com/mpilhlt/pdf-tei-editor/blob/main/schema/rng/tei-bib.rng"
        response = self.client.post(
            "/document-rules/selections",
            json={"resources": [
                {"kind": "interpretation-ref", "url": self.url},
                {"kind": "schema", "url": other_url},
            ]},
        )
        selections = response.json()["selections"]
        self.assertEqual(len(selections), 2)
        self.assertTrue(all(s["selected"] is False for s in selections))

        empty_response = self.client.post("/document-rules/selections", json={"resources": []})
        self.assertEqual(empty_response.json()["selections"], [])

    def test_requires_authentication(self):
        self.app.dependency_overrides.pop(require_authenticated_user, None)
        response = self.client.post(
            "/document-rules/selections",
            json={"resources": [{"kind": "interpretation-ref", "url": self.url}]},
        )
        self.assertEqual(response.status_code, 401)


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


class TestProposeChangeUrlEndpoint(DocumentRulesRouterTestCase):
    def test_builds_prefilled_url_for_a_github_blob_url(self):
        response = self.client.post(
            "/document-rules/propose-change-url",
            json={"url": "https://github.com/mpilhlt/pdf-tei-editor/blob/main/rules.md", "text": "new content"},
        )
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertTrue(body["content_prefilled"])
        self.assertTrue(body["url"].startswith("https://github.com/mpilhlt/pdf-tei-editor/edit/main/rules.md?"))
        self.assertIn("new+content", body["url"])
        self.assertEqual(body["text"], "new content")

    def test_builds_unprefilled_edit_url_for_a_gitlab_blob_url(self):
        response = self.client.post(
            "/document-rules/propose-change-url",
            json={"url": "https://gitlab.com/group/project/-/blob/main/rules.md", "text": "new content"},
        )
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertFalse(body["content_prefilled"])
        self.assertEqual(body["url"], "https://gitlab.com/group/project/-/edit/main/rules.md")
        self.assertEqual(body["text"], "new content")

    def test_derelativizes_same_repo_links_before_building_the_url(self):
        """
        A same-repo link this app resolved to its own internal absolute form
        (see fetch_rule_excerpt()) must come back out as the original
        relative link, both in the response's `text` (for the frontend's
        clipboard copy) and in the prefilled URL's `value`.
        """
        response = self.client.post(
            "/document-rules/propose-change-url",
            json={
                "url": "https://github.com/mpilhlt/pdf-tei-editor/blob/main/docs/rules.md",
                "text": "See ![img](https://raw.githubusercontent.com/mpilhlt/pdf-tei-editor/main/docs/img/x.png).",
            },
        )
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body["text"], "See ![img](img/x.png).")
        self.assertIn("img%2Fx.png", body["url"])

    def test_returns_null_url_for_an_unrecognized_host(self):
        response = self.client.post(
            "/document-rules/propose-change-url",
            json={"url": "https://example.com/rules.md", "text": "new content"},
        )
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertIsNone(body["url"])
        self.assertFalse(body["content_prefilled"])

    @patch("fastapi_app.lib.core.git_forge_adapters.requests.get")
    def test_returns_502_when_an_adapter_fails_unexpectedly(self, mock_get):
        mock_get.side_effect = RuntimeError("network down")
        response = self.client.post(
            "/document-rules/propose-change-url",
            json={"url": f"https://github.com/mpilhlt/pdf-tei-editor/blob/{'a' * 40}/rules.md", "text": "x"},
        )
        self.assertEqual(response.status_code, 502)


class TestRefreshResourceEndpoint(DocumentRulesRouterTestCase):
    def setUp(self):
        super().setUp()
        self.file_storage = MagicMock()
        self.app.dependency_overrides[get_file_storage] = lambda: self.file_storage

    def test_requires_reviewer_or_admin_role(self):
        self.app.dependency_overrides[require_authenticated_user] = lambda: {"username": "alice", "roles": ["user"]}
        response = self.client.post("/document-rules/refresh-resource", json={"xml": "tei-1", "url": "https://x"})
        self.assertEqual(response.status_code, 403)

    def test_reports_precondition_error_as_bad_request(self):
        with patch(
            "fastapi_app.routers.document_rules.resolve_refresh_target",
            side_effect=RefreshPreconditionError("No TEI document open."),
        ):
            response = self.client.post("/document-rules/refresh-resource", json={"xml": "missing", "url": "https://x"})
        self.assertEqual(response.status_code, 400)
        self.assertIn("No TEI document open", response.json()["detail"])

    def test_returns_ok_outcome_with_refs(self):
        with patch("fastapi_app.routers.document_rules.resolve_refresh_target") as mock_resolve, \
             patch("fastapi_app.routers.document_rules.plan_resource_refresh") as mock_plan:
            mock_resolve.return_value = MagicMock(tei_content="<TEI/>")
            mock_plan.return_value = ResourceRefreshOutcome(
                status="ok",
                refs=[{"target": "https://new", "content_type": "markdown", "subtype": "human"}],
                changed=True,
                message="Resource refreshed from upstream.",
            )
            response = self.client.post("/document-rules/refresh-resource", json={"xml": "tei-1", "url": "https://old"})
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body["status"], "ok")
        self.assertTrue(body["changed"])
        self.assertEqual(body["refs"][0]["target"], "https://new")

    def test_returns_not_found_outcome(self):
        with patch("fastapi_app.routers.document_rules.resolve_refresh_target") as mock_resolve, \
             patch("fastapi_app.routers.document_rules.plan_resource_refresh") as mock_plan:
            mock_resolve.return_value = MagicMock(tei_content="<TEI/>")
            mock_plan.return_value = ResourceRefreshOutcome(status="not_found", refs=[], changed=False, message="not found")
            response = self.client.post("/document-rules/refresh-resource", json={"xml": "tei-1", "url": "https://old"})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["status"], "not_found")


class TestNonReviewerCannotUseDocumentRulesRoutes(DocumentRulesRouterTestCase):
    def setUp(self):
        super().setUp()
        self.app.dependency_overrides[require_authenticated_user] = lambda: {"username": "alice", "roles": ["user"]}

    def test_list_requires_reviewer_or_admin(self):
        response = self.client.post("/document-rules/list", json={"xml_string": XML_WITH_INTERPRETATION})
        self.assertEqual(response.status_code, 403)

    def test_query_requires_reviewer_or_admin(self):
        response = self.client.post("/document-rules/query", json={"kind": "interpretation-ref", "url": "https://x"})
        self.assertEqual(response.status_code, 403)

    def test_create_override_requires_reviewer_or_admin(self):
        response = self.client.post(
            "/document-rules/overrides",
            json={"kind": "interpretation-ref", "fragment_url": "https://x"},
        )
        self.assertEqual(response.status_code, 403)

    def test_update_override_requires_reviewer_or_admin(self):
        response = self.client.put("/document-rules/overrides/some-id", json={"note": "x"})
        self.assertEqual(response.status_code, 403)

    def test_delete_override_requires_reviewer_or_admin(self):
        response = self.client.delete("/document-rules/overrides/some-id")
        self.assertEqual(response.status_code, 403)

    def test_set_selection_requires_reviewer_or_admin(self):
        response = self.client.put(
            "/document-rules/selection",
            json={"kind": "interpretation-ref", "fragment_url": "https://x"},
        )
        self.assertEqual(response.status_code, 403)

    def test_reset_selection_requires_reviewer_or_admin(self):
        response = self.client.post("/document-rules/selection/reset", json={"resources": []})
        self.assertEqual(response.status_code, 403)

    def test_get_selections_requires_reviewer_or_admin(self):
        response = self.client.post("/document-rules/selections", json={"resources": []})
        self.assertEqual(response.status_code, 403)


if __name__ == "__main__":
    unittest.main()
