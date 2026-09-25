"""
Unit tests for rule-excerpt gathering and review orchestration.

@testCovers fastapi_app/plugins/annotation_review/review_logic.py
"""

import socket
import unittest
from unittest import mock

from fastapi_app.lib.llm import LLMModel, LLMProvider
from fastapi_app.lib.utils.annotation_rules_utils import RuleFetchError
from fastapi_app.plugins.annotation_review.review_logic import (
    NoRuleExcerptsError,
    _is_safe_fetch_url,
    extract_text_content,
    gather_rule_excerpts,
    run_review,
)

TEI_DOC = """<?xml version="1.0"?>
<TEI xmlns="http://www.tei-c.org/ns/1.0">
  <teiHeader>
    <encodingDesc>
      <editorialDecl>
        <interpretation type="primary">
          <p>See <ref target="https://example.org/rules.md#L1-L5" subtype="human" type="markdown"/>
          <ref target="https://raw.example.org/rules.md#L1-L5" subtype="machine" type="markdown"/></p>
        </interpretation>
        <interpretation type="footnote-annotation">
          <p><ref target="https://raw.example.org/footnote-rules.md" subtype="machine" type="markdown"/></p>
        </interpretation>
      </editorialDecl>
    </encodingDesc>
  </teiHeader>
  <text>
    <body>
      <persName>J. Doe</persName> wrote <title>A Paper</title>.
    </body>
  </text>
</TEI>
"""

NO_MACHINE_REF_DOC = """<?xml version="1.0"?>
<TEI xmlns="http://www.tei-c.org/ns/1.0">
  <teiHeader>
    <encodingDesc>
      <editorialDecl>
        <interpretation type="primary">
          <p><ref target="https://example.org/rules.md" subtype="human"/></p>
        </interpretation>
      </editorialDecl>
    </encodingDesc>
  </teiHeader>
  <text><body>hello</body></text>
</TEI>
"""

NO_TEXT_DOC = """<?xml version="1.0"?>
<TEI xmlns="http://www.tei-c.org/ns/1.0"><teiHeader/></TEI>
"""


class _StubProvider(LLMProvider):
    def __init__(self, response: str):
        self.id = "stub"
        self.label = "Stub"
        self._response = response
        self.calls: list[dict[str, str]] = []

    def list_models(self) -> list[LLMModel]:
        return []

    async def chat_completion(self, model_id, system_prompt, user_prompt, temperature=0.2) -> str:
        self.calls.append({"model_id": model_id, "system_prompt": system_prompt, "user_prompt": user_prompt})
        return self._response


class TestExtractTextContent(unittest.TestCase):
    def test_returns_serialized_text_element(self):
        result = extract_text_content(TEI_DOC)
        self.assertIn("<persName>J. Doe</persName>", result)
        self.assertIn("<title>A Paper</title>", result)
        self.assertNotIn("editorialDecl", result)

    def test_raises_on_malformed_xml(self):
        with self.assertRaises(ValueError):
            extract_text_content("<not-well-formed")

    def test_raises_when_no_text_element(self):
        with self.assertRaises(ValueError):
            extract_text_content(NO_TEXT_DOC)

    def test_preserves_raw_formatting_not_reserialized(self):
        xml = (
            '<?xml version="1.0"?><TEI xmlns="http://www.tei-c.org/ns/1.0">'
            "<text><body><persName rend='italic'>J.&#x2019;s Doe</persName><lb /></body></text></TEI>"
        )
        result = extract_text_content(xml)
        self.assertIn("rend='italic'", result)
        self.assertIn("&#x2019;", result)
        self.assertIn("<lb />", result)
        self.assertNotIn('xmlns="http://www.tei-c.org/ns/1.0"', result)


class TestGatherRuleExcerpts(unittest.TestCase):
    @mock.patch("fastapi_app.plugins.annotation_review.review_logic._is_safe_fetch_url", return_value=True)
    @mock.patch("fastapi_app.plugins.annotation_review.review_logic.fetch_rule_excerpt")
    def test_fetches_one_excerpt_per_category_machine_ref(self, mock_fetch, mock_is_safe):
        # _is_safe_fetch_url is mocked here: TEI_DOC's "raw.example.org" targets are
        # deliberately non-resolvable (test isolation from real DNS/network), which
        # would otherwise make the real safety check fail closed.
        mock_fetch.side_effect = lambda url, cache, **kwargs: f"excerpt for {url}"
        excerpts = gather_rule_excerpts(TEI_DOC, cache=mock.MagicMock())
        self.assertEqual(len(excerpts), 2)
        categories = [c for c, _ in excerpts]
        self.assertIn("primary", categories)
        self.assertIn("footnote-annotation", categories)

    @mock.patch("fastapi_app.plugins.annotation_review.review_logic.fetch_rule_excerpt")
    def test_skips_category_with_no_machine_ref(self, mock_fetch):
        excerpts = gather_rule_excerpts(NO_MACHINE_REF_DOC, cache=mock.MagicMock())
        self.assertEqual(excerpts, [])
        mock_fetch.assert_not_called()

    @mock.patch("fastapi_app.plugins.annotation_review.review_logic._is_safe_fetch_url", return_value=True)
    @mock.patch("fastapi_app.plugins.annotation_review.review_logic.fetch_rule_excerpt")
    def test_skips_category_whose_fetch_raises(self, mock_fetch, mock_is_safe):
        mock_fetch.side_effect = RuleFetchError("got HTML")
        with self.assertLogs("fastapi_app.plugins.annotation_review.review_logic", level="WARNING"):
            excerpts = gather_rule_excerpts(TEI_DOC, cache=mock.MagicMock())
        self.assertEqual(excerpts, [])

    @mock.patch("fastapi_app.plugins.annotation_review.review_logic.socket.getaddrinfo")
    def test_skips_category_with_unsafe_fetch_target(self, mock_getaddrinfo):
        # Mock DNS resolution rather than relying on real DNS/NXDOMAIN
        # behavior for "raw.example.org" (deliberately non-resolvable), so
        # the surviving (footnote-annotation) category is deterministically
        # *safe* and actually gets fetched - this test isolates the
        # unsafe-target skip path (per-category, not the whole review) from
        # an incidental DNS failure on the other category.
        def fake_getaddrinfo(host, *args, **kwargs):
            if host == "127.0.0.1":
                return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("127.0.0.1", 0))]
            return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", 0))]

        mock_getaddrinfo.side_effect = fake_getaddrinfo

        unsafe_doc = TEI_DOC.replace(
            "https://raw.example.org/rules.md#L1-L5", "http://127.0.0.1/rules.md"
        )
        cache = mock.MagicMock()
        with mock.patch(
            "fastapi_app.plugins.annotation_review.review_logic.fetch_rule_excerpt"
        ) as mock_fetch:
            mock_fetch.return_value = "footnote rule excerpt"
            excerpts = gather_rule_excerpts(unsafe_doc, cache=cache)
            mock_fetch.assert_called_once_with(
                "https://raw.example.org/footnote-rules.md", cache, allow_redirects=False
            )
        self.assertEqual(excerpts, [("footnote-annotation", "footnote rule excerpt")])


class TestRunReview(unittest.IsolatedAsyncioTestCase):
    @mock.patch("fastapi_app.plugins.annotation_review.review_logic._is_safe_fetch_url", return_value=True)
    @mock.patch("fastapi_app.plugins.annotation_review.review_logic.fetch_rule_excerpt")
    async def test_full_flow_returns_validated_findings(self, mock_fetch, mock_is_safe):
        # _is_safe_fetch_url is mocked for the same reason as in TestGatherRuleExcerpts:
        # TEI_DOC's "raw.example.org" targets are deliberately non-resolvable.
        mock_fetch.side_effect = lambda url, cache, **kwargs: "Rule: persName must have a ref attribute."
        provider = _StubProvider(
            '[{"old": "<persName>J. Doe</persName>", '
            '"new": "<persName ref=\\"#p1\\">J. Doe</persName>", "rationale": "add ref"}]'
        )
        findings = await run_review(TEI_DOC, provider, "stub-model", cache=mock.MagicMock())
        self.assertEqual(len(findings), 1)
        self.assertEqual(findings[0]["old"], "<persName>J. Doe</persName>")
        self.assertEqual(provider.calls[0]["model_id"], "stub-model")
        self.assertIn("persName must have a ref attribute", provider.calls[0]["user_prompt"])

    @mock.patch("fastapi_app.plugins.annotation_review.review_logic.fetch_rule_excerpt")
    async def test_raises_when_no_excerpts_could_be_gathered(self, mock_fetch):
        provider = _StubProvider("[]")
        with self.assertRaises(NoRuleExcerptsError):
            await run_review(NO_MACHINE_REF_DOC, provider, "stub-model", cache=mock.MagicMock())
        provider_calls_before = len(provider.calls)
        self.assertEqual(provider_calls_before, 0)

    async def test_raises_on_malformed_document(self):
        provider = _StubProvider("[]")
        with self.assertRaises(ValueError):
            await run_review("<not-well-formed", provider, "stub-model", cache=mock.MagicMock())


class TestIsSafeFetchUrl(unittest.TestCase):
    def test_rejects_non_http_scheme(self):
        self.assertFalse(_is_safe_fetch_url("file:///etc/passwd"))

    def test_rejects_loopback(self):
        self.assertFalse(_is_safe_fetch_url("http://127.0.0.1/rules.md"))
        self.assertFalse(_is_safe_fetch_url("http://localhost/rules.md"))

    def test_rejects_private_ip_literal(self):
        self.assertFalse(_is_safe_fetch_url("http://10.0.0.5/rules.md"))
        self.assertFalse(_is_safe_fetch_url("http://192.168.1.1/rules.md"))

    def test_rejects_link_local(self):
        self.assertFalse(_is_safe_fetch_url("http://169.254.169.254/latest/meta-data/"))

    @mock.patch("fastapi_app.plugins.annotation_review.review_logic.socket.getaddrinfo")
    def test_accepts_public_https_url(self, mock_getaddrinfo):
        # Mocked rather than relying on a real DNS lookup, to keep this test
        # deterministic in CI environments without DNS/internet access.
        mock_getaddrinfo.return_value = [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("1.1.1.1", 0))]
        self.assertTrue(_is_safe_fetch_url("https://raw.githubusercontent.com/example/rules.md"))

    def test_rejects_malformed_url(self):
        self.assertFalse(_is_safe_fetch_url("not a url"))


if __name__ == "__main__":
    unittest.main()
