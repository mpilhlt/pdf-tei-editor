"""
Unit tests for schema_validator.validate()'s schema_text_override seam.

@testCovers fastapi_app/lib/core/schema_validator.py:validate
"""

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi_app.lib.core.schema_validator import (
    MAX_SCHEMA_OVERRIDE_BYTES,
    ValidationError,
    get_schema_cache_info,
    validate,
)

SCHEMA_LOCATION = "https://example.com/schema/tei.rng"

XML_DOC = f"""<?xml version="1.0"?>
<?xml-model href="{SCHEMA_LOCATION}" schematypens="http://relaxng.org/ns/structure/1.0"?>
<root xmlns="http://www.tei-c.org/ns/1.0"><child/></root>
"""

# Permissive: any single root element with any content is valid.
PERMISSIVE_SCHEMA = """<?xml version="1.0" encoding="UTF-8"?>
<grammar xmlns="http://relaxng.org/ns/structure/1.0" datatypeLibrary="">
  <start>
    <element name="root" ns="http://www.tei-c.org/ns/1.0">
      <zeroOrMore><element name="child" ns="http://www.tei-c.org/ns/1.0"><empty/></element></zeroOrMore>
    </element>
  </start>
</grammar>
"""

# Strict: forbids the "child" element the test document actually has.
STRICT_SCHEMA_FORBIDDING_CHILD = """<?xml version="1.0" encoding="UTF-8"?>
<grammar xmlns="http://relaxng.org/ns/structure/1.0" datatypeLibrary="">
  <start>
    <element name="root" ns="http://www.tei-c.org/ns/1.0">
      <empty/>
    </element>
  </start>
</grammar>
"""


class TestSchemaTextOverride(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.cache_root = Path(self.temp_dir.name)
        # Pre-populate the shared cache with the permissive schema, as if
        # a prior, non-overriding validation had already cached it.
        cache_dir, cache_file, _ = get_schema_cache_info(SCHEMA_LOCATION, self.cache_root)
        cache_dir.mkdir(parents=True, exist_ok=True)
        cache_file.write_text(PERMISSIVE_SCHEMA, encoding="utf-8")
        self.cache_file = cache_file

    def tearDown(self):
        self.temp_dir.cleanup()

    def test_no_override_uses_the_shared_cache_and_validates_clean(self):
        errors = validate(XML_DOC, cache_root=self.cache_root)
        self.assertEqual(errors, [])

    def test_override_is_used_instead_of_cache_and_changes_the_result(self):
        errors = validate(
            XML_DOC,
            cache_root=self.cache_root,
            schema_text_override={SCHEMA_LOCATION: STRICT_SCHEMA_FORBIDDING_CHILD},
        )
        self.assertTrue(errors, "expected the stricter override schema to reject <child/>")

    def test_override_never_writes_to_the_shared_cache_file(self):
        original_cache_content = self.cache_file.read_text(encoding="utf-8")
        validate(
            XML_DOC,
            cache_root=self.cache_root,
            schema_text_override={SCHEMA_LOCATION: STRICT_SCHEMA_FORBIDDING_CHILD},
        )
        self.assertEqual(self.cache_file.read_text(encoding="utf-8"), original_cache_content)

    def test_override_does_not_trigger_a_download(self):
        with patch("fastapi_app.lib.core.schema_validator.download_schema_file") as mock_download:
            validate(
                XML_DOC,
                cache_root=self.cache_root,
                schema_text_override={SCHEMA_LOCATION: STRICT_SCHEMA_FORBIDDING_CHILD},
            )
        mock_download.assert_not_called()

    def test_override_for_a_different_location_is_ignored(self):
        errors = validate(
            XML_DOC,
            cache_root=self.cache_root,
            schema_text_override={"https://example.com/other-schema.rng": STRICT_SCHEMA_FORBIDDING_CHILD},
        )
        self.assertEqual(errors, [], "override keyed by an unrelated location must not affect this document")

    def test_default_schema_text_override_is_none_and_behaves_like_before(self):
        # No schema_text_override argument at all - byte-for-byte today's behavior.
        errors = validate(XML_DOC, cache_root=self.cache_root)
        self.assertEqual(errors, [])

    def test_temp_file_used_for_override_does_not_linger(self):
        import glob
        import os
        before = set(glob.glob(os.path.join(tempfile.gettempdir(), "*")))
        validate(
            XML_DOC,
            cache_root=self.cache_root,
            schema_text_override={SCHEMA_LOCATION: STRICT_SCHEMA_FORBIDDING_CHILD},
        )
        after = set(glob.glob(os.path.join(tempfile.gettempdir(), "*")))
        self.assertEqual(before, after, "the override's temporary schema file must be cleaned up")

    def test_oversized_override_is_rejected_without_writing_a_temp_file(self):
        import glob
        import os
        oversized_text = "x" * (MAX_SCHEMA_OVERRIDE_BYTES + 1)
        before = set(glob.glob(os.path.join(tempfile.gettempdir(), "*")))

        with self.assertRaises(ValidationError):
            validate(
                XML_DOC,
                cache_root=self.cache_root,
                schema_text_override={SCHEMA_LOCATION: oversized_text},
            )

        after = set(glob.glob(os.path.join(tempfile.gettempdir(), "*")))
        self.assertEqual(before, after, "an oversized override must be rejected before any temp file is written")

    def test_override_at_exactly_the_size_limit_is_accepted(self):
        exactly_at_limit = PERMISSIVE_SCHEMA + " " * (MAX_SCHEMA_OVERRIDE_BYTES - len(PERMISSIVE_SCHEMA.encode("utf-8")))
        self.assertEqual(len(exactly_at_limit.encode("utf-8")), MAX_SCHEMA_OVERRIDE_BYTES)
        errors = validate(
            XML_DOC,
            cache_root=self.cache_root,
            schema_text_override={SCHEMA_LOCATION: exactly_at_limit},
        )
        self.assertEqual(errors, [])
