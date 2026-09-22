"""
Unit tests for fastapi_app/plugins/grobid/annotation_rules_refresh.py.

Run manually:
    uv run python tests/unit-test-runner.py fastapi_app/plugins/grobid/tests/test_annotation_rules_refresh.py -v

@testCovers fastapi_app/plugins/grobid/annotation_rules_refresh.py
"""

import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).parent.parent.parent.parent.parent))

from fastapi_app.lib.models.models import FileMetadata
from fastapi_app.lib.utils.annotation_rules_utils import extract_annotation_rule_refs
from fastapi_app.plugins.grobid.annotation_rules_refresh import (
    RefreshPreconditionError,
    RefreshResult,
    RefreshTarget,
    perform_refresh,
    render_error_html,
    render_precondition_error_html,
    render_preview_html,
    render_result_html,
    resolve_refresh_target,
)

TEI_TEMPLATE = """<TEI xmlns="http://www.tei-c.org/ns/1.0">
  <teiHeader>
    <encodingDesc>
      <editorialDecl>
        <interpretation type="primary">
          <p><ref subtype="human" target="https://github.com/mpilhlt/fossil/blob/oldsha/docs/guidelines.md#seg" type="markdown">Guide</ref></p>
        </interpretation>
      </editorialDecl>
      <appInfo>
        <application version="0.8.0" ident="GROBID" type="extractor">
          <label type="model">segmentation</label>
          <label type="flavor">default</label>
          <label type="variant-id">grobid.training.segmentation</label>
        </application>
      </appInfo>
    </encodingDesc>
  </teiHeader>
  <text><body><p>Body content.</p></body></text>
</TEI>
"""


# Mismatched <p>/</div> tags: lenient-parseable (parse_encoding_labels(),
# which uses etree.XMLParser(recover=True), extracts labels from it fine)
# but not strictly well-formed, so plain etree.fromstring() raises
# XMLSyntaxError. Used to exercise perform_refresh()'s conversion of that
# into a RuntimeError.
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


def make_tei_file(stable_id="tei-1", file_id="hash-old"):
    content = TEI_TEMPLATE.encode("utf-8")
    meta = FileMetadata(
        id=file_id,
        stable_id=stable_id,
        filename="doc.tei.xml",
        doc_id="doc-1",
        file_type="tei",
        file_size=len(content),
    )
    return meta, content


class TestResolveRefreshTarget(unittest.TestCase):
    def setUp(self):
        self.file_repo = mock.MagicMock()
        self.file_storage = mock.MagicMock()
        self.user = {"username": "reviewer1"}

    def test_raises_when_no_file(self):
        self.file_repo.get_file_by_stable_id.return_value = None
        with self.assertRaises(RefreshPreconditionError):
            resolve_refresh_target(self.file_repo, self.file_storage, "missing", self.user)

    @mock.patch("fastapi_app.plugins.grobid.annotation_rules_refresh.check_file_access", return_value=True)
    def test_raises_when_no_variant_label(self, _mock_access):
        meta, _content = make_tei_file()
        self.file_repo.get_file_by_stable_id.return_value = meta
        self.file_storage.read_file.return_value = b'<TEI xmlns="http://www.tei-c.org/ns/1.0"><teiHeader/></TEI>'
        with self.assertRaises(RefreshPreconditionError):
            resolve_refresh_target(self.file_repo, self.file_storage, "tei-1", self.user)

    @mock.patch("fastapi_app.plugins.grobid.annotation_rules_refresh.check_file_access", return_value=False)
    def test_raises_when_permission_denied(self, _mock_access):
        meta, content = make_tei_file()
        self.file_repo.get_file_by_stable_id.return_value = meta
        self.file_storage.read_file.return_value = content
        with self.assertRaises(RefreshPreconditionError):
            resolve_refresh_target(self.file_repo, self.file_storage, "tei-1", self.user)
        self.file_storage.read_file.assert_not_called()

    @mock.patch("fastapi_app.plugins.grobid.annotation_rules_refresh.check_file_access", return_value=True)
    def test_raises_when_content_missing(self, _mock_access):
        meta, _content = make_tei_file()
        self.file_repo.get_file_by_stable_id.return_value = meta
        self.file_storage.read_file.return_value = None
        with self.assertRaises(RefreshPreconditionError):
            resolve_refresh_target(self.file_repo, self.file_storage, "tei-1", self.user)

    @mock.patch("fastapi_app.plugins.grobid.annotation_rules_refresh.check_file_access", return_value=True)
    def test_resolves_valid_target(self, _mock_access):
        meta, content = make_tei_file()
        self.file_repo.get_file_by_stable_id.return_value = meta
        self.file_storage.read_file.return_value = content

        target = resolve_refresh_target(self.file_repo, self.file_storage, "tei-1", self.user)
        self.assertEqual(target.variant_id, "grobid.training.segmentation")
        self.assertEqual(target.file_meta, meta)


class TestPerformRefresh(unittest.IsolatedAsyncioTestCase):
    @mock.patch("fastapi_app.plugins.grobid.annotation_rules_refresh.get_settings")
    @mock.patch("fastapi_app.plugins.grobid.annotation_rules_refresh.build_editorial_decl_entries")
    async def test_replaces_editorial_decl_and_adds_change(self, mock_build, mock_settings):
        mock_settings.return_value.annotation_rules_cache_dir = Path("/tmp/rules-cache")
        mock_build.return_value = [
            {"category": "primary", "refs": [
                {"target": "https://github.com/mpilhlt/fossil/blob/newsha/docs/guidelines.md#seg",
                 "content_type": "markdown", "subtype": "human"},
            ]},
        ]

        meta, content = make_tei_file()
        target = RefreshTarget(file_meta=meta, tei_content=content.decode("utf-8"), variant_id="grobid.training.segmentation")

        file_repo = mock.MagicMock()
        file_storage = mock.MagicMock()
        file_storage.save_file.return_value = ("hash-new", None)

        result = await perform_refresh(target, file_repo, file_storage, "reviewer1")

        self.assertTrue(result.changed)
        self.assertEqual(result.entry_count, 1)

        saved_bytes = file_storage.save_file.call_args[0][0]
        saved_content = saved_bytes.decode("utf-8")
        self.assertIn("newsha", saved_content)
        self.assertNotIn("oldsha", saved_content)
        self.assertIn("Updated annotation rules reference", saved_content)
        file_repo.update_file.assert_called_once()

    @mock.patch("fastapi_app.plugins.grobid.annotation_rules_refresh.get_settings")
    @mock.patch("fastapi_app.plugins.grobid.annotation_rules_refresh.build_editorial_decl_entries")
    async def test_preserves_both_human_and_machine_refs(self, mock_build, mock_settings):
        mock_settings.return_value.annotation_rules_cache_dir = Path("/tmp/rules-cache")
        mock_build.return_value = [
            {"category": "primary", "refs": [
                {"target": "https://github.com/mpilhlt/fossil/blob/newsha/docs/guidelines.md#seg",
                 "content_type": "markdown", "subtype": "human"},
                {"target": "https://github.com/mpilhlt/fossil/blob/newsha/docs/guidelines.md#L1-L20",
                 "content_type": "markdown", "subtype": "machine"},
            ]},
        ]

        meta, content = make_tei_file()
        target = RefreshTarget(file_meta=meta, tei_content=content.decode("utf-8"), variant_id="grobid.training.segmentation")

        file_repo = mock.MagicMock()
        file_storage = mock.MagicMock()
        file_storage.save_file.return_value = ("hash-new", None)

        await perform_refresh(target, file_repo, file_storage, "reviewer1")

        saved_bytes = file_storage.save_file.call_args[0][0]
        saved_content = saved_bytes.decode("utf-8")

        refs = extract_annotation_rule_refs(saved_content)
        self.assertEqual(len(refs), 1)
        human = next(r for r in refs[0]["refs"] if r["subtype"] == "human")
        machine = next(r for r in refs[0]["refs"] if r["subtype"] == "machine")
        self.assertTrue(human["target"].endswith("#seg"))
        self.assertTrue(machine["target"].endswith("#L1-L20"))

    @mock.patch("fastapi_app.plugins.grobid.annotation_rules_refresh.get_settings")
    @mock.patch("fastapi_app.plugins.grobid.annotation_rules_refresh.build_editorial_decl_entries")
    async def test_removes_editorial_decl_when_entries_now_empty(self, mock_build, mock_settings):
        mock_settings.return_value.annotation_rules_cache_dir = Path("/tmp/rules-cache")
        mock_build.return_value = []

        meta, content = make_tei_file()
        target = RefreshTarget(file_meta=meta, tei_content=content.decode("utf-8"), variant_id="grobid.training.segmentation")

        file_repo = mock.MagicMock()
        file_storage = mock.MagicMock()
        file_storage.save_file.return_value = ("hash-new", None)

        result = await perform_refresh(target, file_repo, file_storage, "reviewer1")

        self.assertTrue(result.changed)
        self.assertEqual(result.entry_count, 0)

        saved_bytes = file_storage.save_file.call_args[0][0]
        saved_content = saved_bytes.decode("utf-8")
        self.assertNotIn("editorialDecl", saved_content)
        file_repo.update_file.assert_called_once()

    @mock.patch("fastapi_app.plugins.grobid.annotation_rules_refresh.get_settings")
    @mock.patch("fastapi_app.plugins.grobid.annotation_rules_refresh.build_editorial_decl_entries")
    async def test_raises_runtime_error_on_malformed_xml(self, mock_build, mock_settings):
        mock_settings.return_value.annotation_rules_cache_dir = Path("/tmp/rules-cache")
        mock_build.return_value = [
            {"category": "primary", "refs": [
                {"target": "https://github.com/mpilhlt/fossil/blob/newsha/docs/guidelines.md#seg",
                 "content_type": "markdown", "subtype": "human"},
            ]},
        ]

        meta, _content = make_tei_file()
        target = RefreshTarget(file_meta=meta, tei_content=MALFORMED_TEI, variant_id="grobid.training.segmentation")

        file_repo = mock.MagicMock()
        file_storage = mock.MagicMock()

        with self.assertRaises(RuntimeError):
            await perform_refresh(target, file_repo, file_storage, "reviewer1")

        file_storage.save_file.assert_not_called()
        file_repo.update_file.assert_not_called()

    @mock.patch("fastapi_app.plugins.grobid.annotation_rules_refresh.get_settings")
    @mock.patch("fastapi_app.plugins.grobid.annotation_rules_refresh.build_editorial_decl_entries")
    async def test_no_write_when_unchanged(self, mock_build, mock_settings):
        mock_settings.return_value.annotation_rules_cache_dir = Path("/tmp/rules-cache")
        mock_build.return_value = [
            {"category": "primary", "refs": [
                {"target": "https://github.com/mpilhlt/fossil/blob/oldsha/docs/guidelines.md#seg",
                 "content_type": "markdown", "subtype": "human"},
            ]},
        ]

        meta, content = make_tei_file()
        target = RefreshTarget(file_meta=meta, tei_content=content.decode("utf-8"), variant_id="grobid.training.segmentation")

        file_repo = mock.MagicMock()
        file_storage = mock.MagicMock()

        result = await perform_refresh(target, file_repo, file_storage, "reviewer1")

        self.assertFalse(result.changed)
        file_storage.save_file.assert_not_called()
        file_repo.update_file.assert_not_called()


class TestRenderHtml(unittest.TestCase):
    def test_render_precondition_error_html_escapes_message(self):
        html = render_precondition_error_html("<script>alert(1)</script>")
        self.assertNotIn("<script>alert(1)</script>", html)

    def test_render_preview_html_includes_variant(self):
        meta, content = make_tei_file()
        target = RefreshTarget(file_meta=meta, tei_content=content.decode("utf-8"), variant_id="grobid.training.segmentation")
        html = render_preview_html(target)
        self.assertIn("grobid.training.segmentation", html)

    def test_render_result_html_includes_message(self):
        result = RefreshResult(entry_count=1, changed=True)
        html = render_result_html(result)
        self.assertIn("updated", html.lower())

    def test_render_error_html_escapes_message(self):
        html = render_error_html("<b>boom</b>")
        self.assertNotIn("<b>boom</b>", html)


if __name__ == "__main__":
    unittest.main()
