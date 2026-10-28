"""
Integration tests for the document rules REST router.

@testCovers fastapi_app/routers/document_rules.py
"""

import hashlib
import tempfile
import unittest
from pathlib import Path
from typing import Optional
from unittest.mock import AsyncMock, MagicMock, patch

import requests
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from fastapi_app.lib.core.database import DatabaseManager
from fastapi_app.lib.core.git_forge_adapters import GitHubAdapter
from fastapi_app.lib.core.dependencies import get_file_storage, require_authenticated_user
from fastapi_app.lib.doc_rules.guide_update import ALIGN_PROMPT_TEMPLATE, DELTA_PROMPT_TEMPLATE
from fastapi_app.lib.doc_rules.resource_key import normalize_resource_key
from fastapi_app.lib.doc_rules.rules_refresh import RefreshPreconditionError, ResourceRefreshOutcome
from fastapi_app.lib.doc_rules.storage import DocumentRulesStore
from fastapi_app.lib.doc_rules.github_pull_request import GITHUB_SECRET_SERVICE, GitHubError, PullRequestResult, register_github_secret_service
from fastapi_app.lib.doc_rules.upstream_cleanup import CategoryNotFoundError, LayerUpstreamStatus, UpstreamStatus
from fastapi_app.lib.doc_rules.upstream_proposal import ProposalError, ProposedFile, UpstreamProposal
from fastapi_app.lib.llm import LLMModel, LLMProvider, LLMProviderError, LLMProviderRegistry
from fastapi_app.lib.llm.model_access import ModelAccessDenied
from fastapi_app.lib.secrets import MissingSecretError, unregister_secret_service
from fastapi_app.lib.utils.annotation_rules_utils import RuleFetchError, _rewrite_relative_markdown_urls, markdown_section_range
from fastapi_app.routers.document_rules import _document_tei_or_http_error, get_db, router

FIXTURES = Path(__file__).parent / "fixtures" / "fossil"
HUMAN_FILE = (FIXTURES / "guidelines.md").read_text(encoding="utf-8")
MACHINE_FILE = (FIXTURES / "guidelines-llm.md").read_text(encoding="utf-8")
PROPOSAL_SHA = "eab669d4d093c54dd1990b4a0bf017d00f82d5a8"
PROPOSAL_REPO = "https://github.com/mpilhlt/fossil/blob"

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
        self.assertEqual(resources[0]["layer"], "human")
        self.assertEqual(resources[0]["group"], "interpretation-ref:primary")

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

    @patch("fastapi_app.routers.document_rules.fetch_rule_excerpt")
    def test_splices_a_line_range_excerpt_into_the_full_upstream_file(self, mock_fetch):
        """A machine-rules excerpt (#Lx-Ly) is proposed as the whole file with only that range replaced."""
        mock_fetch.return_value = "line 1\nline 2\nline 3\nline 4\n"
        response = self.client.post(
            "/document-rules/propose-change-url",
            json={"url": "https://github.com/mpilhlt/pdf-tei-editor/blob/main/rules.md#L2-L3", "text": "edited"},
        )
        self.assertEqual(response.status_code, 200)
        mock_fetch.assert_called_once()
        self.assertEqual(mock_fetch.call_args.args[0], "https://github.com/mpilhlt/pdf-tei-editor/blob/main/rules.md")
        body = response.json()
        self.assertEqual(body["text"], "line 1\nedited\nline 4\n")
        self.assertIn("line+1%0Aedited%0Aline+4", body["url"])

    @patch("fastapi_app.routers.document_rules.fetch_rule_excerpt")
    def test_returns_502_when_the_full_file_cannot_be_fetched_for_splicing(self, mock_fetch):
        mock_fetch.side_effect = RuntimeError("network down")
        with self.assertLogs("fastapi_app.routers.document_rules", level="ERROR"):
            response = self.client.post(
                "/document-rules/propose-change-url",
                json={"url": "https://github.com/mpilhlt/pdf-tei-editor/blob/main/rules.md#L2-L3", "text": "x"},
            )
        self.assertEqual(response.status_code, 502)

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


RULES_BASE = "https://github.com/mpilhlt/pdf-tei-editor/blob/main/rules.md"
RULES_MARKDOWN = "# Title\n\nintro\n\n## Section A\n\nrule a\n\n## Section B\n\nrule b\n"


class TestHeadingAnchorKeys(DocumentRulesRouterTestCase):
    """Overrides keyed by file + heading anchor: read routes never move legacy keys, strict keys on writes, outdated flag, selected-override lookup."""

    def setUp(self):
        super().setUp()
        self.store = DocumentRulesStore(self.db)
        # resource_key() fetches the whole file; resolve_original() goes through fetch_rule_section()
        self.kind_fetch = patch(
            "fastapi_app.lib.doc_rules.interpretation_ref_kind.fetch_rule_excerpt", return_value=RULES_MARKDOWN
        ).start()
        self.utils_fetch = patch(
            "fastapi_app.lib.utils.annotation_rules_utils.fetch_rule_excerpt", return_value=RULES_MARKDOWN
        ).start()
        self.addCleanup(patch.stopall)

    def _create(self, url: str, base_hash: str, text: str = "override text") -> dict:
        return self.store.create_override(
            "interpretation-ref", normalize_resource_key(url), "alice", "", text, "markdown", url, base_hash
        )

    def _query(self, url: str):
        return self.client.post("/document-rules/query", json={"kind": "interpretation-ref", "url": url})

    def test_query_does_not_move_legacy_line_range_override(self):
        # Legacy rows are moved at startup (legacy_key_migration.py); read routes never write
        url = f"{RULES_BASE}#L5-L8"
        legacy = self._create(url, base_hash="")
        self.store.set_selection("interpretation-ref", normalize_resource_key(url), "alice", legacy["id"])

        response = self._query(url)

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["overrides"], [])
        self.assertEqual(self.store.get_override(legacy["id"])["resource_key"], normalize_resource_key(url))
        self.assertEqual(self.store.get_selection("interpretation-ref", normalize_resource_key(url), "alice"), legacy["id"])

    def test_selection_with_fetch_failure_returns_502(self):
        url = f"{RULES_BASE}#L5-L8"
        override = self._create(f"{RULES_BASE}#section-a", base_hash="")
        self.kind_fetch.side_effect = RuleFetchError("boom")
        with self.assertLogs("fastapi_app.routers.document_rules", level="ERROR"):
            response = self.client.put(
                "/document-rules/selection",
                json={"kind": "interpretation-ref", "fragment_url": url, "override_id": override["id"]},
            )
        self.assertEqual(response.status_code, 502)
        self.assertIn("Could not fetch", response.json()["detail"])

    def test_selections_with_fetch_failure_falls_back_to_legacy_key(self):
        url = f"{RULES_BASE}#L5-L8"
        legacy = self._create(url, base_hash="")
        self.store.set_selection("interpretation-ref", normalize_resource_key(url), "alice", legacy["id"])
        self.kind_fetch.side_effect = RuleFetchError("boom")
        with self.assertLogs("fastapi_app.lib.doc_rules.interpretation_ref_kind", level="WARNING"):
            response = self.client.post(
                "/document-rules/selections", json={"resources": [{"kind": "interpretation-ref", "url": url}]}
            )
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.json()["selections"][0]["selected"])

    def test_query_marks_outdated_override(self):
        url = f"{RULES_BASE}#section-a"
        section = "## Section A\n\nrule a\n"
        current = self._create(url, base_hash=hashlib.sha256(section.encode("utf-8")).hexdigest())
        stale = self._create(url, base_hash=hashlib.sha256(b"older section").hexdigest())

        body = self._query(url).json()

        self.assertEqual(body["original_text"], section)
        outdated = {o["id"]: o["outdated"] for o in body["overrides"]}
        self.assertEqual(outdated, {current["id"]: False, stale["id"]: True})

    def test_update_with_fragment_url_clears_outdated(self):
        url = f"{RULES_BASE}#section-a"
        stale = self._create(url, base_hash=hashlib.sha256(b"older section").hexdigest())
        self.assertTrue(self._query(url).json()["overrides"][0]["outdated"])

        response = self.client.put(f"/document-rules/overrides/{stale['id']}", json={"text": "edited", "fragment_url": url})

        self.assertEqual(response.status_code, 200)
        self.assertFalse(response.json()["outdated"])
        override = self._query(url).json()["overrides"][0]
        self.assertEqual(override["text"], "edited")
        self.assertFalse(override["outdated"])

    def test_update_without_fragment_url_keeps_outdated(self):
        url = f"{RULES_BASE}#section-a"
        stale = self._create(url, base_hash=hashlib.sha256(b"older section").hexdigest())
        self.client.put(f"/document-rules/overrides/{stale['id']}", json={"text": "edited"})
        self.assertTrue(self._query(url).json()["overrides"][0]["outdated"])

    def test_update_with_fragment_url_of_another_resource_returns_400(self):
        stale = self._create(f"{RULES_BASE}#section-a", base_hash="")
        response = self.client.put(
            f"/document-rules/overrides/{stale['id']}", json={"text": "edited", "fragment_url": f"{RULES_BASE}#section-b"}
        )
        self.assertEqual(response.status_code, 400)
        self.assertEqual(self.store.get_override(stale["id"])["text"], "override text")

    def test_query_does_not_mark_migrated_override_outdated(self):
        url = f"{RULES_BASE}#section-a"
        migrated = self._create(url, base_hash="")
        body = self._query(url).json()
        self.assertEqual(body["overrides"][0]["id"], migrated["id"])
        self.assertFalse(body["overrides"][0]["outdated"])

    def test_query_unknown_heading_returns_502(self):
        with self.assertLogs("fastapi_app.routers.document_rules", level="ERROR"):
            response = self._query(f"{RULES_BASE}#no-such-heading")
        self.assertEqual(response.status_code, 502)

    def test_selected_override_returns_selected_text_without_fetch(self):
        url = f"{RULES_BASE}#section-a"
        override = self._create(url, base_hash="", text="my section")
        self.store.set_selection("interpretation-ref", normalize_resource_key(url), "alice", override["id"])

        response = self.client.post(
            "/document-rules/selected-override", json={"kind": "interpretation-ref", "url": url}
        )

        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body["override"]["id"], override["id"])
        self.assertEqual(body["override"]["text"], "my section")
        self.assertFalse(body["override"]["outdated"])
        self.kind_fetch.assert_not_called()
        self.utils_fetch.assert_not_called()

    def test_selected_override_is_null_without_selection(self):
        response = self.client.post(
            "/document-rules/selected-override", json={"kind": "interpretation-ref", "url": f"{RULES_BASE}#section-a"}
        )
        self.assertEqual(response.status_code, 200)
        self.assertIsNone(response.json()["override"])

    @patch("fastapi_app.routers.document_rules.fetch_rule_excerpt")
    def test_propose_change_url_splices_heading_section(self, mock_fetch):
        mock_fetch.return_value = RULES_MARKDOWN
        response = self.client.post(
            "/document-rules/propose-change-url",
            # The section as /query returns it: up to the line before the next heading
            json={"url": f"{RULES_BASE}#section-a", "text": "## Section A\n\nedited a\n\n"},
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(mock_fetch.call_args.args[0], RULES_BASE)
        self.assertEqual(
            response.json()["text"],
            "# Title\n\nintro\n\n## Section A\n\nedited a\n\n## Section B\n\nrule b\n",
        )


class TestNonReviewerCannotUseDocumentRulesRoutes(DocumentRulesRouterTestCase):
    def setUp(self):
        super().setUp()
        self.app.dependency_overrides[require_authenticated_user] = lambda: {"username": "alice", "roles": ["user"]}

    def test_selected_override_requires_reviewer_or_admin(self):
        response = self.client.post(
            "/document-rules/selected-override", json={"kind": "interpretation-ref", "url": "https://x"}
        )
        self.assertEqual(response.status_code, 403)

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


class TestSyncStatusEndpoint(DocumentRulesRouterTestCase):
    HUMAN_URL = "https://github.com/mpilhlt/fossil/blob/eab669d4d093c54dd1990b4a0bf017d00f82d5a8/docs/guidelines.md#data-correction"
    MACHINE_URL = "https://github.com/mpilhlt/fossil/blob/eab669d4d093c54dd1990b4a0bf017d00f82d5a8/docs/guidelines-llm.md#data-correction"

    def setUp(self):
        super().setUp()
        fixtures = Path(__file__).parent / "fixtures" / "fossil"
        raw_dir = "https://raw.githubusercontent.com/mpilhlt/fossil/eab669d4d093c54dd1990b4a0bf017d00f82d5a8/docs/"
        self.human = _rewrite_relative_markdown_urls(
            self._slice((fixtures / "guidelines.md").read_text(encoding="utf-8")), raw_dir
        )
        self.machine = self._slice((fixtures / "guidelines-llm.md").read_text(encoding="utf-8"))
        self.texts = {self.HUMAN_URL: self.human, self.MACHINE_URL: self.machine}
        for target, kwargs in (
            ("resolve_original", {"side_effect": lambda url: self.texts[url]}),
            ("resource_key", {"side_effect": lambda url, **kw: normalize_resource_key(url)}),
        ):
            patcher = patch(f"fastapi_app.lib.doc_rules.interpretation_ref_kind.InterpretationRefKind.{target}", **kwargs)
            patcher.start()
            self.addCleanup(patcher.stop)

    @staticmethod
    def _slice(text: str) -> str:
        start, end = markdown_section_range(text, "data-correction")
        return "\n".join(text.splitlines()[start - 1:end])

    def _post(self):
        return self.client.post(
            "/document-rules/sync-status", json={"human_url": self.HUMAN_URL, "machine_url": self.MACHINE_URL}
        )

    def _select_override(self, url: str, text: str) -> None:
        store = DocumentRulesStore(self.db)
        key = normalize_resource_key(url)
        override = store.create_override(
            kind="interpretation-ref", resource_key=key, owner="alice", note="", text=text,
            format="markdown", base_url=url, base_hash="",
        )
        store.set_selection("interpretation-ref", key, "alice", override["id"])

    def test_in_sync_for_originals(self):
        with patch("fastapi_app.routers.document_rules.find_synced_human_commit") as find:
            response = self._post()
        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            response.json(),
            {"status": "in_sync", "human_source": "original", "machine_source": "original", "base": None, "synced_commit": None},
        )
        find.assert_not_called()

    def test_human_override_makes_machine_outdated(self):
        self._select_override(self.HUMAN_URL, self.human + "\nAn extra rule.\n")
        with patch("fastapi_app.routers.document_rules.find_synced_human_commit", return_value="abc123"):
            response = self._post()
        body = response.json()
        self.assertEqual(body["status"], "machine_outdated")
        self.assertEqual(body["human_source"], "override")
        self.assertEqual(body["machine_source"], "original")
        self.assertEqual(body["synced_commit"], "abc123")

    def test_machine_override_is_reported_as_machine_edited(self):
        self._select_override(self.MACHINE_URL, self.machine + "\nAn extra machine rule.\n")
        with patch("fastapi_app.routers.document_rules.find_synced_human_commit") as find:
            response = self._post()
        body = response.json()
        self.assertEqual(body["status"], "machine_edited")
        self.assertEqual(body["human_source"], "original")
        self.assertEqual(body["machine_source"], "override")
        find.assert_not_called()

    def test_both_changed_returns_synced_commit(self):
        self._select_override(self.HUMAN_URL, self.human + "\nAn extra rule.\n")
        self._select_override(self.MACHINE_URL, self.machine + "\nAn extra machine rule.\n")
        with patch("fastapi_app.routers.document_rules.find_synced_human_commit", return_value="abc123") as find:
            response = self._post()
        body = response.json()
        self.assertEqual(body["status"], "both_changed")
        self.assertEqual(body["human_source"], "override")
        self.assertEqual(body["machine_source"], "override")
        self.assertEqual(body["synced_commit"], "abc123")
        find.assert_called_once()

    def test_no_marker(self):
        self.texts[self.MACHINE_URL] = "## Data correction\nNo marker here.\n"
        with patch("fastapi_app.routers.document_rules.find_synced_human_commit") as find:
            response = self._post()
        self.assertEqual(response.json()["status"], "no_marker")
        self.assertIsNone(response.json()["synced_commit"])
        find.assert_not_called()

    def test_resolve_failure_is_502(self):
        self.texts.pop(self.MACHINE_URL)
        self.assertEqual(self._post().status_code, 502)

    def test_store_failure_is_not_reported_as_502(self):
        client = TestClient(self.app, raise_server_exceptions=False)
        with patch.object(DocumentRulesStore, "get_selected_override_text", side_effect=RuntimeError("db down")):
            response = client.post(
                "/document-rules/sync-status", json={"human_url": self.HUMAN_URL, "machine_url": self.MACHINE_URL}
            )
        self.assertEqual(response.status_code, 500)

    def test_non_reviewer_is_forbidden(self):
        self.app.dependency_overrides[require_authenticated_user] = lambda: {"username": "bob", "roles": ["user"]}
        self.assertEqual(self._post().status_code, 403)


class _FakeProvider(LLMProvider):
    """Records the prompts it receives and answers with `answer`, or raises `error`."""

    def __init__(self, answer: str = "", error: Optional[Exception] = None):
        self.id = "fake"
        self.label = "Fake"
        self.answer = answer
        self.error = error
        self.calls: list[tuple[str, str, str, float]] = []

    def list_models(self) -> list[LLMModel]:
        return []

    async def chat_completion(self, model_id: str, system_prompt: str, user_prompt: str, temperature: float = 0.2) -> str:
        self.calls.append((model_id, system_prompt, user_prompt, temperature))
        if self.error is not None:
            raise self.error
        return self.answer


class TestGuideChangeEndpoints(DocumentRulesRouterTestCase):
    HUMAN_URL = TestSyncStatusEndpoint.HUMAN_URL
    MACHINE_URL = TestSyncStatusEndpoint.MACHINE_URL
    OLD_HUMAN = "## Data correction\n\nOld human rule.\n"
    NEW_HUMAN = "## Data correction\n\nNew human rule.\n"
    MACHINE = "## Data correction\n\n<!-- sync: guide=abc llm=def -->\n\nMachine rule.\n"
    XML = "<TEI xmlns='http://www.tei-c.org/ns/1.0'/>"
    STABLE_ID = "stable1"

    def setUp(self):
        super().setUp()
        self.texts = {self.HUMAN_URL: self.NEW_HUMAN, self.MACHINE_URL: self.MACHINE}
        patches = [
            patch(
                "fastapi_app.lib.doc_rules.interpretation_ref_kind.InterpretationRefKind.resolve_original",
                side_effect=lambda url: self.texts[url],
            ),
            patch(
                "fastapi_app.lib.doc_rules.interpretation_ref_kind.InterpretationRefKind.resource_key",
                side_effect=lambda url, **kw: normalize_resource_key(url),
            ),
            patch("fastapi_app.lib.doc_rules.guide_update.find_synced_human_commit", return_value="abc123"),
            patch("fastapi_app.lib.doc_rules.guide_update.human_section_at_commit", return_value=self.OLD_HUMAN),
            patch("fastapi_app.routers.document_rules.check_model_access"),
            patch("fastapi_app.routers.document_rules.resolve_condense_prompt", return_value="  Custom condense prompt.  "),
            patch("fastapi_app.routers.document_rules._document_tei_or_http_error", return_value=self.XML),
        ]
        for patcher in patches:
            patcher.start()
            self.addCleanup(patcher.stop)
        LLMProviderRegistry.reset_instance()
        self.addCleanup(LLMProviderRegistry.reset_instance)
        self.provider = _FakeProvider("## Data correction\n\nUpdated machine rule.")
        LLMProviderRegistry.get_instance().register(self.provider)

    def _human_change(self):
        return self.client.post("/document-rules/human-change", json={"human_url": self.HUMAN_URL, "machine_url": self.MACHINE_URL})

    def _update(self, provider_id: str = "fake"):
        return self.client.post(
            "/document-rules/update-from-guide",
            json={"xml": self.STABLE_ID, "human_url": self.HUMAN_URL, "machine_url": self.MACHINE_URL, "provider_id": provider_id, "model_id": "m1"},
        )

    def test_human_change_delta_mode(self):
        response = self._human_change()
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body["mode"], "delta")
        self.assertEqual(body["old_human"], self.OLD_HUMAN)
        self.assertEqual(body["new_human"], self.NEW_HUMAN)
        self.assertEqual(body["base_commit"], "abc123")
        self.assertIn("<!-- sync: guide=abc llm=def -->", body["machine"])
        self.assertIn("Machine rule.", body["machine"])

    def test_human_change_align_mode_without_a_sync_base(self):
        self.texts[self.MACHINE_URL] = "## Data correction\n\nMachine rule.\n"
        body = self._human_change().json()
        self.assertEqual(body["mode"], "align")
        self.assertIsNone(body["old_human"])
        self.assertIsNone(body["base_commit"])

    def test_human_change_reports_a_changed_guide(self):
        self.assertIs(self._human_change().json()["unchanged"], False)

    def test_human_change_reports_an_unchanged_guide(self):
        self.texts[self.HUMAN_URL] = self.OLD_HUMAN
        self.assertIs(self._human_change().json()["unchanged"], True)

    def test_human_change_in_align_mode_is_never_unchanged(self):
        self.texts[self.MACHINE_URL] = "## Data correction\n\nMachine rule.\n"
        self.assertIs(self._human_change().json()["unchanged"], False)

    def test_update_reports_whether_the_guide_changed(self):
        self.assertIs(self._update().json()["unchanged"], False)
        self.texts[self.HUMAN_URL] = self.OLD_HUMAN
        self.assertIs(self._update().json()["unchanged"], True)
        self.texts[self.MACHINE_URL] = "## Data correction\n\nMachine rule.\n"
        self.assertIs(self._update().json()["unchanged"], False)

    def test_human_change_unresolvable_original_is_502(self):
        self.texts.pop(self.MACHINE_URL)
        self.assertEqual(self._human_change().status_code, 502)

    def test_update_returns_the_cleaned_proposal_and_sends_the_templates(self):
        response = self._update()
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body["mode"], "delta")
        self.assertEqual(body["base_commit"], "abc123")
        self.assertEqual(body["proposed"], "## Data correction\n\n<!-- sync: guide=abc llm=def -->\n\nUpdated machine rule.")
        self.assertIn("Machine rule.", body["machine"])
        self.assertEqual(len(self.provider.calls), 1)
        model_id, system_prompt, user_prompt, temperature = self.provider.calls[0]
        self.assertEqual(model_id, "m1")
        self.assertEqual(system_prompt, "Custom condense prompt.")
        self.assertEqual(temperature, 0.2)
        self.assertEqual(
            user_prompt,
            DELTA_PROMPT_TEMPLATE.format(
                old=self.OLD_HUMAN, new=self.NEW_HUMAN, machine="## Data correction\n\nMachine rule.\n"
            ),
        )

    def test_update_resolves_the_condense_prompt_from_the_documents_content(self):
        with patch("fastapi_app.routers.document_rules.resolve_condense_prompt", return_value="P") as resolve:
            self.assertEqual(self._update().status_code, 200)
        resolve.assert_called_once_with(self.XML, self.HUMAN_URL)

    def test_update_without_a_readable_document_skips_the_model(self):
        with patch("fastapi_app.routers.document_rules._document_tei_or_http_error", side_effect=HTTPException(status_code=400, detail="No TEI document open.")):
            response = self._update()
        self.assertEqual(response.status_code, 400)
        self.assertEqual(self.provider.calls, [])

    def test_update_in_align_mode_sends_the_align_template(self):
        self.texts[self.MACHINE_URL] = "## Data correction\n\nMachine rule.\n"
        body = self._update().json()
        self.assertEqual(body["mode"], "align")
        self.assertEqual(
            self.provider.calls[0][2],
            ALIGN_PROMPT_TEMPLATE.format(new=self.NEW_HUMAN, machine="## Data correction\n\nMachine rule.\n"),
        )

    def test_update_unknown_provider_is_404(self):
        self.assertEqual(self._update("nope").status_code, 404)

    def test_update_missing_secret_is_428(self):
        with patch.object(
            LLMProviderRegistry, "get_provider_for_user", side_effect=MissingSecretError("fake")
        ):
            response = self._update()
        self.assertEqual(response.status_code, 428)
        detail = response.json()["detail"]
        self.assertEqual(detail["code"], "secret_required")
        self.assertEqual(detail["service"], "fake")

    def test_update_model_access_denied_is_403(self):
        with patch("fastapi_app.routers.document_rules.check_model_access", side_effect=ModelAccessDenied("no")):
            self.assertEqual(self._update().status_code, 403)
        self.assertEqual(self.provider.calls, [])

    def test_update_denied_model_access_skips_the_guide_fetch(self):
        self.texts.pop(self.HUMAN_URL)
        with patch("fastapi_app.routers.document_rules.check_model_access", side_effect=ModelAccessDenied("no")):
            self.assertEqual(self._update().status_code, 403)

    def test_update_provider_error_message_comes_from_a_json_error_body(self):
        error = requests.HTTPError("400 Client Error")
        error.response = MagicMock()
        error.response.json.return_value = {"error": {"message": "Quota exceeded"}}
        self.provider.error = error
        response = self._update()
        self.assertEqual(response.status_code, 502)
        self.assertEqual(response.json()["detail"], "LLM provider request failed: Quota exceeded")

    def test_update_provider_error_is_502(self):
        self.provider.error = LLMProviderError("boom")
        response = self._update()
        self.assertEqual(response.status_code, 502)
        self.assertIn("LLM provider request failed", response.json()["detail"])

    def test_update_request_exception_is_502(self):
        self.provider.error = requests.RequestException("down")
        self.assertEqual(self._update().status_code, 502)

    def test_update_empty_answer_is_502(self):
        self.provider.answer = "  \n"
        response = self._update()
        self.assertEqual(response.status_code, 502)
        self.assertEqual(response.json()["detail"], "The model returned no machine rules")

    def test_update_condense_prompt_failure_is_500(self):
        client = TestClient(self.app, raise_server_exceptions=False)
        with patch("fastapi_app.routers.document_rules.resolve_condense_prompt", side_effect=RuntimeError("plugin bug")), \
             self.assertLogs("fastapi_app.routers.document_rules", level="ERROR") as logs:
            response = client.post(
                "/document-rules/update-from-guide",
                json={"xml": self.STABLE_ID, "human_url": self.HUMAN_URL, "machine_url": self.MACHINE_URL, "provider_id": "fake", "model_id": "m1"},
            )
        self.assertEqual(response.status_code, 500)
        self.assertEqual(response.json()["detail"], "Could not resolve the condensing prompt")
        self.assertIsNotNone(logs.records[0].exc_info)

    def test_update_unresolvable_original_is_502(self):
        self.texts.pop(self.HUMAN_URL)
        self.assertEqual(self._update().status_code, 502)
        self.assertEqual(self.provider.calls, [])

    def test_non_reviewer_is_forbidden_on_both_routes(self):
        self.app.dependency_overrides[require_authenticated_user] = lambda: {"username": "bob", "roles": ["user"]}
        self.assertEqual(self._human_change().status_code, 403)
        self.assertEqual(self._update().status_code, 403)


class TestDocumentTeiOrHttpError(unittest.TestCase):
    USER = {"username": "alice", "roles": ["reviewer"]}

    def _call(self, file_meta, content=b"<TEI/>", access=True):
        file_repo = MagicMock()
        file_repo.get_file_by_stable_id.return_value = file_meta
        file_storage = MagicMock()
        file_storage.read_file.return_value = content
        with patch("fastapi_app.routers.document_rules.check_file_access", return_value=access):
            return _document_tei_or_http_error(file_repo, file_storage, "stable1", self.USER)

    def test_returns_the_tei_content(self):
        self.assertEqual(self._call(MagicMock(file_type="tei")), "<TEI/>")

    def test_unknown_or_non_tei_document_is_400(self):
        for file_meta in (None, MagicMock(file_type="pdf")):
            with self.assertRaises(HTTPException) as ctx:
                self._call(file_meta)
            self.assertEqual(ctx.exception.status_code, 400)

    def test_no_read_access_is_403(self):
        with self.assertRaises(HTTPException) as ctx:
            self._call(MagicMock(file_type="tei"), access=False)
        self.assertEqual(ctx.exception.status_code, 403)

    def test_missing_content_is_400(self):
        with self.assertRaises(HTTPException) as ctx:
            self._call(MagicMock(file_type="tei"), content=None)
        self.assertEqual(ctx.exception.status_code, 400)


class ProposalRouterTestCase(DocumentRulesRouterTestCase):
    """Builds real proposals from the fossil guideline fixtures as the default-branch files."""
    HUMAN_URL = f"{PROPOSAL_REPO}/{PROPOSAL_SHA}/docs/guidelines.md#data-correction"
    MACHINE_URL = f"{PROPOSAL_REPO}/{PROPOSAL_SHA}/docs/guidelines-llm.md#L17-L25"
    MAIN_FILES = {f"{PROPOSAL_REPO}/main/docs/guidelines.md": HUMAN_FILE, f"{PROPOSAL_REPO}/main/docs/guidelines-llm.md": MACHINE_FILE}

    def setUp(self):
        super().setUp()
        raw_dir = f"https://raw.githubusercontent.com/mpilhlt/fossil/{PROPOSAL_SHA}/docs/"

        def served(text: str) -> str:
            return _rewrite_relative_markdown_urls(text, raw_dir)

        def section(text: str) -> str:
            range_ = markdown_section_range(text, "data-correction")
            return "\n".join(text.splitlines()[range_[0] - 1:range_[1]])

        human_original = served(section(HUMAN_FILE)) + "\nAn added human rule.\n"
        machine_original = served(section(MACHINE_FILE)) + "\nAn added machine rule.\n"
        originals = {self.HUMAN_URL: human_original, self.MACHINE_URL: machine_original}
        patches = [
            patch("fastapi_app.lib.doc_rules.interpretation_ref_kind.InterpretationRefKind.resolve_original", side_effect=lambda url: originals[url]),
            patch("fastapi_app.lib.doc_rules.interpretation_ref_kind.InterpretationRefKind.resource_key", side_effect=lambda url, **kw: normalize_resource_key(url)),
            patch("fastapi_app.lib.doc_rules.upstream_proposal._fetch_raw_file", side_effect=lambda url: self.MAIN_FILES[url]),
            patch("fastapi_app.lib.doc_rules.upstream_proposal.fetch_rule_excerpt", return_value=served(MACHINE_FILE)),
            patch.object(GitHubAdapter, "_default_branch", return_value="main"),
        ]
        for patcher in patches:
            patcher.start()
            self.addCleanup(patcher.stop)


class TestProposePatchEndpoint(ProposalRouterTestCase):
    def _post(self, include_human: bool = True, include_machine: bool = True, machine_url: Optional[str] = None):
        return self.client.post(
            "/document-rules/propose-patch",
            json={
                "human_url": self.HUMAN_URL,
                "machine_url": machine_url or self.MACHINE_URL,
                "include_human": include_human,
                "include_machine": include_machine,
                "label": "Data correction",
            },
        )

    def test_human_only_returns_one_file(self):
        response = self._post(include_machine=False)
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual([f["path"] for f in body["files"]], ["docs/guidelines.md"])
        self.assertEqual(body["branch"], "main")
        self.assertEqual(body["filename"], "data-correction-rules.patch")
        self.assertEqual(body["patch"].count("diff --git"), 1)
        self.assertIn("An added human rule.", body["files"][0]["after"])

    def test_both_layers_return_two_files_and_two_diff_headers(self):
        body = self._post().json()
        self.assertEqual([f["path"] for f in body["files"]], ["docs/guidelines.md", "docs/guidelines-llm.md"])
        self.assertEqual(body["patch"].count("diff --git"), 2)
        # The pinned originals carry an added rule the default branch lacks
        self.assertEqual(body["upstream_changed"], ["docs/guidelines.md", "docs/guidelines-llm.md"])
        self.assertTrue(body["in_sync"])

    def test_human_only_is_not_in_sync(self):
        body = self._post(include_machine=False).json()
        self.assertFalse(body["in_sync"])
        self.assertEqual(body["upstream_changed"], ["docs/guidelines.md"])

    def test_default_branch_resolve_errors_are_502(self):
        for error in (KeyError("default_branch"), NotImplementedError("no default branches")):
            with self.subTest(error=type(error).__name__), patch.object(GitHubAdapter, "_default_branch", side_effect=error), self.assertLogs("fastapi_app.routers.document_rules", level="ERROR"):
                response = self._post()
                self.assertEqual(response.status_code, 502)
                self.assertIn("Cannot resolve the default branch", response.json()["detail"])

    def test_renamed_heading_is_422(self):
        with patch("fastapi_app.lib.doc_rules.upstream_proposal.layer_text", return_value=("## Correcting data\n\nText.\n", "override")):
            response = self._post(include_machine=False)
        self.assertEqual(response.status_code, 422)
        self.assertEqual(response.json()["detail"], 'The proposed text for docs/guidelines.md must start with the heading of the section "data-correction".')

    def test_no_layer_selected_is_422(self):
        response = self._post(include_human=False, include_machine=False)
        self.assertEqual(response.status_code, 422)
        self.assertEqual(response.json()["detail"], "Select at least one of the guide section and the machine rules.")

    def test_different_repositories_is_422(self):
        other = "https://github.com/other/repo/blob/main/docs/guidelines-llm.md#L17-L25"
        with patch("fastapi_app.lib.doc_rules.interpretation_ref_kind.InterpretationRefKind.resolve_original", return_value="text"):
            response = self._post(machine_url=other)
        self.assertEqual(response.status_code, 422)
        self.assertEqual(response.json()["detail"], "The guide and the machine rules are in different repositories; propose them separately.")

    def test_nothing_to_propose_is_422(self):
        with patch("fastapi_app.routers.document_rules.build_upstream_proposal", side_effect=ProposalError("There are no changes to propose.")):
            response = self._post()
        self.assertEqual(response.status_code, 422)
        self.assertEqual(response.json()["detail"], "There are no changes to propose.")

    def test_fetch_failure_is_502(self):
        with patch("fastapi_app.lib.doc_rules.upstream_proposal._fetch_raw_file", side_effect=RuleFetchError("boom")):
            self.assertEqual(self._post().status_code, 502)

    def test_request_exception_is_502(self):
        with patch("fastapi_app.routers.document_rules.build_upstream_proposal", side_effect=requests.ConnectionError("down")):
            self.assertEqual(self._post().status_code, 502)

    def test_non_reviewer_is_forbidden(self):
        self.app.dependency_overrides[require_authenticated_user] = lambda: {"username": "bob", "roles": ["user"]}
        self.assertEqual(self._post().status_code, 403)

    def test_github_guide_can_open_a_pull_request_with_default_texts(self):
        body = self._post().json()
        self.assertTrue(body["can_open_pull_request"])
        self.assertEqual(body["pull_request_title"], "Annotation rules update: Data correction")
        self.assertEqual(
            body["pull_request_body"].splitlines()[:3],
            ["Proposed with the PDF-TEI-Editor by alice.", "", "Includes: guide section and machine rules."],
        )
        self.assertIn("The sync marker of the machine rules is updated; the pair is in sync.", body["pull_request_body"])
        self.assertEqual(body["pull_request_repository"], "mpilhlt/fossil")

    def test_base_hashes_of_the_default_branch_files(self):
        body = self._post().json()
        self.assertEqual(body["base_hashes"], {
            "docs/guidelines.md": hashlib.sha256(HUMAN_FILE.encode("utf-8")).hexdigest(),
            "docs/guidelines-llm.md": hashlib.sha256(MACHINE_FILE.encode("utf-8")).hexdigest(),
        })

    def test_gitlab_guide_cannot_open_a_pull_request(self):
        proposal = UpstreamProposal(files=[], patch="", filename="x-rules.patch", branch="main", upstream_changed=[], in_sync=False)
        with patch("fastapi_app.routers.document_rules.build_upstream_proposal", return_value=proposal):
            response = self.client.post(
                "/document-rules/propose-patch",
                json={"human_url": "https://gitlab.com/g/p/-/blob/main/docs/guidelines.md#data-correction", "machine_url": "https://gitlab.com/g/p/-/blob/main/docs/llm.md#L1-L2", "include_human": True, "include_machine": False, "label": "Data correction"},
            )
        self.assertEqual(response.status_code, 200)
        self.assertFalse(response.json()["can_open_pull_request"])
        self.assertIsNone(response.json()["pull_request_repository"])


class TestProposePullRequestEndpoint(ProposalRouterTestCase):
    """The GitHub calls are patched."""
    GITLAB_URL = "https://gitlab.com/g/p/-/blob/main/docs/guidelines.md#data-correction"

    def setUp(self):
        super().setUp()
        register_github_secret_service()
        self.addCleanup(unregister_secret_service, GITHUB_SECRET_SERVICE)
        token_patch = patch("fastapi_app.routers.document_rules.require_user_secret", return_value="ghp_TOKEN")
        self.require_secret = token_patch.start()
        self.addCleanup(token_patch.stop)
        pr_patch = patch(
            "fastapi_app.routers.document_rules.open_pull_request",
            return_value=PullRequestResult(url="https://github.com/mpilhlt/fossil/pull/7", number=7, branch="pdf-tei-editor/x", fork="alice/fossil"),
        )
        self.open_pr = pr_patch.start()
        self.addCleanup(pr_patch.stop)

    BASE_HASHES = {
        "docs/guidelines.md": hashlib.sha256(HUMAN_FILE.encode("utf-8")).hexdigest(),
        "docs/guidelines-llm.md": hashlib.sha256(MACHINE_FILE.encode("utf-8")).hexdigest(),
    }

    def _open(self, title: str = "My title", human_url: Optional[str] = None, base_hashes: Optional[dict[str, str]] = None):
        return self.client.post(
            "/document-rules/propose-pull-request",
            json={
                "human_url": human_url or self.HUMAN_URL,
                "machine_url": self.MACHINE_URL,
                "include_human": True,
                "include_machine": True,
                "label": "Data correction",
                "title": title,
                "body": "My body",
                "base_hashes": self.BASE_HASHES if base_hashes is None else base_hashes,
            },
        )

    def test_opens_the_pull_request(self):
        response = self._open()
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"url": "https://github.com/mpilhlt/fossil/pull/7", "number": 7, "branch": "pdf-tei-editor/x", "fork": "alice/fossil"})
        self.require_secret.assert_called_once_with("alice", "github")
        token, repo_id, base_branch, files, title, body, branch = self.open_pr.call_args.args
        self.assertEqual((token, repo_id, base_branch, title, body), ("ghp_TOKEN", "mpilhlt/fossil", "main", "My title", "My body"))
        self.assertEqual([f.path for f in files], ["docs/guidelines.md", "docs/guidelines-llm.md"])
        self.assertRegex(branch, r"^pdf-tei-editor/data-correction-\d{8}-\d{6}$")

    def test_upstream_change_since_the_preview_is_409(self):
        # The default branch moved on after the preview: the rebuilt proposal's `before` differs from the previewed one
        self.MAIN_FILES = {**self.MAIN_FILES, f"{PROPOSAL_REPO}/main/docs/guidelines-llm.md": MACHINE_FILE + "\nAn upstream addition.\n"}
        response = self._open()
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.json()["detail"], "The guide changed upstream since the preview. Close and reopen the dialog to see the current changes.")
        self.open_pr.assert_not_called()

    def test_different_previewed_paths_are_409(self):
        for base_hashes in ({"docs/guidelines.md": self.BASE_HASHES["docs/guidelines.md"]}, {**self.BASE_HASHES, "docs/other.md": "0" * 64}):
            with self.subTest(paths=sorted(base_hashes)):
                response = self._open(base_hashes=base_hashes)
                self.assertEqual(response.status_code, 409)
                self.assertEqual(response.json()["detail"], "The guide changed upstream since the preview. Close and reopen the dialog to see the current changes.")
        self.open_pr.assert_not_called()

    def test_base_hashes_are_required(self):
        response = self.client.post(
            "/document-rules/propose-pull-request",
            json={"human_url": self.HUMAN_URL, "machine_url": self.MACHINE_URL, "include_human": True, "include_machine": True, "label": "Data correction", "title": "T", "body": "B"},
        )
        self.assertEqual(response.status_code, 422)
        self.open_pr.assert_not_called()

    def test_missing_token_is_428(self):
        self.require_secret.side_effect = MissingSecretError("github", "alice")
        response = self._open()
        self.assertEqual(response.status_code, 428)
        detail = response.json()["detail"]
        self.assertEqual((detail["code"], detail["service"]), ("secret_required", "github"))
        self.open_pr.assert_not_called()

    def test_gitlab_guide_is_422(self):
        response = self._open(human_url=self.GITLAB_URL)
        self.assertEqual(response.status_code, 422)
        self.assertEqual(response.json()["detail"], "Pull requests can only be created for guides on GitHub. Download the patch instead.")
        self.open_pr.assert_not_called()

    def test_empty_title_is_422(self):
        response = self._open(title="   ")
        self.assertEqual(response.status_code, 422)
        self.assertEqual(response.json()["detail"], "The pull request needs a title.")
        self.open_pr.assert_not_called()

    def test_github_error_status_and_message_are_returned(self):
        self.open_pr.side_effect = GitHubError(409, "The guide changed upstream since the preview. Close and reopen the dialog to see the current changes.")
        response = self._open()
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.json()["detail"], "The guide changed upstream since the preview. Close and reopen the dialog to see the current changes.")

    def test_proposal_errors_are_mapped_like_propose_patch(self):
        with patch("fastapi_app.routers.document_rules.build_upstream_proposal", side_effect=ProposalError("There are no changes to propose.")):
            self.assertEqual(self._open().status_code, 422)
        with patch("fastapi_app.routers.document_rules.build_upstream_proposal", side_effect=requests.ConnectionError("down")):
            self.assertEqual(self._open().status_code, 502)

    def test_non_reviewer_is_forbidden(self):
        self.app.dependency_overrides[require_authenticated_user] = lambda: {"username": "bob", "roles": ["user"]}
        self.assertEqual(self._open().status_code, 403)


if __name__ == "__main__":
    unittest.main()
