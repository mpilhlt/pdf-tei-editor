"""
Unit tests for the condensing prompt default and per-guide override hook.

@testCovers fastapi_app/lib/doc_rules/condense_prompt.py
"""

import unittest
from typing import Optional

from fastapi_app.lib.doc_rules.condense_prompt import DEFAULT_CONDENSE_PROMPT, resolve_condense_prompt
from fastapi_app.lib.doc_rules.rules_providers import (
    register_document_rules_provider,
    unregister_document_rules_provider,
)

TEI = """<TEI xmlns="http://www.tei-c.org/ns/1.0">
  <teiHeader><encodingDesc><appInfo>
    <application version="1.0" ident="CONDENSE-TEST" type="extractor">
      <label type="variant-id">v1</label>
    </application>
  </appInfo></encodingDesc></teiHeader>
</TEI>"""

GUIDE = "https://github.com/x/y/blob/main/g.md#section"


class _PromptProvider:
    def __init__(self, prompt: Optional[str]):
        self.prompt = prompt
        self.seen: list[str] = []

    def get_condense_prompt(self, guide_url: str) -> Optional[str]:
        self.seen.append(guide_url)
        return self.prompt


class TestResolveCondensePrompt(unittest.TestCase):
    def tearDown(self):
        unregister_document_rules_provider("CONDENSE-TEST")

    def test_default_without_provider(self):
        self.assertEqual(resolve_condense_prompt(TEI, GUIDE), DEFAULT_CONDENSE_PROMPT)

    def test_default_when_provider_lacks_method(self):
        register_document_rules_provider("CONDENSE-TEST", "p", object())
        self.assertEqual(resolve_condense_prompt(TEI, GUIDE), DEFAULT_CONDENSE_PROMPT)

    def test_provider_value(self):
        provider = _PromptProvider("custom")
        register_document_rules_provider("CONDENSE-TEST", "p", provider)
        self.assertEqual(resolve_condense_prompt(TEI, GUIDE), "custom")
        self.assertEqual(provider.seen, [GUIDE])

    def test_default_when_provider_returns_none(self):
        register_document_rules_provider("CONDENSE-TEST", "p", _PromptProvider(None))
        self.assertEqual(resolve_condense_prompt(TEI, GUIDE), DEFAULT_CONDENSE_PROMPT)

    def test_default_when_provider_returns_empty_string(self):
        register_document_rules_provider("CONDENSE-TEST", "p", _PromptProvider(""))
        self.assertEqual(resolve_condense_prompt(TEI, GUIDE), DEFAULT_CONDENSE_PROMPT)

    def test_default_when_method_not_callable(self):
        provider = _PromptProvider("custom")
        provider.get_condense_prompt = "nope"
        register_document_rules_provider("CONDENSE-TEST", "p", provider)
        self.assertEqual(resolve_condense_prompt(TEI, GUIDE), DEFAULT_CONDENSE_PROMPT)

    def test_non_string_logs_warning_and_uses_default(self):
        register_document_rules_provider("CONDENSE-TEST", "p", _PromptProvider(["x"]))
        with self.assertLogs("fastapi_app.lib.doc_rules.condense_prompt", level="WARNING"):
            self.assertEqual(resolve_condense_prompt(TEI, GUIDE), DEFAULT_CONDENSE_PROMPT)

    def test_provider_exception_propagates(self):
        class Boom:
            def get_condense_prompt(self, guide_url: str) -> Optional[str]:
                raise RuntimeError("boom")

        register_document_rules_provider("CONDENSE-TEST", "p", Boom())
        with self.assertRaises(RuntimeError):
            resolve_condense_prompt(TEI, GUIDE)


if __name__ == "__main__":
    unittest.main()
