"""
Unit tests for the upstream cleanup status of a rule category's overrides.

@testCovers fastapi_app/lib/doc_rules/upstream_cleanup.py
"""

import tempfile
import unittest
from pathlib import Path
from typing import Union
from unittest.mock import MagicMock, patch

from fastapi_app.lib.core.database import DatabaseManager
from fastapi_app.lib.doc_rules import upstream_cleanup
from fastapi_app.lib.doc_rules.interpretation_ref_kind import InterpretationRefKind
from fastapi_app.lib.doc_rules.resource_key import normalize_resource_key
from fastapi_app.lib.doc_rules.rules_refresh import ResourceRefreshOutcome
from fastapi_app.lib.doc_rules.storage import DocumentRulesStore
from fastapi_app.lib.doc_rules.upstream_cleanup import (
    CategoryNotFoundError,
    category_layers,
    matches_upstream,
    remove_overrides_in_upstream,
    upstream_status,
)
from fastapi_app.lib.doc_rules.upstream_proposal import ProposalError

HUMAN_URL = "https://github.com/o/r/blob/abc/docs/g.md#data-correction"
MACHINE_URL = "https://github.com/o/r/blob/abc/docs/g-llm.md#data-correction"
UPSTREAM = "## Data correction\n\nRule one.\n"

TEI = f"""<?xml version="1.0"?>
<TEI xmlns="http://www.tei-c.org/ns/1.0">
  <teiHeader><encodingDesc><editorialDecl>
    <interpretation type="data-correction" n="Data correction">
      <p><ref target="{HUMAN_URL}" subtype="human" type="markdown"/>
      <ref target="{MACHINE_URL}" subtype="machine" type="markdown"/></p>
    </interpretation>
  </editorialDecl></encodingDesc></teiHeader>
</TEI>"""


class UpstreamCleanupTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.store = DocumentRulesStore(DatabaseManager(Path(self.temp_dir.name) / "test.db"))
        self.cache = MagicMock()
        self.sections: dict[str, Union[str, Exception]] = {HUMAN_URL: UPSTREAM, MACHINE_URL: UPSTREAM}
        self.refresh = ResourceRefreshOutcome(status="ok", refs=[], changed=False, message="")
        patches = (
            patch.object(InterpretationRefKind, "resource_key", lambda self, url, strict=False, allow_redirects=True: normalize_resource_key(url)),
            patch.object(upstream_cleanup, "upstream_section", self._section),
            patch.object(upstream_cleanup, "plan_resource_refresh", lambda tei, url, cache: self.refresh),
        )
        for p in patches:
            p.start()
            self.addCleanup(p.stop)

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def _section(self, url: str, cache: object) -> str:
        section = self.sections[url]
        if isinstance(section, Exception):
            raise section
        return section

    def _override(self, url: str, text: str, owner: str = "alice") -> str:
        return self.store.create_override(
            "interpretation-ref", normalize_resource_key(url), owner, "", text, "markdown", url, "h"
        )["id"]

    def _ids(self, url: str, owner: str = "alice") -> list[str]:
        return [o["id"] for o in self.store.list_overrides("interpretation-ref", normalize_resource_key(url), owner)]


class TestCategoryLayers(UpstreamCleanupTestCase):
    def test_category_layers_finds_both_layers_from_either_url(self) -> None:
        for url in (HUMAN_URL, MACHINE_URL):
            layers = category_layers(TEI, url)
            self.assertEqual([d.layer for d in layers], ["human", "machine"])
            self.assertEqual([d.url for d in layers], [HUMAN_URL, MACHINE_URL])

    def test_category_layers_unknown_url_raises(self) -> None:
        with self.assertRaises(CategoryNotFoundError):
            category_layers(TEI, "https://github.com/o/r/blob/abc/docs/x.md#y")


class TestMatchesUpstream(unittest.TestCase):
    def test_matches_upstream_ignores_sync_markers(self) -> None:
        self.assertTrue(matches_upstream("## A\n\n<!-- sync: guide=1 llm=2 -->\n\nRule.\n", "## A\n<!-- sync: guide=3 llm=4 -->\nRule.", HUMAN_URL))

    def test_matches_upstream_ignores_link_form(self) -> None:
        text = "## A\n[x](https://github.com/o/r/blob/abc/docs/other.md)"
        self.assertTrue(matches_upstream(text, "## A\n[x](other.md)", "https://github.com/o/r/blob/abc/docs/g.md#a"))

    def test_matches_upstream_detects_a_changed_rule(self) -> None:
        self.assertFalse(matches_upstream("## A\nRule.\nExtra.", "## A\nRule.", HUMAN_URL))


class TestStatus(UpstreamCleanupTestCase):
    def test_status_marks_matching_and_keeps_others(self) -> None:
        id1 = self._override(MACHINE_URL, UPSTREAM)
        id2 = self._override(MACHINE_URL, UPSTREAM + "Mine.\n")
        machine = upstream_status(TEI, HUMAN_URL, self.store, "alice", self.cache).layers[1]
        self.assertEqual((machine.layer, machine.in_upstream, machine.kept, machine.error), ("machine", [id1], [id2], None))

    def test_status_layer_error_marks_nothing(self) -> None:
        h1 = self._override(HUMAN_URL, UPSTREAM)
        m1 = self._override(MACHINE_URL, UPSTREAM)
        self.sections[HUMAN_URL] = ProposalError("gone")
        human, machine = upstream_status(TEI, HUMAN_URL, self.store, "alice", self.cache).layers
        self.assertEqual((human.error, human.in_upstream, human.kept), ("gone", [], [h1]))
        self.assertEqual((machine.error, machine.in_upstream), (None, [m1]))

    def test_status_refs_behind_from_refresh(self) -> None:
        self.refresh = ResourceRefreshOutcome(status="ok", refs=[], changed=True, message="")
        self.assertTrue(upstream_status(TEI, HUMAN_URL, self.store, "alice", self.cache).refs_behind)
        self.refresh = ResourceRefreshOutcome(status="unavailable", refs=[], changed=False, message="offline")
        status = upstream_status(TEI, HUMAN_URL, self.store, "alice", self.cache)
        self.assertFalse(status.refs_behind)
        self.assertEqual(status.refresh_message, "offline")


class TestRemove(UpstreamCleanupTestCase):
    def test_remove_deletes_only_matching_overrides(self) -> None:
        match = self._override(MACHINE_URL, UPSTREAM)
        keep = self._override(MACHINE_URL, UPSTREAM + "Mine.\n")
        key = normalize_resource_key(MACHINE_URL)
        self.store.set_selection("interpretation-ref", key, "alice", match)
        status = remove_overrides_in_upstream(TEI, HUMAN_URL, self.store, "alice", self.cache)
        self.assertEqual(status.layers[1].in_upstream, [match])
        self.assertEqual(self._ids(MACHINE_URL), [keep])
        self.assertIsNone(self.store.get_selection("interpretation-ref", key, "alice"))

    def test_remove_rechecks_instead_of_trusting_an_earlier_status(self) -> None:
        override = self._override(MACHINE_URL, UPSTREAM)
        self.assertEqual(upstream_status(TEI, HUMAN_URL, self.store, "alice", self.cache).layers[1].in_upstream, [override])
        self.sections[MACHINE_URL] = "## Data correction\n\nChanged.\n"
        remove_overrides_in_upstream(TEI, HUMAN_URL, self.store, "alice", self.cache)
        self.assertEqual(self._ids(MACHINE_URL), [override])

    def test_remove_ignores_other_users_overrides(self) -> None:
        bob = self._override(MACHINE_URL, UPSTREAM, owner="bob")
        remove_overrides_in_upstream(TEI, HUMAN_URL, self.store, "alice", self.cache)
        self.assertEqual(self._ids(MACHINE_URL, "bob"), [bob])


if __name__ == "__main__":
    unittest.main()
