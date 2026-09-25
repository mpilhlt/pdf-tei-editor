# Annotation Review Backend Plugin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the `annotation_review` backend plugin (Part C of
`docs/superpowers/specs/2026-09-24-llm-annotation-review-design.md`): a
`POST /api/plugins/annotation-review/review` route that reads a document's
`editorialDecl` machine-readable rule refs, prompts an LLM (via the
already-built `LLMProviderRegistry`, Parts A/B) to check the document's
annotations against those rules, and returns validated findings — plus a
frontend extension exposing `review()`/`hasReviewableRules()` for later
parts (D: Tools-menu trigger, E: diagnostics UI) to call.

**Architecture:** New plugin `fastapi_app/plugins/annotation_review/`,
directory-underscored per convention (metadata id `annotation-review`),
following the `tei_annotator` plugin template (backend-plugin-registers-a-
frontend-extension shape). Pure prompt-building/response-validation logic
lives in `prompts.py` (no I/O, fully unit-testable); rule-excerpt gathering
and orchestration live in `review_logic.py`; `routes.py` is thin FastAPI
wiring; `plugin.py` just registers the frontend extension. This round does
**not** wire a Tools menu entry or CodeMirror diagnostics — those are Parts
D and E, separate plans. `review()`/`hasReviewableRules()` are built and
unit-tested as standalone callable methods only.

**Tech Stack:** FastAPI, Pydantic, lxml, `LLMProviderRegistry`
(`fastapi_app/lib/llm/`), `UrlCache`/`fetch_rule_excerpt`
(`fastapi_app/lib/utils/annotation_rules_utils.py`), `FrontendExtensionPlugin`
(`app/src/modules/frontend-extension-plugin.js`), Node's built-in test
runner (JS), `unittest`/`TestClient` (Python).

---

## Grounding — already-confirmed facts (no need to re-verify)

- `LLMProviderRegistry.get_instance().get_provider(id)` raises `KeyError` if
  unknown; `.list_providers(available_only=True)` for listing. Provider
  instances expose `async chat_completion(model_id, system_prompt,
  user_prompt, temperature=0.2) -> str` (`fastapi_app/lib/llm/base.py`,
  `registry.py`).
- `extract_annotation_rule_refs(xml_string) -> list[AnnotationRuleRef]`
  (`fastapi_app/lib/utils/annotation_rules_utils.py:228`) returns
  `[{"category": str, "refs": [{"target": str, "content_type": str|None,
  "subtype": "human"|"machine"}]}]`, already permalink-pinned at write time
  — no need to call `resolve_forge_permalink` again here.
- `fetch_rule_excerpt(url, cache) -> str` (same module, line 51) fetches
  and slices rule text; raises `RuleFetchError` on an HTML response, or lets
  `requests` exceptions propagate on network failure.
- `UrlCache(get_settings().annotation_rules_cache_dir)` is the construction
  pattern (`fastapi_app/plugins/grobid/annotation_rules_refresh.py:177`).
- `require_authenticated_user` (`fastapi_app/lib/core/dependencies.py:192`)
  is the modern auth-dependency pattern, already used by
  `fastapi_app/routers/llm.py` and tested via
  `app.dependency_overrides[require_authenticated_user] = lambda: {...}`
  (`tests/unit/fastapi/test_llm_router.py`) — use this, not the older
  manual `session_id`/`x_session_id` pattern from `tei_annotator/routes.py`.
- Backend plugin routes: create `routes.py` with a module-level `router =
  APIRouter(prefix="/api/plugins/annotation-review", tags=[...])` — it is
  **auto-discovered**, no manual registration in `main.py`
  (`docs/code-assistant/backend-plugins.md` lines 531-536). Also re-export
  `router` from `__init__.py` per convention.
- `Plugin.metadata` required keys: `id`, `name`, `description`, `category`,
  `version`, `required_roles`. `Plugin.is_available()` defaults to `True` —
  no override needed here (no own config to gate on).
- Frontend: `FrontendExtensionPlugin` (`app/src/modules/frontend-extension-plugin.js`)
  gives `callPluginApi(endpoint, method, params)` and extends `Plugin`, so
  `getDependency()` works for both declared `deps` and lazy/undeclared
  lookups (precedent: `tei-annotator.js` declares only `['tools',
  'xmleditor']` but calls `getDependency('sl-utils')`,
  `getDependency('config')`, `getDependency('tei-utils')` without declaring
  them).
- `getEditorialDeclGuides(xmlDoc)` (`app/src/modules/tei-utils.js:735`)
  returns `[{category, refs: [{target, contentType, subtype}]}]` — the
  frontend mirror of `extract_annotation_rule_refs`.
- `xmleditorApi.getEditorContent()` returns the current (possibly unsaved)
  serialized XML string; `xmleditorApi.getXmlTree()` returns the parsed
  `Document`.
- `getDependency('inference-settings').getDefaultModel()` (Part F, already
  built) returns `{providerId, modelId} | null`.
- Python plugin-colocated tests run via `uv run python
  tests/unit-test-runner.py fastapi_app/plugins/annotation_review/tests`
  (NOT `backend-test-runner.js` — that runner only discovers `*.test.js`
  files, it never touches `.py` files; confirmed by reading
  `tests/backend-test-runner.js`'s `discoverTests()`, which globs
  `**/*.test.js` only). JS plugin-colocated tests run via the normal `npm
  run test:unit:js` discovery (precedent:
  `fastapi_app/plugins/tei_annotator/tests/tei-annotator.test.js`).

---

## Task 1: Prompt building + response validation (`prompts.py`)

Pure functions, no I/O — the anti-hallucination validation is the most
important logic in this plugin, so it gets its own file and fast unit
tests.

**Files:**
- Create: `fastapi_app/plugins/annotation_review/prompts.py`
- Create: `fastapi_app/plugins/annotation_review/__init__.py` (empty for now, filled in Task 4)
- Test: `fastapi_app/plugins/annotation_review/tests/__init__.py` (empty)
- Test: `fastapi_app/plugins/annotation_review/tests/test_prompts.py`

- [ ] **Step 1: Write the failing tests**

```python
# fastapi_app/plugins/annotation_review/tests/test_prompts.py
"""
Unit tests for prompt building and response validation.

@testCovers fastapi_app/plugins/annotation_review/prompts.py
"""

import unittest

from fastapi_app.plugins.annotation_review.prompts import (
    build_system_prompt,
    build_user_prompt,
    parse_and_validate_findings,
)


class TestBuildSystemPrompt(unittest.TestCase):
    def test_mentions_json_array_and_keys(self):
        prompt = build_system_prompt()
        self.assertIn("old", prompt)
        self.assertIn("new", prompt)
        self.assertIn("rationale", prompt)
        self.assertIn("JSON", prompt)

    def test_mentions_uniqueness_requirement(self):
        prompt = build_system_prompt()
        self.assertIn("exactly once", prompt)


class TestBuildUserPrompt(unittest.TestCase):
    def test_includes_each_category_and_excerpt(self):
        prompt = build_user_prompt(
            rule_excerpts=[("primary", "Rule A text"), ("footnote-annotation", "Rule B text")],
            text_content="<text><body>hello</body></text>",
        )
        self.assertIn("primary", prompt)
        self.assertIn("Rule A text", prompt)
        self.assertIn("footnote-annotation", prompt)
        self.assertIn("Rule B text", prompt)

    def test_includes_document_text(self):
        prompt = build_user_prompt(
            rule_excerpts=[("primary", "Rule A text")],
            text_content="<text><body>UNIQUE_MARKER_XYZ</body></text>",
        )
        self.assertIn("UNIQUE_MARKER_XYZ", prompt)


class TestParseAndValidateFindings(unittest.TestCase):
    SOURCE = "<body><persName>J. Doe</persName> wrote <title>A Paper</title>.</body>"

    def test_parses_valid_json_array(self):
        raw = (
            '[{"old": "<persName>J. Doe</persName>", '
            '"new": "<persName ref=\\"#p1\\">J. Doe</persName>", '
            '"rationale": "add ref"}]'
        )
        findings = parse_and_validate_findings(raw, self.SOURCE)
        self.assertEqual(len(findings), 1)
        self.assertEqual(findings[0]["id"], 0)
        self.assertEqual(findings[0]["old"], "<persName>J. Doe</persName>")
        self.assertEqual(findings[0]["rationale"], "add ref")

    def test_strips_markdown_code_fence(self):
        raw = '```json\n[{"old": "<title>A Paper</title>", "new": "<title>A Paper</title>", "rationale": "ok"}]\n```'
        findings = parse_and_validate_findings(raw, self.SOURCE)
        self.assertEqual(len(findings), 1)

    def test_drops_finding_whose_old_is_absent(self):
        raw = '[{"old": "<date>2024</date>", "new": "x", "rationale": "y"}]'
        findings = parse_and_validate_findings(raw, self.SOURCE)
        self.assertEqual(findings, [])

    def test_drops_finding_whose_old_is_ambiguous(self):
        source = "<body>word word</body>"
        raw = '[{"old": "word", "new": "x", "rationale": "y"}]'
        findings = parse_and_validate_findings(raw, source)
        self.assertEqual(findings, [])

    def test_drops_finding_missing_required_key(self):
        raw = '[{"old": "<title>A Paper</title>", "rationale": "y"}]'
        findings = parse_and_validate_findings(raw, self.SOURCE)
        self.assertEqual(findings, [])

    def test_malformed_json_returns_empty_list(self):
        findings = parse_and_validate_findings("not json at all", self.SOURCE)
        self.assertEqual(findings, [])

    def test_non_list_json_returns_empty_list(self):
        findings = parse_and_validate_findings('{"old": "x"}', self.SOURCE)
        self.assertEqual(findings, [])

    def test_ids_are_sequential_over_kept_findings_only(self):
        raw = (
            '[{"old": "<persName>J. Doe</persName>", "new": "a", "rationale": "r1"}, '
            '{"old": "<date>NOPE</date>", "new": "b", "rationale": "r2"}, '
            '{"old": "<title>A Paper</title>", "new": "c", "rationale": "r3"}]'
        )
        findings = parse_and_validate_findings(raw, self.SOURCE)
        self.assertEqual([f["id"] for f in findings], [0, 1])
        self.assertEqual(findings[1]["old"], "<title>A Paper</title>")


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run python tests/unit-test-runner.py fastapi_app/plugins/annotation_review/tests`
Expected: FAIL/ERROR — `prompts.py` doesn't exist yet (`ModuleNotFoundError`)

- [ ] **Step 3: Write `prompts.py`**

```python
# fastapi_app/plugins/annotation_review/prompts.py
"""
Prompt building and response validation for the annotation-review LLM call.

Pure functions only — no HTTP, no file I/O — so the anti-hallucination
validation (the most important logic in this plugin) can be unit-tested
without any of the surrounding plugin/route machinery.

See docs/superpowers/specs/2026-09-24-llm-annotation-review-design.md
(Part C) for the design rationale.
"""

import json
import logging
import re

logger = logging.getLogger(__name__)

_CODE_FENCE_RE = re.compile(r"^```(?:json)?\s*\n?(.*?)\n?```$", re.DOTALL)

_REQUIRED_KEYS = ("old", "new", "rationale")


def build_system_prompt() -> str:
    """Instructions for the review LLM call: task, response contract, anti-hallucination rule."""
    return (
        "You are reviewing a TEI-encoded document's annotations against a set "
        "of annotation rules. You will be given one or more rule excerpts, "
        "each labeled with its category, followed by the document's <text> "
        "content (as XML).\n\n"
        "Check whether the document's annotations follow the given rules. "
        "For every place where an annotation is missing, wrong, or could be "
        "improved per the rules, propose a fix.\n\n"
        "Respond with ONLY a JSON array (no prose, no markdown fence) of "
        "objects, each with exactly these keys:\n"
        '  "old": the verbatim original XML snippet to replace\n'
        '  "new": the suggested replacement XML snippet\n'
        '  "rationale": a short explanation of why this change is suggested\n\n'
        'Example: [{"old": "<persName>J. Doe</persName>", '
        '"new": "<persName ref=\\"#p1\\">J. Doe</persName>", '
        '"rationale": "..."}]\n\n'
        "CRITICAL: \"old\" must be copied verbatim from the given text and "
        "must occur exactly once in it. Include enough surrounding context "
        "in \"old\" to make it uniquely identifying — a finding whose \"old\" "
        "is missing or ambiguous will be discarded. If there is nothing to "
        "fix, respond with an empty JSON array: []"
    )


def build_user_prompt(rule_excerpts: list[tuple[str, str]], text_content: str) -> str:
    """
    Combine every (category, excerpt) pair with the document's <text> content
    into a single prompt.
    """
    sections = []
    for category, excerpt in rule_excerpts:
        sections.append(f"## Rule category: {category}\n\n{excerpt}")
    rules_block = "\n\n".join(sections)
    return (
        f"{rules_block}\n\n"
        f"## Document text\n\n{text_content}"
    )


def parse_and_validate_findings(raw_response: str, source_text: str) -> list[dict]:
    """
    Parse the LLM's JSON array response and keep only findings whose "old"
    occurs exactly once in source_text — the primary defense against
    hallucinated or under-specified findings. Malformed JSON, a non-list
    response, or a finding missing a required key is dropped (logged), never
    raised: a partially-bad response still yields whatever findings are
    trustworthy. Kept findings are assigned a sequential integer "id" (0-based,
    over the kept findings only, in response order).
    """
    text = raw_response.strip()
    fence_match = _CODE_FENCE_RE.match(text)
    if fence_match:
        text = fence_match.group(1).strip()

    try:
        parsed = json.loads(text)
    except json.JSONDecodeError as e:
        logger.warning(f"annotation-review: could not parse LLM response as JSON: {e}")
        return []

    if not isinstance(parsed, list):
        logger.warning("annotation-review: LLM response JSON was not a list, dropping")
        return []

    kept: list[dict] = []
    for item in parsed:
        if not isinstance(item, dict) or not all(k in item for k in _REQUIRED_KEYS):
            logger.warning(f"annotation-review: dropping finding missing required keys: {item!r}")
            continue
        old = item["old"]
        if not isinstance(old, str):
            logger.warning(f"annotation-review: dropping finding with non-string 'old': {item!r}")
            continue
        occurrences = source_text.count(old)
        if occurrences != 1:
            logger.warning(
                f"annotation-review: dropping finding, 'old' occurs {occurrences} times "
                f"(expected exactly 1): {old!r}"
            )
            continue
        kept.append({
            "id": len(kept),
            "old": old,
            "new": item["new"],
            "rationale": item["rationale"],
        })
    return kept
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv run python tests/unit-test-runner.py fastapi_app/plugins/annotation_review/tests`
Expected: PASS (all `test_prompts.py` cases)

- [ ] **Step 5: Commit**

```bash
git add fastapi_app/plugins/annotation_review/prompts.py \
        fastapi_app/plugins/annotation_review/__init__.py \
        fastapi_app/plugins/annotation_review/tests/__init__.py \
        fastapi_app/plugins/annotation_review/tests/test_prompts.py
git commit -m "feat(annotation-review): add prompt building and response validation"
```

---

## Task 2: Rule-excerpt gathering + review orchestration (`review_logic.py`)

**Files:**
- Create: `fastapi_app/plugins/annotation_review/review_logic.py`
- Test: `fastapi_app/plugins/annotation_review/tests/test_review_logic.py`

- [ ] **Step 1: Write the failing tests**

```python
# fastapi_app/plugins/annotation_review/tests/test_review_logic.py
"""
Unit tests for rule-excerpt gathering and review orchestration.

@testCovers fastapi_app/plugins/annotation_review/review_logic.py
"""

import unittest
from unittest import mock

from fastapi_app.lib.llm import LLMModel, LLMProvider
from fastapi_app.lib.utils.annotation_rules_utils import RuleFetchError
from fastapi_app.plugins.annotation_review.review_logic import (
    NoRuleExcerptsError,
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
        self.calls = []

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


class TestGatherRuleExcerpts(unittest.TestCase):
    @mock.patch("fastapi_app.plugins.annotation_review.review_logic.fetch_rule_excerpt")
    def test_fetches_one_excerpt_per_category_machine_ref(self, mock_fetch):
        mock_fetch.side_effect = lambda url, cache: f"excerpt for {url}"
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

    @mock.patch("fastapi_app.plugins.annotation_review.review_logic.fetch_rule_excerpt")
    def test_skips_category_whose_fetch_raises(self, mock_fetch):
        mock_fetch.side_effect = RuleFetchError("got HTML")
        with self.assertLogs("fastapi_app.plugins.annotation_review.review_logic", level="WARNING"):
            excerpts = gather_rule_excerpts(TEI_DOC, cache=mock.MagicMock())
        self.assertEqual(excerpts, [])


class TestRunReview(unittest.IsolatedAsyncioTestCase):
    @mock.patch("fastapi_app.plugins.annotation_review.review_logic.fetch_rule_excerpt")
    async def test_full_flow_returns_validated_findings(self, mock_fetch):
        mock_fetch.side_effect = lambda url, cache: "Rule: persName must have a ref attribute."
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


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run python tests/unit-test-runner.py fastapi_app/plugins/annotation_review/tests`
Expected: FAIL/ERROR — `review_logic.py` doesn't exist yet

- [ ] **Step 3: Write `review_logic.py`**

```python
# fastapi_app/plugins/annotation_review/review_logic.py
"""
Rule-excerpt gathering and review orchestration for the annotation-review
backend plugin.

See docs/superpowers/specs/2026-09-24-llm-annotation-review-design.md
(Part C) for the design rationale.
"""

import logging

from lxml import etree

from fastapi_app.lib.core.url_cache import UrlCache
from fastapi_app.lib.llm import LLMProvider
from fastapi_app.lib.utils.annotation_rules_utils import extract_annotation_rule_refs, fetch_rule_excerpt

from .prompts import Finding, build_system_prompt, build_user_prompt, parse_and_validate_findings

logger = logging.getLogger(__name__)

TEI_NS = "http://www.tei-c.org/ns/1.0"


class NoRuleExcerptsError(Exception):
    """Raised when no rule excerpt could be resolved for any category — nothing to review against."""


def extract_text_content(xml_string: str) -> str:
    """
    Return the serialized <text> element of a TEI document, XML markup
    included (the LLM needs to see and reference existing annotation tags).

    Raises:
        ValueError: if the document is not well-formed XML, or has no
            <text> element.
    """
    try:
        root = etree.fromstring(xml_string.encode("utf-8"))
    except etree.XMLSyntaxError as e:
        raise ValueError(f"Document is not well-formed XML: {e}") from e

    text_el = root.find(f".//{{{TEI_NS}}}text")
    if text_el is None:
        raise ValueError("Document has no <text> element")

    return etree.tostring(text_el, encoding="unicode", xml_declaration=False)


def gather_rule_excerpts(xml_string: str, cache: UrlCache) -> list[tuple[str, str]]:
    """
    Resolve one rule excerpt per editorialDecl category, using each
    category's "machine"-subtype ref. A category with no machine ref, or
    whose excerpt fails to fetch, is skipped (logged), not raised.
    """
    excerpts: list[tuple[str, str]] = []
    for rule_ref in extract_annotation_rule_refs(xml_string):
        machine_ref = next((r for r in rule_ref["refs"] if r["subtype"] == "machine"), None)
        if machine_ref is None:
            continue
        try:
            excerpt = fetch_rule_excerpt(machine_ref["target"], cache)
        except Exception as e:  # noqa: BLE001 - any fetch failure for one category is skip-worthy, not fatal
            logger.warning(
                f"annotation-review: skipping rule category '{rule_ref['category']}' "
                f"- could not fetch excerpt from {machine_ref['target']}: {e}"
            )
            continue
        excerpts.append((rule_ref["category"], excerpt))
    return excerpts


async def run_review(
    xml_string: str,
    provider: LLMProvider,
    model_id: str,
    cache: UrlCache,
) -> list[Finding]:
    """
    Full review flow: extract the document's <text>, gather rule excerpts,
    build the prompt, call the LLM, and return validated findings.

    Raises:
        ValueError: document is malformed or has no <text> element.
        NoRuleExcerptsError: no rule excerpt could be resolved for any category.
    """
    text_content = extract_text_content(xml_string)
    rule_excerpts = gather_rule_excerpts(xml_string, cache)
    if not rule_excerpts:
        raise NoRuleExcerptsError("No rule excerpts could be resolved for this document")

    system_prompt = build_system_prompt()
    user_prompt = build_user_prompt(rule_excerpts, text_content)
    raw_response = await provider.chat_completion(model_id, system_prompt, user_prompt)
    return parse_and_validate_findings(raw_response, text_content)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv run python tests/unit-test-runner.py fastapi_app/plugins/annotation_review/tests`
Expected: PASS (all `test_review_logic.py` cases; `test_prompts.py` still passing)

- [ ] **Step 5: Commit**

```bash
git add fastapi_app/plugins/annotation_review/review_logic.py \
        fastapi_app/plugins/annotation_review/tests/test_review_logic.py
git commit -m "feat(annotation-review): add rule-excerpt gathering and review orchestration"
```

---

## Task 3: FastAPI route (`routes.py`)

**Files:**
- Create: `fastapi_app/plugins/annotation_review/routes.py`
- Test: `fastapi_app/plugins/annotation_review/tests/test_routes.py`

- [ ] **Step 1: Write the failing tests**

```python
# fastapi_app/plugins/annotation_review/tests/test_routes.py
"""
Unit tests for the annotation-review route.

@testCovers fastapi_app/plugins/annotation_review/routes.py
"""

import unittest
from unittest import mock

from fastapi import FastAPI
from fastapi.testclient import TestClient

from fastapi_app.lib.core.dependencies import require_authenticated_user
from fastapi_app.lib.llm import LLMModel, LLMProvider, LLMProviderRegistry
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

    @mock.patch("fastapi_app.plugins.annotation_review.review_logic.fetch_rule_excerpt")
    def test_returns_validated_findings(self, mock_fetch):
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

    def test_requires_authentication(self):
        self.app.dependency_overrides.clear()
        response = self.client.post(
            "/api/plugins/annotation-review/review",
            json={"xml": TEI_DOC, "provider_id": "stub", "model_id": "m1"},
        )
        self.assertEqual(response.status_code, 401)


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run python tests/unit-test-runner.py fastapi_app/plugins/annotation_review/tests`
Expected: FAIL/ERROR — `routes.py` doesn't exist yet

- [ ] **Step 3: Write `routes.py`**

```python
# fastapi_app/plugins/annotation_review/routes.py
"""
Custom routes for the annotation-review plugin.

Provides:
  POST /api/plugins/annotation-review/review — review a document's
  annotations against its own editorialDecl rules and return validated
  findings.
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from fastapi_app.config import get_settings
from fastapi_app.lib.core.dependencies import require_authenticated_user
from fastapi_app.lib.core.url_cache import UrlCache
from fastapi_app.lib.llm import LLMProviderRegistry
from fastapi_app.plugins.annotation_review.review_logic import NoRuleExcerptsError, run_review

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/plugins/annotation-review", tags=["annotation-review"])


class ReviewRequest(BaseModel):
    xml: str
    provider_id: str
    model_id: str


class FindingResponse(BaseModel):
    id: int
    old: str
    new: str
    rationale: str


class ReviewResponse(BaseModel):
    findings: list[FindingResponse]


@router.post("/review", response_model=ReviewResponse)
async def review(
    body: ReviewRequest,
    current_user: dict = Depends(require_authenticated_user),
) -> ReviewResponse:
    """
    Review the given (possibly unsaved) document content against its own
    editorialDecl rules, using the given provider/model.
    """
    try:
        provider = LLMProviderRegistry.get_instance().get_provider(body.provider_id)
    except KeyError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e

    cache = UrlCache(get_settings().annotation_rules_cache_dir)

    try:
        findings = await run_review(body.xml, provider, body.model_id, cache)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e
    except NoRuleExcerptsError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e

    return ReviewResponse(findings=[FindingResponse(**f) for f in findings])
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv run python tests/unit-test-runner.py fastapi_app/plugins/annotation_review/tests`
Expected: PASS (all `test_routes.py` cases; Tasks 1-2 tests still passing)

- [ ] **Step 5: Commit**

```bash
git add fastapi_app/plugins/annotation_review/routes.py \
        fastapi_app/plugins/annotation_review/tests/test_routes.py
git commit -m "feat(annotation-review): add POST /review route"
```

---

## Task 4: Plugin registration (`plugin.py`)

**Files:**
- Modify: `fastapi_app/plugins/annotation_review/__init__.py`
- Create: `fastapi_app/plugins/annotation_review/plugin.py`
- Test: `fastapi_app/plugins/annotation_review/tests/test_plugin.py`

- [ ] **Step 1: Write the failing test**

```python
# fastapi_app/plugins/annotation_review/tests/test_plugin.py
"""
Unit tests for the annotation-review plugin registration.

@testCovers fastapi_app/plugins/annotation_review/plugin.py
"""

import unittest
from unittest import mock

from fastapi_app.lib.plugins.frontend_extension_registry import FrontendExtensionRegistry
from fastapi_app.lib.plugins.plugin_base import PluginContext
from fastapi_app.plugins.annotation_review.plugin import AnnotationReviewPlugin


class TestAnnotationReviewPlugin(unittest.TestCase):
    def test_metadata(self):
        plugin = AnnotationReviewPlugin()
        metadata = plugin.metadata
        self.assertEqual(metadata["id"], "annotation-review")
        self.assertEqual(metadata["category"], "annotation")
        self.assertIn("user", metadata["required_roles"])

    def test_is_available_defaults_true(self):
        self.assertTrue(AnnotationReviewPlugin.is_available())

    def test_get_endpoints_returns_empty_dict(self):
        plugin = AnnotationReviewPlugin()
        self.assertEqual(plugin.get_endpoints(), {})

    async def _initialize(self, plugin):
        context = PluginContext()
        await plugin.initialize(context)

    def test_initialize_registers_frontend_extension(self):
        import asyncio

        plugin = AnnotationReviewPlugin()
        with mock.patch.object(FrontendExtensionRegistry, "get_instance") as mock_get_instance:
            mock_registry = mock.MagicMock()
            mock_get_instance.return_value = mock_registry
            asyncio.run(self._initialize(plugin))
            mock_registry.register_extension.assert_called_once()
            args, _ = mock_registry.register_extension.call_args
            extension_path, plugin_id = args
            self.assertTrue(str(extension_path).endswith("annotation-review.js"))
            self.assertEqual(plugin_id, "annotation-review")


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run python tests/unit-test-runner.py fastapi_app/plugins/annotation_review/tests`
Expected: FAIL/ERROR — `plugin.py` doesn't exist yet

- [ ] **Step 3: Write `plugin.py`**

```python
# fastapi_app/plugins/annotation_review/plugin.py
"""
Annotation Review plugin.

Reviews a document's annotations against its own editorialDecl-linked
rules using an LLM, via the shared LLMProviderRegistry (Parts A/B). Exposes
a frontend extension with review()/hasReviewableRules() for later parts
(D: Tools-menu trigger, E: diagnostics UI) to call.

See docs/superpowers/specs/2026-09-24-llm-annotation-review-design.md
(Part C) for the design rationale.
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any, Callable

from fastapi_app.lib.plugins.frontend_extension_registry import FrontendExtensionRegistry
from fastapi_app.lib.plugins.plugin_base import Plugin, PluginContext

logger = logging.getLogger(__name__)


class AnnotationReviewPlugin(Plugin):
    """Plugin that reviews a document's annotations against its own editorialDecl rules."""

    @property
    def metadata(self) -> dict[str, Any]:
        return {
            "id": "annotation-review",
            "name": "Annotation Review",
            "description": "Reviews a document's annotations against its own editorialDecl-linked rules using an LLM",
            "category": "annotation",
            "version": "1.0.0",
            "required_roles": ["user"],
            "endpoints": [],
        }

    def get_endpoints(self) -> dict[str, Callable]:
        return {}

    async def initialize(self, context: PluginContext) -> None:
        """Register the frontend extension."""
        registry = FrontendExtensionRegistry.get_instance()
        extension_file = Path(__file__).parent / "extensions" / "annotation-review.js"
        if extension_file.exists():
            registry.register_extension(extension_file, self.metadata["id"])
            logger.info("Annotation Review frontend extension registered")
        else:
            logger.warning("Annotation Review frontend extension not found at %s", extension_file)

    async def cleanup(self) -> None:
        pass
```

```python
# fastapi_app/plugins/annotation_review/__init__.py
from .plugin import AnnotationReviewPlugin
from .routes import router

__all__ = ["AnnotationReviewPlugin", "router"]
```

- [ ] **Step 4: Run test to verify it passes**

Run: `uv run python tests/unit-test-runner.py fastapi_app/plugins/annotation_review/tests`
Expected: PASS (all tests across Tasks 1-4)

- [ ] **Step 5: Commit**

```bash
git add fastapi_app/plugins/annotation_review/plugin.py \
        fastapi_app/plugins/annotation_review/__init__.py \
        fastapi_app/plugins/annotation_review/tests/test_plugin.py
git commit -m "feat(annotation-review): register plugin and frontend extension"
```

---

## Task 5: Frontend extension (`extensions/annotation-review.js`)

**Files:**
- Create: `fastapi_app/plugins/annotation_review/extensions/annotation-review.js`
- Test: `fastapi_app/plugins/annotation_review/tests/annotation-review.test.js`

- [ ] **Step 1: Write the failing tests**

```js
// fastapi_app/plugins/annotation_review/tests/annotation-review.test.js
/**
 * Unit tests for the annotation-review frontend extension.
 *
 * @testCovers fastapi_app/plugins/annotation_review/extensions/annotation-review.js
 */

import { describe, it, mock } from 'node:test';
import assert from 'node:assert';

// Stub browser-only base class before the dynamic import below.
class FakeFrontendExtensionPlugin {
  constructor(context, config = {}) {
    this.context = context;
    this._config = config;
    this._deps = {};
  }
  getDependency(name) {
    if (!(name in this._deps)) throw new Error(`no stub dependency registered for "${name}"`);
    return this._deps[name];
  }
  async callPluginApi() {
    throw new Error('callPluginApi must be stubbed per-test');
  }
}
global.FrontendExtensionPlugin = FakeFrontendExtensionPlugin;

const { default: AnnotationReviewExtension } = await import('../extensions/annotation-review.js');

/**
 * Build an extension instance with stubbed dependencies.
 * @param {{xmlDoc?: object|null, editorContent?: string, defaultModel?: object|null, callPluginApiImpl?: Function}} opts
 */
function buildExtension(opts = {}) {
  const ext = new AnnotationReviewExtension({});
  const notifyCalls = [];
  ext._deps = {
    xmleditor: {
      getXmlTree: () => (opts.xmlDoc === undefined ? {} : opts.xmlDoc),
      getEditorContent: () => opts.editorContent ?? '<TEI/>',
    },
    'sl-utils': {
      notify: (...args) => notifyCalls.push(args),
    },
    'tei-utils': {
      getEditorialDeclGuides: opts.getEditorialDeclGuides ?? (() => []),
    },
    'inference-settings': {
      getDefaultModel: () => opts.defaultModel ?? null,
    },
  };
  ext.callPluginApi = opts.callPluginApiImpl ?? (async () => { throw new Error('unexpected call'); });
  return { ext, notifyCalls };
}

describe('hasReviewableRules', () => {
  it('returns true when at least one category has a machine-subtype ref', () => {
    const { ext } = buildExtension({
      getEditorialDeclGuides: () => [{ category: 'primary', refs: [{ target: 'x', contentType: null, subtype: 'machine' }] }],
    });
    assert.strictEqual(ext.hasReviewableRules({}), true);
  });

  it('returns false when no category has a machine-subtype ref', () => {
    const { ext } = buildExtension({
      getEditorialDeclGuides: () => [{ category: 'primary', refs: [{ target: 'x', contentType: null, subtype: 'human' }] }],
    });
    assert.strictEqual(ext.hasReviewableRules({}), false);
  });

  it('returns false for an empty guides list', () => {
    const { ext } = buildExtension({ getEditorialDeclGuides: () => [] });
    assert.strictEqual(ext.hasReviewableRules({}), false);
  });
});

describe('review', () => {
  it('notifies and returns null when no document is open', async () => {
    const { ext, notifyCalls } = buildExtension({ xmlDoc: null });
    const result = await ext.review();
    assert.strictEqual(result, null);
    assert.strictEqual(notifyCalls.length, 1);
    assert.strictEqual(notifyCalls[0][1], 'warning');
  });

  it('notifies and returns null when the document has no reviewable rules', async () => {
    const { ext, notifyCalls } = buildExtension({
      getEditorialDeclGuides: () => [{ category: 'primary', refs: [{ target: 'x', contentType: null, subtype: 'human' }] }],
    });
    const result = await ext.review();
    assert.strictEqual(result, null);
    assert.strictEqual(notifyCalls.length, 1);
  });

  it('notifies and returns null when no default model is configured', async () => {
    const { ext, notifyCalls } = buildExtension({
      getEditorialDeclGuides: () => [{ category: 'primary', refs: [{ target: 'x', contentType: null, subtype: 'machine' }] }],
      defaultModel: null,
    });
    const result = await ext.review();
    assert.strictEqual(result, null);
    assert.strictEqual(notifyCalls.length, 1);
  });

  it('calls the review endpoint with resolved default provider/model and returns findings', async () => {
    const calls = [];
    const { ext } = buildExtension({
      getEditorialDeclGuides: () => [{ category: 'primary', refs: [{ target: 'x', contentType: null, subtype: 'machine' }] }],
      defaultModel: { providerId: 'kisski', modelId: 'gemma-3' },
      editorContent: '<TEI>content</TEI>',
      callPluginApiImpl: async (endpoint, method, params) => {
        calls.push({ endpoint, method, params });
        return { findings: [{ id: 0, old: 'a', new: 'b', rationale: 'r' }] };
      },
    });
    const result = await ext.review();
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].endpoint, '/api/plugins/annotation-review/review');
    assert.strictEqual(calls[0].method, 'POST');
    assert.deepStrictEqual(calls[0].params, {
      xml: '<TEI>content</TEI>',
      provider_id: 'kisski',
      model_id: 'gemma-3',
    });
    assert.deepStrictEqual(result, [{ id: 0, old: 'a', new: 'b', rationale: 'r' }]);
  });

  it('uses an explicit override instead of the default model', async () => {
    const calls = [];
    const { ext } = buildExtension({
      getEditorialDeclGuides: () => [{ category: 'primary', refs: [{ target: 'x', contentType: null, subtype: 'machine' }] }],
      defaultModel: { providerId: 'kisski', modelId: 'gemma-3' },
      callPluginApiImpl: async (endpoint, method, params) => {
        calls.push(params);
        return { findings: [] };
      },
    });
    await ext.review({ providerId: 'other', modelId: 'other-model' });
    assert.strictEqual(calls[0].provider_id, 'other');
    assert.strictEqual(calls[0].model_id, 'other-model');
  });

  it('notifies and returns null when the API call fails', async () => {
    const { ext, notifyCalls } = buildExtension({
      getEditorialDeclGuides: () => [{ category: 'primary', refs: [{ target: 'x', contentType: null, subtype: 'machine' }] }],
      defaultModel: { providerId: 'kisski', modelId: 'gemma-3' },
      callPluginApiImpl: async () => { throw new Error('boom'); },
    });
    const result = await ext.review();
    assert.strictEqual(result, null);
    assert.strictEqual(notifyCalls.length, 1);
    assert.strictEqual(notifyCalls[0][1], 'danger');
  });
});
```

`hasReviewableRules(xmlDoc)` takes the raw `xmlDoc` (per the spec) and
resolves guides internally via `getDependency('tei-utils').getEditorialDeclGuides(xmlDoc)`
— the tests above stub that dependency and pass a placeholder `{}` as
`xmlDoc` since its content is irrelevant once the call is stubbed.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:unit:js -- fastapi_app/plugins/annotation_review/tests/annotation-review.test.js`
Expected: FAIL/ERROR — `extensions/annotation-review.js` doesn't exist yet

- [ ] **Step 3: Write `extensions/annotation-review.js`**

```js
/**
 * Annotation Review frontend extension.
 *
 * Exposes review()/hasReviewableRules() for later parts (D: Tools-menu
 * trigger, E: diagnostics UI) to call. Does not itself add any menu item
 * or diagnostics source — see
 * docs/superpowers/specs/2026-09-24-llm-annotation-review-design.md
 * (Part C) for the design rationale and scope split.
 *
 * @import { PluginContext } from '../../../../app/src/modules/plugin-context.js'
 */

export default class AnnotationReviewExtension extends FrontendExtensionPlugin {
  constructor(/** @type {PluginContext} */ context) {
    super(context, { name: 'annotation-review', deps: ['xmleditor'] });
  }

  /**
   * True if the given document has at least one editorialDecl category with
   * a "machine"-subtype ref — i.e. there is something to review against.
   * @param {Document} xmlDoc
   * @returns {boolean}
   */
  hasReviewableRules(xmlDoc) {
    const guides = this.getDependency('tei-utils').getEditorialDeclGuides(xmlDoc);
    return guides.some(g => g.refs.some(r => r.subtype === 'machine'));
  }

  /**
   * Review the current editor document's annotations against its own
   * editorialDecl rules. Resolves provider/model from the given override,
   * or from the shared default (Part F), unless one isn't configured.
   * @param {{providerId: string, modelId: string}} [override]
   * @returns {Promise<Array<{id: number, old: string, new: string, rationale: string}>|null>}
   *   null when the review could not be started or failed (user already notified).
   */
  async review(override) {
    const xmleditorApi = this.getDependency('xmleditor');
    const xmlDoc = xmleditorApi.getXmlTree();
    if (!xmlDoc) {
      this.getDependency('sl-utils').notify('No document open.', 'warning', 'exclamation-triangle');
      return null;
    }

    if (!this.hasReviewableRules(xmlDoc)) {
      this.getDependency('sl-utils').notify(
        'This document has no machine-readable annotation rules to review against.',
        'warning',
        'exclamation-triangle'
      );
      return null;
    }

    const resolved = override ?? this.getDependency('inference-settings').getDefaultModel();
    if (!resolved) {
      this.getDependency('sl-utils').notify(
        'No default model configured. Set one via Tools → Inference → Default Model.',
        'warning',
        'exclamation-triangle'
      );
      return null;
    }

    try {
      const { findings } = await this.callPluginApi(
        '/api/plugins/annotation-review/review',
        'POST',
        {
          xml: xmleditorApi.getEditorContent(),
          provider_id: resolved.providerId,
          model_id: resolved.modelId,
        }
      );
      return findings;
    } catch (err) {
      this.getDependency('sl-utils').notify(
        `Annotation review failed: ${err.message}`,
        'danger',
        'exclamation-octagon'
      );
      return null;
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test:unit:js -- fastapi_app/plugins/annotation_review/tests/annotation-review.test.js`
Expected: PASS (all `annotation-review.test.js` cases)

- [ ] **Step 5: Commit**

```bash
git add fastapi_app/plugins/annotation_review/extensions/annotation-review.js \
        fastapi_app/plugins/annotation_review/tests/annotation-review.test.js
git commit -m "feat(annotation-review): add frontend extension with review()/hasReviewableRules()"
```

---

## Final check

- [ ] Run the full backend plugin test suite once more:

Run: `uv run python tests/unit-test-runner.py fastapi_app/plugins/annotation_review/tests`
Expected: PASS (all tests, Tasks 1-4)

- [ ] Run the full JS unit suite once more (confirm no unrelated regressions):

Run: `npm run test:unit:js`
Expected: PASS

- [ ] Manual verification: with a running dev server and a document whose
  `editorialDecl` has at least one `machine`-subtype ref and a configured
  default model (Part F), confirm via `node bin/debug-api.js POST
  /api/plugins/annotation-review/review '{"xml": "...", "provider_id":
  "...", "model_id": "..."}'` that the endpoint returns a `findings` array
  shaped as expected. There is no UI trigger yet (Part D) — this is a
  backend-plugin-only round.

## Not in scope for this plan (deferred to later plans)

- Tools-menu entry calling `review()` (Part D)
- CodeMirror diagnostics + "Propose fix" merge-view UI consuming the
  findings (Part E)
