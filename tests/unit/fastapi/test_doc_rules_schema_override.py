"""
Unit tests for bridging document-rules schema overrides into
schema_validator.validate()'s schema_text_override seam.

@testCovers fastapi_app/lib/doc_rules/schema_override.py
"""

import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock

from fastapi_app.lib.core.database import DatabaseManager
from fastapi_app.lib.doc_rules.resource_key import normalize_resource_key
from fastapi_app.lib.doc_rules.schema_override import build_schema_text_override
from fastapi_app.lib.doc_rules.storage import DocumentRulesStore

RELAXNG_LOCATION = "https://example.com/schema/tei.rng"

XML_RELAXNG = f"""<?xml version="1.0"?>
<?xml-model href="{RELAXNG_LOCATION}" schematypens="http://relaxng.org/ns/structure/1.0"?>
<TEI xmlns="http://www.tei-c.org/ns/1.0"/>
"""

XML_XSD = """<?xml version="1.0"?>
<root xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
      xsi:schemaLocation="http://example.com/ns https://example.com/schema/doc.xsd">
</root>
"""


class TestBuildSchemaTextOverride(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.db = DatabaseManager(Path(self.temp_dir.name) / "test.db")
        self.store = DocumentRulesStore(self.db)

    def tearDown(self):
        self.temp_dir.cleanup()

    def test_no_selection_yields_empty_dict(self):
        result = build_schema_text_override(XML_RELAXNG, self.store, "alice")
        self.assertEqual(result, {})

    def test_selected_override_is_keyed_by_resolved_location(self):
        override = self.store.create_override(
            kind="schema",
            resource_key=normalize_resource_key(RELAXNG_LOCATION),
            owner="alice",
            note="",
            text="<grammar/>",
            format="xml",
            base_url=RELAXNG_LOCATION,
            base_hash="hash",
        )
        self.store.set_selection("schema", normalize_resource_key(RELAXNG_LOCATION), "alice", override["id"])

        result = build_schema_text_override(XML_RELAXNG, self.store, "alice")

        self.assertEqual(result, {RELAXNG_LOCATION: "<grammar/>"})

    def test_selection_belonging_to_a_different_user_is_ignored(self):
        override = self.store.create_override(
            kind="schema",
            resource_key=normalize_resource_key(RELAXNG_LOCATION),
            owner="alice",
            note="",
            text="<grammar/>",
            format="xml",
            base_url=RELAXNG_LOCATION,
            base_hash="hash",
        )
        self.store.set_selection("schema", normalize_resource_key(RELAXNG_LOCATION), "alice", override["id"])

        result = build_schema_text_override(XML_RELAXNG, self.store, "bob")

        self.assertEqual(result, {})

    def test_xsd_locations_are_never_included(self):
        # Even a real selected override for this key must be skipped, since
        # XSD is out of scope for the schema resource kind (v1) - discover()
        # never surfaces it, so nothing could legitimately be selected for
        # it, but build_schema_text_override must not assume that and should
        # filter by type itself too.
        result = build_schema_text_override(XML_XSD, self.store, "alice")
        self.assertEqual(result, {})

    def test_respects_a_registered_schema_redirect(self):
        from fastapi_app.lib.core import schema_validator

        old_location = "https://old.example.com/schema/tei.rng"
        new_location = "https://new.example.com/schema/tei.rng"
        schema_validator.register_schema_redirect(old_location, new_location)
        self.addCleanup(schema_validator.unregister_schema_redirect, old_location)

        xml = f"""<?xml version="1.0"?>
        <?xml-model href="{old_location}" schematypens="http://relaxng.org/ns/structure/1.0"?>
        <TEI xmlns="http://www.tei-c.org/ns/1.0"/>
        """
        override = self.store.create_override(
            kind="schema",
            resource_key=normalize_resource_key(old_location),
            owner="alice",
            note="",
            text="<grammar/>",
            format="xml",
            base_url=old_location,
            base_hash="hash",
        )
        self.store.set_selection("schema", normalize_resource_key(old_location), "alice", override["id"])

        result = build_schema_text_override(xml, self.store, "alice")

        # Selected/keyed by the raw (old) URL, but the dict validate() needs
        # must be keyed by the resolved (new) URL.
        self.assertEqual(result, {new_location: "<grammar/>"})
