"""
Unit tests for the "interpretation-ref" resource kind.

@testCovers fastapi_app/lib/doc_rules/interpretation_ref_kind.py
"""

import tempfile
import unittest
from pathlib import Path
from typing import Literal
from unittest.mock import patch

from fastapi_app.lib.core.database import DatabaseManager
from fastapi_app.lib.doc_rules.interpretation_ref_kind import (
    InterpretationRefKind,
    layer_refs,
    legacy_resource_key,
    selected_rule_override_text,
)
from fastapi_app.lib.doc_rules.resource_key import normalize_resource_key
from fastapi_app.lib.doc_rules.storage import DocumentRulesStore
from fastapi_app.lib.utils.annotation_rules_utils import (
    AnnotationRuleRef,
    AnnotationRuleRefTarget,
    RuleFetchError,
)

XML_ONE_ENTRY_WITH_LABEL = """<?xml version="1.0"?>
<TEI xmlns="http://www.tei-c.org/ns/1.0">
  <teiHeader><encodingDesc><editorialDecl>
    <interpretation type="data-correction" n="Data correction">
      <p><ref target="https://github.com/mpilhlt/pdf-tei-editor/blob/main/rules.md" subtype="human" type="markdown"/></p>
    </interpretation>
  </editorialDecl></encodingDesc></teiHeader>
</TEI>"""

XML_TWO_REFS_HUMAN_AND_MACHINE = """<?xml version="1.0"?>
<TEI xmlns="http://www.tei-c.org/ns/1.0">
  <teiHeader><encodingDesc><editorialDecl>
    <interpretation type="primary">
      <p>
        <ref target="https://github.com/mpilhlt/pdf-tei-editor/blob/main/rules.md#intro" subtype="human" type="markdown"/>
        <ref target="https://github.com/mpilhlt/pdf-tei-editor/blob/main/rules.md#L1-L10" subtype="machine" type="markdown"/>
      </p>
    </interpretation>
  </editorialDecl></encodingDesc></teiHeader>
</TEI>"""

XML_MACHINE_ONLY = """<?xml version="1.0"?>
<TEI xmlns="http://www.tei-c.org/ns/1.0">
  <teiHeader><encodingDesc><editorialDecl>
    <interpretation type="footnote-annotation">
      <p><ref target="https://github.com/mpilhlt/pdf-tei-editor/blob/main/rules.md#L20-L30" subtype="machine" type="markdown"/></p>
    </interpretation>
  </editorialDecl></encodingDesc></teiHeader>
</TEI>"""

XML_SEPARATE_MACHINE_FILE = """<?xml version="1.0"?>
<TEI xmlns="http://www.tei-c.org/ns/1.0">
  <teiHeader><encodingDesc><editorialDecl>
    <interpretation type="primary" n="Citation model">
      <p>
        <ref target="https://github.com/mpilhlt/fossil/blob/main/docs/guidelines.md#citation-model" subtype="human" type="markdown"/>
        <ref target="https://github.com/mpilhlt/fossil/blob/main/docs/guidelines-llm.md#L28-L53" subtype="machine" type="markdown"/>
      </p>
    </interpretation>
  </editorialDecl></encodingDesc></teiHeader>
</TEI>"""

XML_SAME_FILE_MACHINE = """<?xml version="1.0"?>
<TEI xmlns="http://www.tei-c.org/ns/1.0">
  <teiHeader><encodingDesc><editorialDecl>
    <interpretation type="primary">
      <p>
        <ref target="https://github.com/mpilhlt/fossil/blob/main/docs/guide.md#a" subtype="human" type="markdown"/>
        <ref target="https://github.com/mpilhlt/fossil/blob/main/docs/guide.md#L3-L6" subtype="machine" type="markdown"/>
      </p>
    </interpretation>
  </editorialDecl></encodingDesc></teiHeader>
</TEI>"""

# Line 28 is a heading; line 27 is not.
GUIDELINES_LLM_TEXT = "\n".join(["intro"] * 26 + ["", "## Citation model", "Cite things."] + ["more"] * 40)

_FETCH_EXCERPT = "fastapi_app.lib.doc_rules.interpretation_ref_kind.fetch_rule_excerpt"

XML_SCHEMA_FRAGMENT = """<?xml version="1.0"?>
<TEI xmlns="http://www.tei-c.org/ns/1.0">
  <teiHeader><encodingDesc><editorialDecl>
    <interpretation type="schema-fragment" n="Segmentation schema source">
      <p><ref target="https://github.com/mpilhlt/fossil/blob/sha1/schema/grobid.training.segmentation.rng" subtype="human" type="xml"/></p>
    </interpretation>
  </editorialDecl></encodingDesc></teiHeader>
</TEI>"""


class TestInterpretationRefKindDiscover(unittest.TestCase):
    def setUp(self):
        self.kind = InterpretationRefKind()

    def test_label_falls_back_to_type_when_no_n(self):
        descriptors = self.kind.discover(XML_TWO_REFS_HUMAN_AND_MACHINE)
        self.assertEqual(descriptors[0].label, "primary")

    def test_label_uses_n_when_present(self):
        descriptors = self.kind.discover(XML_ONE_ENTRY_WITH_LABEL)
        self.assertEqual(descriptors[0].label, "Data correction")

    def test_separate_machine_file_yields_two_layers(self):
        with patch(_FETCH_EXCERPT, return_value=GUIDELINES_LLM_TEXT):
            descriptors = self.kind.discover(XML_SEPARATE_MACHINE_FILE)
        self.assertEqual([d.layer for d in descriptors], ["human", "machine"])
        self.assertEqual({d.group for d in descriptors}, {"interpretation-ref:primary"})
        self.assertEqual({d.label for d in descriptors}, {"Citation model"})
        self.assertTrue(descriptors[0].url.endswith("guidelines.md#citation-model"))
        self.assertEqual(descriptors[0].related_urls, [descriptors[0].url])
        self.assertTrue(descriptors[1].url.endswith("guidelines-llm.md#L28-L53"))
        self.assertTrue(descriptors[1].key.endswith("guidelines-llm.md#citation-model"))
        self.assertEqual(descriptors[1].related_urls, [descriptors[1].url])

    def test_same_file_machine_ref_folds_into_human_layer(self):
        descriptors = self.kind.discover(XML_SAME_FILE_MACHINE)
        self.assertEqual(len(descriptors), 1)
        self.assertEqual(descriptors[0].layer, "human")
        self.assertTrue(descriptors[0].url.endswith("guide.md#a"))
        self.assertEqual(descriptors[0].related_urls, [
            "https://github.com/mpilhlt/fossil/blob/main/docs/guide.md#a",
            "https://github.com/mpilhlt/fossil/blob/main/docs/guide.md#L3-L6",
        ])

    def test_falls_back_to_human_ref_when_no_machine_ref(self):
        descriptors = self.kind.discover(XML_ONE_ENTRY_WITH_LABEL)
        self.assertEqual(len(descriptors), 1)
        self.assertTrue(descriptors[0].url.endswith("/rules.md"))

    def test_sole_machine_ref_is_machine_layer(self):
        with patch(_FETCH_EXCERPT, return_value="no headings here"):
            descriptors = self.kind.discover(XML_MACHINE_ONLY)
        self.assertEqual(len(descriptors), 1)
        self.assertEqual(descriptors[0].layer, "machine")
        self.assertEqual(descriptors[0].group, "interpretation-ref:footnote-annotation")
        self.assertTrue(descriptors[0].url.endswith("#L20-L30"))
        self.assertEqual(descriptors[0].related_urls, [descriptors[0].url])

    def test_kind_and_format(self):
        descriptors = self.kind.discover(XML_ONE_ENTRY_WITH_LABEL)
        self.assertEqual(descriptors[0].kind, "interpretation-ref")
        self.assertEqual(descriptors[0].format, "markdown")

    def test_no_editorial_decl_returns_empty(self):
        self.assertEqual(self.kind.discover("<TEI xmlns='http://www.tei-c.org/ns/1.0'/>"), [])

    def test_schema_fragment_entry_resolves_to_xml_format_and_configured_label(self):
        descriptors = self.kind.discover(XML_SCHEMA_FRAGMENT)
        self.assertEqual(len(descriptors), 1)
        self.assertEqual(descriptors[0].format, "xml")
        self.assertEqual(descriptors[0].label, "Segmentation schema source")
        self.assertTrue(descriptors[0].url.endswith("grobid.training.segmentation.rng"))


class TestInterpretationRefKindResourceKey(unittest.TestCase):
    def setUp(self):
        self.kind = InterpretationRefKind()

    def test_heading_anchor_url_keeps_anchor_without_fetching(self):
        with patch(_FETCH_EXCERPT) as mock_fetch:
            key = self.kind.resource_key("https://github.com/mpilhlt/fossil/blob/main/docs/guidelines.md#citation-model")
        mock_fetch.assert_not_called()
        self.assertTrue(key.endswith("guidelines.md#citation-model"))

    def test_resource_key_maps_line_range_to_heading(self):
        base = "https://github.com/mpilhlt/fossil/blob/main/docs/guidelines-llm.md"
        with patch(_FETCH_EXCERPT, return_value=GUIDELINES_LLM_TEXT) as mock_fetch:
            key_a = self.kind.resource_key(f"{base}#L28-L53")
            key_b = self.kind.resource_key(f"{base}#L28-L60")
        self.assertTrue(key_a.endswith("guidelines-llm.md#citation-model"))
        self.assertEqual(key_a, key_b)
        # The whole file is fetched, not the excerpt
        self.assertEqual(mock_fetch.call_args[0][0], base)

    def test_resource_key_falls_back_to_legacy_when_no_heading_at_start(self):
        url = "https://github.com/mpilhlt/fossil/blob/main/docs/guidelines-llm.md#L27-L53"
        with patch(_FETCH_EXCERPT, return_value=GUIDELINES_LLM_TEXT):
            key = self.kind.resource_key(url)
        self.assertEqual(key, legacy_resource_key(url))
        self.assertTrue(key.endswith("#L27-L53"))

    def test_resource_key_falls_back_to_legacy_on_fetch_failure(self):
        url = "https://github.com/mpilhlt/fossil/blob/main/docs/guidelines-llm.md#L28-L53"
        with patch(_FETCH_EXCERPT, side_effect=RuleFetchError("boom")):
            key = self.kind.resource_key(url)
        self.assertEqual(key, legacy_resource_key(url))

    def test_url_without_fragment_uses_normalized_key(self):
        url = "https://github.com/mpilhlt/fossil/blob/main/docs/guidelines.md"
        self.assertEqual(self.kind.resource_key(url), normalize_resource_key(url))


class TestLayerRefs(unittest.TestCase):
    @staticmethod
    def _ref(target: str, subtype: Literal["human", "machine"]) -> AnnotationRuleRefTarget:
        return {"target": target, "content_type": "markdown", "subtype": subtype}

    def test_sha_pinned_same_file_is_folded(self):
        # Bases are compared after strip_ref, so differing pinned refs still fold
        entry: AnnotationRuleRef = {"category": "primary", "refs": [
            self._ref("https://github.com/o/r/blob/main/guide.md#a", "human"),
            self._ref("https://github.com/o/r/blob/0123456789abcdef0123456789abcdef01234567/guide.md#L1-L2", "machine"),
        ]}
        self.assertEqual(list(layer_refs(entry)), ["human"])

    def test_human_only(self):
        entry: AnnotationRuleRef = {"category": "primary", "refs": [self._ref("https://example.com/g.md", "human")]}
        self.assertEqual(list(layer_refs(entry)), ["human"])


class TestInterpretationRefKindResolveOriginal(unittest.TestCase):
    def test_resolve_original_returns_section_for_heading_anchor(self):
        kind = InterpretationRefKind()
        url = "https://example.com/rules.md#citation-model"
        with patch(
            "fastapi_app.lib.doc_rules.interpretation_ref_kind.fetch_rule_section",
            return_value="## Citation model\nCite things.",
        ) as mock_fetch:
            result = kind.resolve_original(url)
        self.assertEqual(result, "## Citation model\nCite things.")
        mock_fetch.assert_called_once()
        self.assertEqual(mock_fetch.call_args[0][0], url)


class TestSelectedRuleOverrideText(unittest.TestCase):
    HUMAN = "https://example.com/rules/guide.md#citations"
    MACHINE_SEPARATE = "https://example.com/rules/machine.md#citations"
    MACHINE_FOLDED = "https://example.com/rules/guide.md#L10-L20"

    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.store = DocumentRulesStore(DatabaseManager(Path(self.temp_dir.name) / "test.db"))
        self.kind = InterpretationRefKind()

    def tearDown(self):
        self.temp_dir.cleanup()

    @staticmethod
    def _entry(*refs: tuple[str, Literal["human", "machine"]]) -> AnnotationRuleRef:
        return {"category": "primary", "refs": [
            {"target": t, "content_type": "markdown", "subtype": st} for t, st in refs
        ]}

    def _select(self, url: str, text: str) -> None:
        override = self.store.create_override(
            kind="interpretation-ref", resource_key=self.kind.resource_key(url), owner="alice",
            note="", text=text, format="markdown", base_url=url, base_hash="h",
        )
        self.store.set_selection("interpretation-ref", self.kind.resource_key(url), "alice", override["id"])

    def test_reviewer_uses_machine_layer_override_when_separate_file(self):
        entry = self._entry((self.HUMAN, "human"), (self.MACHINE_SEPARATE, "machine"))
        self._select(self.HUMAN, "human text")
        self._select(self.MACHINE_SEPARATE, "machine text")
        self.assertEqual(selected_rule_override_text(self.store, entry, "alice"), "machine text")

    def test_reviewer_uses_human_layer_override_when_machine_folded(self):
        entry = self._entry((self.HUMAN, "human"), (self.MACHINE_FOLDED, "machine"))
        self._select(self.HUMAN, "human text")
        self.assertEqual(selected_rule_override_text(self.store, entry, "alice"), "human text")

    def test_reviewer_ignores_human_override_when_separate_machine_file(self):
        entry = self._entry((self.HUMAN, "human"), (self.MACHINE_SEPARATE, "machine"))
        self._select(self.HUMAN, "human text")
        self.assertIsNone(selected_rule_override_text(self.store, entry, "alice"))

    def test_unsafe_url_is_not_fetched_and_uses_legacy_key(self):
        url = "https://internal.example/machine.md#L28-L53"
        entry = self._entry((self.HUMAN, "human"), (url, "machine"))
        override = self.store.create_override(
            kind="interpretation-ref", resource_key=legacy_resource_key(url), owner="alice",
            note="", text="legacy text", format="markdown", base_url=url, base_hash="h",
        )
        self.store.set_selection("interpretation-ref", legacy_resource_key(url), "alice", override["id"])
        with patch(_FETCH_EXCERPT) as mock_fetch:
            result = selected_rule_override_text(self.store, entry, "alice", is_safe_url=lambda u: False)
        mock_fetch.assert_not_called()
        self.assertEqual(result, "legacy text")

    def test_safe_line_range_url_is_fetched_without_redirects_and_migrates_legacy_override(self):
        base = "https://github.com/mpilhlt/fossil/blob/main/docs/guidelines-llm.md"
        url = f"{base}#L28-L53"
        entry = self._entry((self.HUMAN, "human"), (url, "machine"))
        legacy_key = legacy_resource_key(url)
        override = self.store.create_override(
            kind="interpretation-ref", resource_key=legacy_key, owner="alice",
            note="", text="migrated text", format="markdown", base_url=url, base_hash="h",
        )
        self.store.set_selection("interpretation-ref", legacy_key, "alice", override["id"])
        with patch(_FETCH_EXCERPT, return_value=GUIDELINES_LLM_TEXT) as mock_fetch:
            result = selected_rule_override_text(self.store, entry, "alice", is_safe_url=lambda u: True)
        self.assertEqual(result, "migrated text")
        self.assertIs(mock_fetch.call_args.kwargs["allow_redirects"], False)
        self.assertIsNone(self.store.get_selection("interpretation-ref", legacy_key, "alice"))
