"""
Unit tests for fastapi_app/plugins/grobid/reload_feature_file.py.

Run manually:
    uv run python tests/unit-test-runner.py fastapi_app/plugins/grobid/tests/test_reload_feature_file.py -v

@testCovers fastapi_app/plugins/grobid/reload_feature_file.py
"""

import asyncio
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).parent.parent.parent.parent.parent))

from fastapi_app.lib.models.models import FileMetadata
from fastapi_app.plugins.grobid.reload_feature_file import (
    ReloadPreconditionError,
    ReloadResult,
    ReloadTarget,
    perform_reload,
    render_error_html,
    render_precondition_error_html,
    render_preview_html,
    render_result_html,
    resolve_reload_target,
)

TEI_TEMPLATE = """<TEI xmlns="http://www.tei-c.org/ns/1.0">
  <teiHeader>
    <encodingDesc>
      <appInfo>
        <application version="0.8.0" ident="GROBID" type="extractor">
          <label type="model">segmentation</label>
          <label type="flavor">default</label>
          <label type="variant-id">grobid.training.segmentation</label>
          <label type="revision">{revision}</label>
        </application>
      </appInfo>
    </encodingDesc>
  </teiHeader>
  <text><body><p>Body content.</p></body></text>
</TEI>
"""


def make_tei_file(stable_id="tei-1", file_id="hash-old", revision="rev-1"):
    content = TEI_TEMPLATE.format(revision=revision).encode("utf-8")
    meta = FileMetadata(
        id=file_id,
        stable_id=stable_id,
        filename="doc.tei.xml",
        doc_id="doc-1",
        file_type="tei",
        file_size=len(content),
    )
    return meta, content


def make_pdf_file(file_id="pdf-hash"):
    return FileMetadata(
        id=file_id,
        stable_id="pdf-1",
        filename="doc.pdf",
        doc_id="doc-1",
        file_type="pdf",
        file_size=100,
    )


class ResolveReloadTargetTestCase(unittest.TestCase):
    def setUp(self):
        self.file_repo = mock.Mock()
        self.file_storage = mock.Mock()
        self.user = {"username": "reviewer1", "roles": ["reviewer"]}

        # Isolate resolve_reload_target's own logic from the real
        # access-control mode configuration; individual tests override this.
        check_access_patch = mock.patch(
            "fastapi_app.plugins.grobid.reload_feature_file.check_file_access",
            return_value=True,
        )
        self.mock_check_access = check_access_patch.start()
        self.addCleanup(check_access_patch.stop)

    def resolve(self, stable_id="tei-1"):
        return resolve_reload_target(self.file_repo, self.file_storage, stable_id, self.user)

    def test_raises_when_no_tei_document_found(self):
        self.file_repo.get_file_by_stable_id.return_value = None
        with self.assertRaises(ReloadPreconditionError):
            self.resolve()

    def test_raises_when_file_is_not_tei_type(self):
        meta, _ = make_tei_file()
        meta.file_type = "pdf"
        self.file_repo.get_file_by_stable_id.return_value = meta
        with self.assertRaises(ReloadPreconditionError):
            self.resolve()

    def test_raises_when_user_lacks_write_access(self):
        meta, _ = make_tei_file()
        self.file_repo.get_file_by_stable_id.return_value = meta
        self.mock_check_access.return_value = False

        with self.assertRaises(ReloadPreconditionError) as cm:
            self.resolve()
        self.assertIn("permission", str(cm.exception))
        self.mock_check_access.assert_called_once_with(meta, self.user, "edit")

    def test_write_access_check_happens_before_reading_content(self):
        """Denying access shouldn't require reading/parsing the file content."""
        meta, _ = make_tei_file()
        self.file_repo.get_file_by_stable_id.return_value = meta
        self.mock_check_access.return_value = False

        with self.assertRaises(ReloadPreconditionError):
            self.resolve()
        self.file_storage.read_file.assert_not_called()

    def test_raises_when_content_missing(self):
        meta, _ = make_tei_file()
        self.file_repo.get_file_by_stable_id.return_value = meta
        self.file_storage.read_file.return_value = None
        with self.assertRaises(ReloadPreconditionError):
            self.resolve()

    def test_raises_when_not_a_training_document(self):
        meta, content = make_tei_file()
        content = content.replace(b"grobid.training.segmentation", b"grobid.service.fulltext")
        self.file_repo.get_file_by_stable_id.return_value = meta
        self.file_storage.read_file.return_value = content
        with self.assertRaises(ReloadPreconditionError):
            self.resolve()

    def test_raises_when_no_pdf_for_document(self):
        meta, content = make_tei_file()
        self.file_repo.get_file_by_stable_id.return_value = meta
        self.file_storage.read_file.return_value = content
        self.file_repo.get_pdf_for_document.return_value = None
        with self.assertRaises(ReloadPreconditionError):
            self.resolve()

    def test_returns_target_on_success(self):
        meta, content = make_tei_file(revision="rev-1")
        pdf_meta = make_pdf_file()
        self.file_repo.get_file_by_stable_id.return_value = meta
        self.file_storage.read_file.return_value = content
        self.file_repo.get_pdf_for_document.return_value = pdf_meta
        self.file_storage.get_file_path.return_value = Path("/fake/doc.pdf")

        target = self.resolve()

        self.assertEqual(target.doc_id, "doc-1")
        self.assertEqual(target.variant_id, "grobid.training.segmentation")
        self.assertEqual(target.flavor, "default")
        self.assertEqual(target.old_revision, "rev-1")
        self.assertEqual(target.pdf_path, Path("/fake/doc.pdf"))


class PerformReloadTestCase(unittest.TestCase):
    def run_async(self, coro):
        return asyncio.run(coro)

    def _make_target(self, revision="rev-1"):
        meta, content = make_tei_file(revision=revision)
        return ReloadTarget(
            file_meta=meta,
            tei_content=content.decode("utf-8"),
            doc_id="doc-1",
            variant_id="grobid.training.segmentation",
            flavor="default",
            old_revision=revision,
            pdf_path=Path("/fake/doc.pdf"),
        )

    def _patch_network(self, grobid_revision="new-rev-2"):
        patches = {
            "check_health": mock.patch(
                "fastapi_app.plugins.grobid.extractor.GrobidTrainingExtractor._check_grobid_health",
                return_value=None,
            ),
            "get_version": mock.patch(
                "fastapi_app.plugins.grobid.extractor.GrobidTrainingExtractor._get_grobid_version",
                return_value=("0.8.1", grobid_revision),
            ),
            "fetch_package": mock.patch(
                "fastapi_app.plugins.grobid.handlers.training.TrainingHandler._fetch_training_package",
                return_value=("/tmp/fake-temp-dir", ["doc-1.training.segmentation"]),
            ),
            "cache_training_data": mock.patch(
                "fastapi_app.plugins.grobid.reload_feature_file.cache_training_data",
                return_value=None,
            ),
            "rmtree": mock.patch(
                "fastapi_app.plugins.grobid.reload_feature_file.shutil.rmtree", return_value=None
            ),
        }
        mocks = {name: p.start() for name, p in patches.items()}
        for p in patches.values():
            self.addCleanup(p.stop)
        return mocks

    def test_refreshes_cache_under_current_revision(self):
        target = self._make_target(revision="rev-1")
        mocks = self._patch_network(grobid_revision="new-rev-2")
        file_repo = mock.Mock()
        file_storage = mock.Mock()
        file_storage.save_file.return_value = ("hash-old", Path("/fake/hash-old.tei.xml"))

        result = self.run_async(
            perform_reload(target, "http://grobid.example", file_repo, file_storage)
        )

        self.assertEqual(result.grobid_revision, "new-rev-2")
        mocks["cache_training_data"].assert_called_once_with(
            "doc-1", "new-rev-2", "/tmp/fake-temp-dir", ["doc-1.training.segmentation"]
        )

    def test_patches_revision_label_in_place_when_revision_changed(self):
        target = self._make_target(revision="rev-1")
        self._patch_network(grobid_revision="new-rev-2")
        file_repo = mock.Mock()
        file_storage = mock.Mock()
        file_storage.save_file.return_value = ("hash-new", Path("/fake/hash-new.tei.xml"))

        result = self.run_async(
            perform_reload(target, "http://grobid.example", file_repo, file_storage)
        )

        self.assertTrue(result.updated_label)
        saved_bytes = file_storage.save_file.call_args[0][0]
        self.assertIn(b'<label type="revision">new-rev-2</label>', saved_bytes)
        file_repo.update_file.assert_called_once()
        call_args = file_repo.update_file.call_args[0]
        self.assertEqual(call_args[0], "hash-old")
        self.assertEqual(call_args[1].id, "hash-new")

    def test_does_not_touch_file_when_revision_unchanged(self):
        target = self._make_target(revision="new-rev-2")
        self._patch_network(grobid_revision="new-rev-2")
        file_repo = mock.Mock()
        file_storage = mock.Mock()

        result = self.run_async(
            perform_reload(target, "http://grobid.example", file_repo, file_storage)
        )

        self.assertFalse(result.updated_label)
        file_storage.save_file.assert_not_called()
        file_repo.update_file.assert_not_called()

    def test_propagates_grobid_health_failure(self):
        target = self._make_target()
        with mock.patch(
            "fastapi_app.plugins.grobid.extractor.GrobidTrainingExtractor._check_grobid_health",
            side_effect=RuntimeError("GROBID server is not ready"),
        ):
            with self.assertRaises(RuntimeError):
                self.run_async(
                    perform_reload(target, "http://grobid.example", mock.Mock(), mock.Mock())
                )


class ReloadResultMessageTestCase(unittest.TestCase):
    def test_message_without_label_update(self):
        result = ReloadResult(grobid_revision="rev-9", updated_label=False)
        self.assertEqual(
            result.message, "Feature file refreshed for GROBID revision 'rev-9'."
        )

    def test_message_with_label_update(self):
        result = ReloadResult(grobid_revision="rev-9", updated_label=True)
        self.assertIn("Document revision label updated to match.", result.message)


class RenderHtmlTestCase(unittest.TestCase):
    def _make_target(self, revision="rev-1"):
        meta, content = make_tei_file(revision=revision)
        return ReloadTarget(
            file_meta=meta,
            tei_content=content.decode("utf-8"),
            doc_id="doc-1",
            variant_id="grobid.training.segmentation",
            flavor="default",
            old_revision=revision,
            pdf_path=Path("/fake/doc.pdf"),
        )

    def test_precondition_error_html_escapes_message(self):
        html = render_precondition_error_html("No <b>PDF</b> found")
        self.assertIn("&lt;b&gt;PDF&lt;/b&gt;", html)
        self.assertNotIn("<b>PDF</b>", html)

    def test_preview_html_reports_pending_label_update(self):
        target = self._make_target(revision="rev-1")
        html = render_preview_html(target, live_revision="rev-2", live_error=None)
        self.assertIn("doc-1", html)
        self.assertIn("rev-1", html)
        self.assertIn("rev-2", html)
        self.assertIn("will be updated to match", html)

    def test_preview_html_reports_no_pending_update_when_revision_matches(self):
        target = self._make_target(revision="rev-2")
        html = render_preview_html(target, live_revision="rev-2", live_error=None)
        self.assertIn("already current", html)

    def test_preview_html_reports_live_error(self):
        target = self._make_target(revision="rev-1")
        html = render_preview_html(target, live_revision=None, live_error="Connection refused")
        self.assertIn("Could not reach the GROBID server", html)
        self.assertIn("Connection refused", html)

    def test_result_html_includes_sandbox_script_and_message(self):
        result = ReloadResult(grobid_revision="rev-2", updated_label=True)
        html = render_result_html(result)
        self.assertIn("sandbox.notify(", html)
        self.assertIn("sandbox.reloadCurrentDocument();", html)
        self.assertIn("rev-2", html)

    def test_error_html_escapes_message(self):
        html = render_error_html("boom <script>")
        self.assertIn("&lt;script&gt;", html)


class ReloadFeatureFileTriggerTestCase(unittest.TestCase):
    """Tests for GrobidPlugin.reload_feature_file(), the preview/execute trigger."""

    def setUp(self):
        from fastapi_app.plugins.grobid.plugin import GrobidPlugin

        self.plugin = GrobidPlugin.__new__(GrobidPlugin)  # skip __init__ (config bootstrap)
        self.context = mock.Mock()
        self.context.user = {"roles": ["reviewer"]}

    def run_async(self, coro):
        return asyncio.run(coro)

    def test_requires_reviewer_role(self):
        with mock.patch(
            "fastapi_app.lib.permissions.acl_utils.user_has_role", return_value=False
        ):
            result = self.run_async(
                self.plugin.reload_feature_file(self.context, {"xml": "tei-1"})
            )
        self.assertIn("error", result)

    def test_errors_when_no_document_open(self):
        with mock.patch(
            "fastapi_app.lib.permissions.acl_utils.user_has_role", return_value=True
        ):
            result = self.run_async(self.plugin.reload_feature_file(self.context, {}))
        self.assertIn("error", result)

    def test_returns_preview_and_execute_urls_for_stable_id(self):
        with mock.patch(
            "fastapi_app.lib.permissions.acl_utils.user_has_role", return_value=True
        ):
            result = self.run_async(
                self.plugin.reload_feature_file(self.context, {"xml": "tei-1"})
            )

        self.assertNotIn("error", result)
        self.assertEqual(
            result["outputUrl"], "/api/plugins/grobid/reload-feature-file/preview?xml=tei-1"
        )
        self.assertEqual(
            result["executeUrl"], "/api/plugins/grobid/reload-feature-file/execute?xml=tei-1"
        )


if __name__ == "__main__":
    unittest.main()
