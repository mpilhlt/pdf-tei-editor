"""
Unit tests for the revision hash chain and the parent derivation of migration 010.

@testCovers fastapi_app/lib/utils/revision_hash.py
@testCovers fastapi_app/lib/core/migrations/versions/m010_add_parent_stable_id_column.py
"""

import unittest

from lxml import etree

from fastapi_app.lib.core.migrations.versions.m010_add_parent_stable_id_column import find_parents
from fastapi_app.lib.utils.revision_hash import (
    canonical_text,
    chain_hash,
    has_unrevised_edits,
    head_hash,
    stamp_revision_hashes,
)


def make_tei(changes: str, text: str = "<body><p>Hello <hi>world</hi></p></body>", standoff: str = "") -> str:
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<TEI xmlns="http://www.tei-c.org/ns/1.0">
  <teiHeader>
    <fileDesc><titleStmt><title>T</title></titleStmt></fileDesc>
    <revisionDesc>
{changes}
    </revisionDesc>
  </teiHeader>
  <text>{text}</text>{standoff}
</TEI>"""


DRAFT = '      <change when="2026-10-01T10:00:00Z" who="#anna" status="draft"><desc>First</desc></change>'
REVIEW = '      <change when="2026-10-02T10:00:00Z" who="#anna" status="in-review"><desc>Second</desc></change>'


def ids(xml: str) -> list[str | None]:
    root = etree.fromstring(xml.encode("utf-8"))
    ns = {"tei": "http://www.tei-c.org/ns/1.0"}
    return [c.get("{http://www.w3.org/XML/1998/namespace}id") for c in root.findall("tei:teiHeader/tei:revisionDesc/tei:change", ns)]


class TestCanonicalText(unittest.TestCase):

    def test_reindenting_is_no_change(self):
        a = etree.fromstring(make_tei(DRAFT).encode())
        b = etree.fromstring(make_tei(DRAFT, text="\n    <body>\n      <p>Hello\n        <hi>world</hi></p>\n    </body>\n  ").encode())
        self.assertEqual(canonical_text(a), canonical_text(b))

    def test_word_change_is_a_change(self):
        a = etree.fromstring(make_tei(DRAFT).encode())
        b = etree.fromstring(make_tei(DRAFT, text="<body><p>Hallo <hi>world</hi></p></body>").encode())
        self.assertNotEqual(canonical_text(a), canonical_text(b))

    def test_header_and_standoff_are_ignored(self):
        a = etree.fromstring(make_tei(DRAFT).encode())
        b = etree.fromstring(make_tei(DRAFT + "\n" + REVIEW, standoff="<standOff><listAnnotation type=\"unit-comment\"/></standOff>").encode())
        self.assertEqual(canonical_text(a), canonical_text(b))

    def test_comments_are_ignored(self):
        a = etree.fromstring(make_tei(DRAFT).encode())
        b = etree.fromstring(make_tei(DRAFT, text="<body><p>Hello <!-- note --><hi>world</hi></p></body>").encode())
        self.assertEqual(canonical_text(a), canonical_text(b))


class TestStampRevisionHashes(unittest.TestCase):

    def test_new_document_stamps_last_change_only(self):
        stamped = stamp_revision_hashes(make_tei(DRAFT + "\n" + REVIEW))
        result = ids(stamped)
        self.assertIsNone(result[0])
        root = etree.fromstring(stamped.encode())
        self.assertEqual(result[1], "h-" + chain_hash("", canonical_text(root)))

    def test_rest_of_document_unchanged(self):
        xml = make_tei(DRAFT)
        stamped = stamp_revision_hashes(xml)
        self.assertEqual(stamped.replace(f' xml:id="{ids(stamped)[0]}"', ""), xml)

    def test_hashes_are_chained(self):
        first = stamp_revision_hashes(make_tei(DRAFT))
        # the editor's copy has no ids; a revision is added after an edit
        edited = make_tei(DRAFT + "\n" + REVIEW, text="<body><p>Hello <hi>there</hi></p></body>")
        second = stamp_revision_hashes(edited, first)
        first_id, second_id = ids(second)
        self.assertEqual(first_id, ids(first)[0])
        root = etree.fromstring(second.encode())
        self.assertEqual(second_id, "h-" + chain_hash(first_id[2:], canonical_text(root)))

    def test_autosave_keeps_hash(self):
        """An edit without a new revision keeps the stored hash and does not re-stamp."""
        stored = stamp_revision_hashes(make_tei(DRAFT))
        autosaved = stamp_revision_hashes(make_tei(DRAFT, text="<body><p>Edited</p></body>"), stored)
        self.assertEqual(ids(autosaved), ids(stored))
        self.assertTrue(has_unrevised_edits(etree.fromstring(autosaved.encode())))
        self.assertFalse(has_unrevised_edits(etree.fromstring(stored.encode())))

    def test_legacy_change_is_not_stamped_later(self):
        """A change without hash that already existed in the stored file stays without hash."""
        legacy = make_tei(DRAFT)
        result = stamp_revision_hashes(make_tei(DRAFT, text="<body><p>Edited</p></body>"), legacy)
        self.assertEqual(ids(result), [None])

    def test_standoff_changes_are_left_alone(self):
        standoff = """
  <standOff><listAnnotation type="unit-comment"><annotation xml:id="uc-000001"><revisionDesc>
    <change when="2026-10-24T09:00:00Z" who="#ben" status="resolved"/>
  </revisionDesc></annotation></listAnnotation></standOff>"""
        stamped = stamp_revision_hashes(make_tei(DRAFT, standoff=standoff))
        self.assertEqual(stamped.count("xml:id=\"h-"), 1)
        self.assertIn('<change when="2026-10-24T09:00:00Z" who="#ben" status="resolved"/>', stamped)
        self.assertIsNotNone(head_hash(etree.fromstring(stamped.encode())))

    def test_list_change_is_skipped(self):
        """With nested listChange the start tags cannot be matched to the changes, so nothing is stamped."""
        xml = make_tei(DRAFT + '\n      <listChange><change when="x"/></listChange>')
        self.assertEqual(stamp_revision_hashes(xml), xml)

    def test_no_revision_desc(self):
        xml = make_tei("").replace("<revisionDesc>\n\n    </revisionDesc>", "")
        self.assertEqual(stamp_revision_hashes(xml), xml)


class TestFindParents(unittest.TestCase):
    A = ("#a", "1", "draft")
    B = ("#a", "2", "in-review")
    C = ("#b", "3", "draft")

    def test_longest_prefix_is_parent(self):
        parents = find_parents({"gold": [self.A], "v1": [self.A, self.B], "v2": [self.A, self.B, self.C]})
        self.assertEqual(parents, {"v1": "gold", "v2": "v1"})

    def test_siblings_share_parent(self):
        parents = find_parents({"gold": [self.A], "v1": [self.A, self.B], "v2": [self.A, self.C]})
        self.assertEqual(parents, {"v1": "gold", "v2": "gold"})

    def test_ambiguous_parent_is_left_out(self):
        parents = find_parents({"x": [self.A], "y": [self.A], "v1": [self.A, self.B]})
        self.assertEqual(parents, {})

    def test_edited_ancestor_is_no_parent(self):
        """An ancestor that got a change after the copy was made is no longer a prefix."""
        parents = find_parents({"gold": [self.A, self.C], "v1": [self.A, self.B]})
        self.assertEqual(parents, {})


if __name__ == "__main__":
    unittest.main()
