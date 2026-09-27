"""
Unit tests for fastapi_app/lib/doc_rules/rules_refresh.py.

@testCovers fastapi_app/lib/doc_rules/rules_refresh.py
"""

import unittest
from unittest import mock

from fastapi_app.lib.doc_rules.rules_providers import (
    register_document_rules_provider,
    unregister_document_rules_provider,
)
from fastapi_app.lib.doc_rules.rules_refresh import (
    RefreshPreconditionError,
    RefreshTarget,
    perform_refresh,
    preview_refresh,
    resolve_refresh_target,
)
from fastapi_app.lib.models.models import FileMetadata

TEI_WITH_PI_AND_DECL = """<?xml version="1.0"?>
<?xml-model href="https://mpilhlt.github.io/fossil/schema/grobid.training.segmentation.rng" type="application/xml" schematypens="http://relaxng.org/ns/structure/1.0"?>
<TEI xmlns="http://www.tei-c.org/ns/1.0">
  <teiHeader>
    <encodingDesc>
      <editorialDecl>
        <interpretation type="primary">
          <p><ref subtype="human" target="https://github.com/mpilhlt/fossil/blob/oldsha/docs/guidelines.md#seg" type="markdown">Guide</ref></p>
        </interpretation>
      </editorialDecl>
      <appInfo>
        <application version="0.8.0" ident="GROBID" type="extractor">
          <label type="variant-id">grobid.training.segmentation</label>
        </application>
      </appInfo>
    </encodingDesc>
  </teiHeader>
  <text><body><p>Body content.</p></body></text>
</TEI>
"""

TEI_LEGACY_NO_EDITORIAL_DECL_NO_PI = """<TEI xmlns="http://www.tei-c.org/ns/1.0">
  <teiHeader>
    <encodingDesc>
      <appInfo>
        <application version="0.8.0" ident="GROBID" type="extractor">
          <label type="variant-id">grobid.training.segmentation</label>
        </application>
      </appInfo>
    </encodingDesc>
  </teiHeader>
  <text><body><p>Body content.</p></body></text>
</TEI>
"""

TEI_NO_PROVENANCE = """<TEI xmlns="http://www.tei-c.org/ns/1.0">
  <teiHeader><encodingDesc/></teiHeader>
  <text><body><p>Body content.</p></body></text>
</TEI>
"""

# Mismatched <p>/</div> tags: lenient-parseable (extract_extractor_provenance()
# uses etree.XMLParser(recover=True), so provider lookup succeeds) but not
# strictly well-formed, so the plain etree.fromstring() inside
# _replace_editorial_decl()/_add_revision_change() raises XMLSyntaxError.
MALFORMED_TEI = """<TEI xmlns="http://www.tei-c.org/ns/1.0">
  <teiHeader>
    <encodingDesc>
      <appInfo>
        <application version="0.8.0" ident="GROBID" type="extractor">
          <label type="variant-id">grobid.training.segmentation</label>
        </application>
      </appInfo>
    </encodingDesc>
  </teiHeader>
  <text><body><p>Body content.</div></body></text>
</TEI>
"""


def make_tei_file(content: str, stable_id="tei-1", file_id="hash-old"):
    content_bytes = content.encode("utf-8")
    meta = FileMetadata(
        id=file_id,
        stable_id=stable_id,
        filename="doc.tei.xml",
        doc_id="doc-1",
        file_type="tei",
        file_size=len(content_bytes),
    )
    return meta, content_bytes


class FakeProvider:
    def __init__(self, entries=None, schema_url=None):
        self._entries = entries if entries is not None else []
        self._schema_url = schema_url

    def build_editorial_decl_entries(self, variant_id, cache):
        return self._entries

    def get_schema_url(self, variant_id):
        return self._schema_url


class TestResolveRefreshTarget(unittest.TestCase):
    def setUp(self):
        self.file_repo = mock.MagicMock()
        self.file_storage = mock.MagicMock()
        self.user = {"username": "reviewer1"}

    def test_raises_when_no_file(self):
        self.file_repo.get_file_by_stable_id.return_value = None
        with self.assertRaises(RefreshPreconditionError):
            resolve_refresh_target(self.file_repo, self.file_storage, "missing", self.user)

    @mock.patch("fastapi_app.lib.doc_rules.rules_refresh.check_file_access", return_value=False)
    def test_raises_when_permission_denied(self, _mock_access):
        meta, content = make_tei_file(TEI_WITH_PI_AND_DECL)
        self.file_repo.get_file_by_stable_id.return_value = meta
        self.file_storage.read_file.return_value = content
        with self.assertRaises(RefreshPreconditionError):
            resolve_refresh_target(self.file_repo, self.file_storage, "tei-1", self.user)
        self.file_storage.read_file.assert_not_called()

    @mock.patch("fastapi_app.lib.doc_rules.rules_refresh.check_file_access", return_value=True)
    def test_raises_when_content_missing(self, _mock_access):
        meta, _content = make_tei_file(TEI_WITH_PI_AND_DECL)
        self.file_repo.get_file_by_stable_id.return_value = meta
        self.file_storage.read_file.return_value = None
        with self.assertRaises(RefreshPreconditionError):
            resolve_refresh_target(self.file_repo, self.file_storage, "tei-1", self.user)

    @mock.patch("fastapi_app.lib.doc_rules.rules_refresh.check_file_access", return_value=True)
    def test_resolves_even_without_recognizable_extractor_variant(self, _mock_access):
        # Resolving a target no longer requires a readable extractor
        # variant - see RefreshTarget's docstring. Whether anything can
        # actually be refreshed is a separate, later check (provider lookup).
        meta, content = make_tei_file(TEI_NO_PROVENANCE)
        self.file_repo.get_file_by_stable_id.return_value = meta
        self.file_storage.read_file.return_value = content

        target = resolve_refresh_target(self.file_repo, self.file_storage, "tei-1", self.user)
        self.assertEqual(target.file_meta, meta)


class TestPreviewAndPerformRefresh(unittest.IsolatedAsyncioTestCase):
    def tearDown(self):
        unregister_document_rules_provider("GROBID")

    def _target(self, content):
        meta, content_bytes = make_tei_file(content)
        return RefreshTarget(file_meta=meta, tei_content=content_bytes.decode("utf-8"))

    def test_no_provider_registered_reports_unavailable_without_erroring(self):
        target = self._target(TEI_WITH_PI_AND_DECL)
        outcome = preview_refresh(target, cache=mock.MagicMock())
        self.assertFalse(outcome.available)
        self.assertIn("No rule-refresh provider", outcome.message)

    async def test_perform_refresh_no_provider_registered_does_not_write(self):
        target = self._target(TEI_WITH_PI_AND_DECL)
        file_repo = mock.MagicMock()
        file_storage = mock.MagicMock()

        outcome = await perform_refresh(target, file_repo, file_storage, "reviewer1", cache=mock.MagicMock())

        self.assertFalse(outcome.available)
        file_storage.save_file.assert_not_called()

    async def test_perform_refresh_does_not_write_when_nothing_changed(self):
        register_document_rules_provider("GROBID", "grobid", FakeProvider(
            entries=[{"category": "primary", "refs": [
                {"target": "https://github.com/mpilhlt/fossil/blob/oldsha/docs/guidelines.md#seg",
                 "content_type": "markdown", "subtype": "human"},
            ]}],
            schema_url="https://mpilhlt.github.io/fossil/schema/grobid.training.segmentation.rng",
        ))
        target = self._target(TEI_WITH_PI_AND_DECL)
        file_repo = mock.MagicMock()
        file_storage = mock.MagicMock()

        outcome = await perform_refresh(target, file_repo, file_storage, "reviewer1", cache=mock.MagicMock())

        self.assertTrue(outcome.available)
        self.assertFalse(outcome.changed)
        file_storage.save_file.assert_not_called()
        file_repo.update_file.assert_not_called()

    def test_preview_reports_unchanged_when_nothing_differs(self):
        register_document_rules_provider("GROBID", "grobid", FakeProvider(
            entries=[{"category": "primary", "refs": [
                {"target": "https://github.com/mpilhlt/fossil/blob/oldsha/docs/guidelines.md#seg",
                 "content_type": "markdown", "subtype": "human"},
            ]}],
            schema_url="https://mpilhlt.github.io/fossil/schema/grobid.training.segmentation.rng",
        ))
        target = self._target(TEI_WITH_PI_AND_DECL)

        outcome = preview_refresh(target, cache=mock.MagicMock())

        self.assertTrue(outcome.available)
        self.assertFalse(outcome.changed)
        self.assertIn("already up to date", outcome.message)

    async def test_replaces_editorial_decl_and_schema_pi_and_adds_change(self):
        register_document_rules_provider("GROBID", "grobid", FakeProvider(
            entries=[{"category": "primary", "refs": [
                {"target": "https://github.com/mpilhlt/fossil/blob/newsha/docs/guidelines.md#seg",
                 "content_type": "markdown", "subtype": "human"},
            ]}],
            schema_url="https://mpilhlt.github.io/fossil/schema/grobid.training.segmentation-v2.rng",
        ))
        target = self._target(TEI_WITH_PI_AND_DECL)
        file_repo = mock.MagicMock()
        file_storage = mock.MagicMock()
        file_storage.save_file.return_value = ("hash-new", None)

        outcome = await perform_refresh(target, file_repo, file_storage, "reviewer1", cache=mock.MagicMock())

        self.assertTrue(outcome.changed)
        self.assertEqual(outcome.entry_count, 1)

        saved_content = file_storage.save_file.call_args[0][0].decode("utf-8")
        self.assertIn("newsha", saved_content)
        self.assertNotIn("oldsha", saved_content)
        self.assertIn('href="https://mpilhlt.github.io/fossil/schema/grobid.training.segmentation-v2.rng"', saved_content)
        self.assertNotIn("grobid.training.segmentation.rng", saved_content)
        self.assertIn("Updated document rules", saved_content)
        file_repo.update_file.assert_called_once()

    async def test_regenerates_only_the_half_that_changed(self):
        # Schema URL differs, entries do not - editorialDecl content itself
        # (the "oldsha" ref) must be untouched.
        register_document_rules_provider("GROBID", "grobid", FakeProvider(
            entries=[{"category": "primary", "refs": [
                {"target": "https://github.com/mpilhlt/fossil/blob/oldsha/docs/guidelines.md#seg",
                 "content_type": "markdown", "subtype": "human"},
            ]}],
            schema_url="https://mpilhlt.github.io/fossil/schema/grobid.training.segmentation-v2.rng",
        ))
        target = self._target(TEI_WITH_PI_AND_DECL)
        file_repo = mock.MagicMock()
        file_storage = mock.MagicMock()
        file_storage.save_file.return_value = ("hash-new", None)

        outcome = await perform_refresh(target, file_repo, file_storage, "reviewer1", cache=mock.MagicMock())

        self.assertTrue(outcome.changed)
        saved_content = file_storage.save_file.call_args[0][0].decode("utf-8")
        self.assertIn("oldsha", saved_content)
        self.assertIn('href="https://mpilhlt.github.io/fossil/schema/grobid.training.segmentation-v2.rng"', saved_content)

    async def test_schema_pi_survives_an_editorial_decl_only_refresh(self):
        # Regression test for the round-trip PI-loss issue documented at the
        # top of this plan: entries differ, schema URL does NOT - the
        # existing schema PI must still be present afterward, not silently
        # dropped by the editorialDecl/revisionDesc rewrite.
        register_document_rules_provider("GROBID", "grobid", FakeProvider(
            entries=[{"category": "primary", "refs": [
                {"target": "https://github.com/mpilhlt/fossil/blob/newsha/docs/guidelines.md#seg",
                 "content_type": "markdown", "subtype": "human"},
            ]}],
            schema_url="https://mpilhlt.github.io/fossil/schema/grobid.training.segmentation.rng",
        ))
        target = self._target(TEI_WITH_PI_AND_DECL)
        file_repo = mock.MagicMock()
        file_storage = mock.MagicMock()
        file_storage.save_file.return_value = ("hash-new", None)

        outcome = await perform_refresh(target, file_repo, file_storage, "reviewer1", cache=mock.MagicMock())

        self.assertTrue(outcome.changed)
        saved_content = file_storage.save_file.call_args[0][0].decode("utf-8")
        self.assertIn('href="https://mpilhlt.github.io/fossil/schema/grobid.training.segmentation.rng"', saved_content)

    async def test_generates_editorial_decl_and_schema_pi_on_legacy_document(self):
        register_document_rules_provider("GROBID", "grobid", FakeProvider(
            entries=[{"category": "primary", "refs": [
                {"target": "https://github.com/mpilhlt/fossil/blob/newsha/docs/guidelines.md#seg",
                 "content_type": "markdown", "subtype": "human"},
            ]}],
            schema_url="https://mpilhlt.github.io/fossil/schema/grobid.training.segmentation.rng",
        ))
        target = self._target(TEI_LEGACY_NO_EDITORIAL_DECL_NO_PI)
        file_repo = mock.MagicMock()
        file_storage = mock.MagicMock()
        file_storage.save_file.return_value = ("hash-new", None)

        outcome = await perform_refresh(target, file_repo, file_storage, "reviewer1", cache=mock.MagicMock())

        self.assertTrue(outcome.changed)
        saved_content = file_storage.save_file.call_args[0][0].decode("utf-8")
        self.assertIn("editorialDecl", saved_content)
        self.assertIn('<?xml-model href="https://mpilhlt.github.io/fossil/schema/grobid.training.segmentation.rng"', saved_content)

    async def test_raises_runtime_error_on_malformed_xml(self):
        register_document_rules_provider("GROBID", "grobid", FakeProvider(
            entries=[{"category": "primary", "refs": [
                {"target": "https://github.com/mpilhlt/fossil/blob/newsha/docs/guidelines.md#seg",
                 "content_type": "markdown", "subtype": "human"},
            ]}],
        ))
        target = self._target(MALFORMED_TEI)
        file_repo = mock.MagicMock()
        file_storage = mock.MagicMock()

        with self.assertRaises(RuntimeError):
            await perform_refresh(target, file_repo, file_storage, "reviewer1", cache=mock.MagicMock())

        file_storage.save_file.assert_not_called()
        file_repo.update_file.assert_not_called()


if __name__ == "__main__":
    unittest.main()
