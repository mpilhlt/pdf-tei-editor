"""
Unit tests for the annotation-review route.

@testCovers fastapi_app/plugins/annotation_review/routes.py
"""

import unittest
from unittest import mock

import requests
from fastapi import FastAPI
from fastapi.testclient import TestClient

from fastapi_app.lib.core.dependencies import require_authenticated_user
from fastapi_app.lib.llm import LLMModel, LLMProvider, LLMProviderRegistry
from fastapi_app.plugins.annotation_review.prompts import UnusableResponseError
from fastapi_app.plugins.annotation_review.routes import router

TEI_DOC = """<?xml version="1.0"?>
<TEI xmlns="http://www.tei-c.org/ns/1.0">
  <teiHeader>
    <encodingDesc>
      <editorialDecl>
        <interpretation type="primary">
          <p><ref target="https://raw.example.org/rules.md" subtype="machine" type="markdown"/></p>
        </interpretation>
      </editorialDecl>
    </encodingDesc>
  </teiHeader>
  <text><body><persName>J. Doe</persName></body></text>
</TEI>
"""


class _StubProvider(LLMProvider):
    def __init__(self, id: str = "stub"):
        self.id = id
        self.label = "Stub"

    def list_models(self) -> list[LLMModel]:
        return []

    async def chat_completion(self, model_id, system_prompt, user_prompt, temperature=0.2) -> str:
        return '[{"old": "<persName>J. Doe</persName>", "new": "<persName ref=\\"#p1\\">J. Doe</persName>", "rationale": "add ref"}]'


class TestReviewRoute(unittest.TestCase):
    def setUp(self):
        self.app = FastAPI()
        self.app.include_router(router)
        self.app.dependency_overrides[require_authenticated_user] = lambda: {"username": "testuser"}
        self.client = TestClient(self.app)
        LLMProviderRegistry.reset_instance()
        LLMProviderRegistry.get_instance().register(_StubProvider())

    def tearDown(self):
        LLMProviderRegistry.reset_instance()
        self.app.dependency_overrides.clear()

    @mock.patch("fastapi_app.plugins.annotation_review.review_logic._is_safe_fetch_url", return_value=True)
    @mock.patch("fastapi_app.plugins.annotation_review.review_logic.fetch_rule_excerpt")
    def test_returns_validated_findings(self, mock_fetch, mock_is_safe):
        # fetch_rule_excerpt would otherwise make a real HTTP request to the
        # (non-resolvable) rule URL in TEI_DOC; mocked here for test isolation,
        # consistent with test_review_logic.py's approach. _is_safe_fetch_url is
        # also mocked since the real check would otherwise fail closed on this
        # same non-resolvable hostname.
        mock_fetch.return_value = "Rule: persName must have a ref attribute."
        response = self.client.post(
            "/api/plugins/annotation-review/review",
            json={"xml": TEI_DOC, "provider_id": "stub", "model_id": "m1"},
        )
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(len(body["findings"]), 1)
        self.assertEqual(body["findings"][0]["old"], "<persName>J. Doe</persName>")

    def test_unknown_provider_returns_404(self):
        response = self.client.post(
            "/api/plugins/annotation-review/review",
            json={"xml": TEI_DOC, "provider_id": "does-not-exist", "model_id": "m1"},
        )
        self.assertEqual(response.status_code, 404)

    def test_missing_provider_id_returns_422(self):
        response = self.client.post(
            "/api/plugins/annotation-review/review",
            json={"xml": TEI_DOC, "model_id": "m1"},
        )
        self.assertEqual(response.status_code, 422)

    def test_no_rule_excerpts_returns_422(self):
        no_rules_doc = '<?xml version="1.0"?><TEI xmlns="http://www.tei-c.org/ns/1.0"><text><body>x</body></text></TEI>'
        response = self.client.post(
            "/api/plugins/annotation-review/review",
            json={"xml": no_rules_doc, "provider_id": "stub", "model_id": "m1"},
        )
        self.assertEqual(response.status_code, 422)

    def test_malformed_xml_returns_422(self):
        response = self.client.post(
            "/api/plugins/annotation-review/review",
            json={"xml": "<not well formed", "provider_id": "stub", "model_id": "m1"},
        )
        self.assertEqual(response.status_code, 422)

    @mock.patch("fastapi_app.plugins.annotation_review.routes.run_review")
    def test_upstream_provider_failure_returns_502_with_the_provider_message(self, mock_run_review):
        response = mock.MagicMock()
        response.json.return_value = {"error": {"message": "`temperature` is deprecated for this model."}}
        mock_run_review.side_effect = requests.HTTPError("400 Client Error: Bad Request", response=response)
        result = self.client.post(
            "/api/plugins/annotation-review/review",
            json={"xml": TEI_DOC, "provider_id": "stub", "model_id": "m1"},
        )
        self.assertEqual(result.status_code, 502)
        self.assertIn("`temperature` is deprecated", result.json()["detail"])

    @mock.patch("fastapi_app.plugins.annotation_review.routes.run_review")
    def test_upstream_connection_failure_returns_502(self, mock_run_review):
        mock_run_review.side_effect = requests.ConnectionError("no route to host")
        result = self.client.post(
            "/api/plugins/annotation-review/review",
            json={"xml": TEI_DOC, "provider_id": "stub", "model_id": "m1"},
        )
        self.assertEqual(result.status_code, 502)
        self.assertIn("LLM provider request failed", result.json()["detail"])

    @mock.patch("fastapi_app.plugins.annotation_review.routes.run_review")
    def test_unusable_model_response_returns_502(self, mock_run_review):
        mock_run_review.side_effect = UnusableResponseError("The model returned an empty response")
        result = self.client.post(
            "/api/plugins/annotation-review/review",
            json={"xml": TEI_DOC, "provider_id": "stub", "model_id": "m1"},
        )
        self.assertEqual(result.status_code, 502)
        self.assertIn("empty response", result.json()["detail"])

    def test_requires_authentication(self):
        self.app.dependency_overrides.clear()
        response = self.client.post(
            "/api/plugins/annotation-review/review",
            json={"xml": TEI_DOC, "provider_id": "stub", "model_id": "m1"},
        )
        self.assertEqual(response.status_code, 401)


if __name__ == "__main__":
    unittest.main()
