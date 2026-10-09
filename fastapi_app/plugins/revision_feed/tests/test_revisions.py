"""
Unit tests for revision extraction and Atom feed building.

@testCovers fastapi_app/plugins/revision_feed/revisions.py
"""

import unittest
from datetime import datetime

from fastapi_app.plugins.revision_feed.revisions import (
    RevisionEntry,
    build_atom_feed,
    extract_revision_entries,
)

TEI_SAMPLE = """<?xml version="1.0" encoding="UTF-8"?>
<TEI xmlns="http://www.tei-c.org/ns/1.0">
  <teiHeader>
    <fileDesc>
      <titleStmt>
        <title>Sample</title>
        <respStmt>
          <persName xml:id="jdoe">Jane Doe</persName>
          <resp>Annotator</resp>
        </respStmt>
      </titleStmt>
    </fileDesc>
    <revisionDesc>
      <change when="2026-01-01T10:00:00" who="#jdoe" status="draft">
        <desc>First pass</desc>
      </change>
      <change when="2026-02-01T10:00:00" who="#jdoe" status="approved">
        <desc>Reviewed and approved</desc>
      </change>
      <change when="2026-03-01T10:00:00" who="#jdoe" status="extraction">
        <desc>Should be filtered out</desc>
      </change>
    </revisionDesc>
  </teiHeader>
</TEI>"""


class TestExtractRevisionEntries(unittest.TestCase):
    def test_extracts_one_entry_per_qualifying_change(self):
        entries = extract_revision_entries(
            TEI_SAMPLE,
            stable_id="stable-1",
            doc_label="Sample Doc",
            collection_id="col-1",
            included_statuses=["draft", "approved"],
        )

        self.assertEqual(len(entries), 2)
        statuses = {entry.status for entry in entries}
        self.assertEqual(statuses, {"draft", "approved"})

    def test_filters_out_excluded_statuses(self):
        entries = extract_revision_entries(
            TEI_SAMPLE,
            stable_id="stable-1",
            doc_label="Sample Doc",
            collection_id="col-1",
            included_statuses=["approved"],
        )

        self.assertEqual(len(entries), 1)
        self.assertEqual(entries[0].status, "approved")
        self.assertEqual(entries[0].description, "Reviewed and approved")
        self.assertEqual(entries[0].who, "Jane Doe")

    def test_no_qualifying_changes_returns_empty_list(self):
        entries = extract_revision_entries(
            TEI_SAMPLE,
            stable_id="stable-1",
            doc_label="Sample Doc",
            collection_id="col-1",
            included_statuses=["candidate"],
        )
        self.assertEqual(entries, [])

    def test_non_utc_offset_is_converted_to_utc(self):
        tei_with_offset = """<?xml version="1.0" encoding="UTF-8"?>
<TEI xmlns="http://www.tei-c.org/ns/1.0">
  <teiHeader>
    <fileDesc>
      <titleStmt>
        <title>Sample</title>
      </titleStmt>
    </fileDesc>
    <revisionDesc>
      <change when="2026-01-01T10:00:00+05:00" status="draft">
        <desc>Non-UTC offset</desc>
      </change>
    </revisionDesc>
  </teiHeader>
</TEI>"""

        entries = extract_revision_entries(
            tei_with_offset,
            stable_id="stable-1",
            doc_label="Sample Doc",
            collection_id="col-1",
            included_statuses=["draft"],
        )

        self.assertEqual(len(entries), 1)
        # 10:00 at +05:00 is 05:00 UTC
        self.assertEqual(entries[0].when, datetime(2026, 1, 1, 5, 0, 0))


class TestBuildAtomFeed(unittest.TestCase):
    def setUp(self):
        self.entries = [
            RevisionEntry(
                stable_id="stable-1",
                doc_label="Sample Doc",
                status="approved",
                when=datetime(2026, 2, 1, 10, 0, 0),
                who="Jane Doe",
                description="Reviewed and approved",
                collection_id="col-1",
            ),
            RevisionEntry(
                stable_id="stable-2",
                doc_label="Other Doc",
                status="draft",
                when=datetime(2026, 1, 1, 10, 0, 0),
                who="Jane Doe",
                description="First pass",
                collection_id="col-1",
            ),
        ]

    def test_builds_valid_atom_xml(self):
        from lxml import etree

        xml_text = build_atom_feed(
            project_id="proj-1",
            project_name="My Project",
            feed_url="http://example.test/api/plugins/revision-feed/feed/proj-1.atom?token=abc",
            entries=self.entries,
            app_base_url="http://example.test/",
        )

        root = etree.fromstring(xml_text.encode("utf-8"))
        ns = {"atom": "http://www.w3.org/2005/Atom"}
        entries = root.findall("atom:entry", ns)

        self.assertEqual(len(entries), 2)
        # Sorted newest-first
        first_title = entries[0].find("atom:title", ns).text
        self.assertIn("Sample Doc", first_title)
        self.assertIn("approved", first_title)

    def test_entry_link_uses_deep_link_scheme(self):
        from lxml import etree

        xml_text = build_atom_feed(
            project_id="proj-1",
            project_name="My Project",
            feed_url="http://example.test/feed",
            entries=self.entries[:1],
            app_base_url="http://example.test/",
        )

        root = etree.fromstring(xml_text.encode("utf-8"))
        ns = {"atom": "http://www.w3.org/2005/Atom"}
        link = root.find("atom:entry/atom:link", ns)

        self.assertEqual(link.get("href"), "http://example.test/#xml=stable-1&collection=col-1")

    def test_respects_max_entries(self):
        many_entries = self.entries * 30  # 60 entries
        xml_text = build_atom_feed(
            project_id="proj-1",
            project_name="My Project",
            feed_url="http://example.test/feed",
            entries=many_entries,
            app_base_url="http://example.test/",
            max_entries=10,
        )

        from lxml import etree
        root = etree.fromstring(xml_text.encode("utf-8"))
        ns = {"atom": "http://www.w3.org/2005/Atom"}
        self.assertEqual(len(root.findall("atom:entry", ns)), 10)

    def test_empty_entries_produces_valid_empty_feed(self):
        from lxml import etree

        xml_text = build_atom_feed(
            project_id="proj-1",
            project_name="My Project",
            feed_url="http://example.test/feed",
            entries=[],
            app_base_url="http://example.test/",
        )

        root = etree.fromstring(xml_text.encode("utf-8"))
        ns = {"atom": "http://www.w3.org/2005/Atom"}
        self.assertEqual(root.findall("atom:entry", ns), [])


if __name__ == "__main__":
    unittest.main()
