"""
Unit tests for Local Sync Plugin.

@testCovers fastapi_app/plugins/local_sync/plugin.py
"""

import unittest
from unittest.mock import Mock, patch, MagicMock
from pathlib import Path
import tempfile
import shutil


class TestLocalSyncPlugin(unittest.TestCase):
    def setUp(self):
        """Set up test fixtures."""
        self.temp_dir = tempfile.mkdtemp()

    def tearDown(self):
        """Clean up test fixtures."""
        shutil.rmtree(self.temp_dir)

    def test_scan_filesystem(self):
        """Test filesystem scanning for TEI files."""
        # Create test files
        test_path = Path(self.temp_dir)
        (test_path / "doc1.tei.xml").write_text("<TEI>test1</TEI>")
        (test_path / "subdir").mkdir()
        (test_path / "subdir" / "doc2.tei.xml").write_text("<TEI>test2</TEI>")
        (test_path / "ignore.xml").write_text("<TEI>ignore</TEI>")

        from fastapi_app.plugins.local_sync.plugin import LocalSyncPlugin
        plugin = LocalSyncPlugin()

        docs = plugin._scan_filesystem(test_path)

        self.assertEqual(len(docs), 2)
        self.assertTrue(any("doc1.tei.xml" in str(p) for p in docs.keys()))
        self.assertTrue(any("doc2.tei.xml" in str(p) for p in docs.keys()))

    def test_scan_filesystem_with_include_filter(self):
        """Test filesystem scanning with include pattern."""
        # Create test files
        test_path = Path(self.temp_dir)
        (test_path / "doc1.tei.xml").write_text("<TEI>test1</TEI>")
        (test_path / "subdir").mkdir()
        (test_path / "subdir" / "doc2.tei.xml").write_text("<TEI>test2</TEI>")
        (test_path / "other.tei.xml").write_text("<TEI>other</TEI>")

        from fastapi_app.plugins.local_sync.plugin import LocalSyncPlugin
        plugin = LocalSyncPlugin()

        # Only include files in subdir
        docs = plugin._scan_filesystem(test_path, include_pattern=r"subdir")

        self.assertEqual(len(docs), 1)
        self.assertTrue(any("doc2.tei.xml" in str(p) for p in docs.keys()))

    def test_scan_filesystem_with_exclude_filter(self):
        """Test filesystem scanning with exclude pattern."""
        # Create test files
        test_path = Path(self.temp_dir)
        (test_path / "doc1.tei.xml").write_text("<TEI>test1</TEI>")
        (test_path / "subdir").mkdir()
        (test_path / "subdir" / "doc2.tei.xml").write_text("<TEI>test2</TEI>")
        (test_path / "other.tei.xml").write_text("<TEI>other</TEI>")

        from fastapi_app.plugins.local_sync.plugin import LocalSyncPlugin
        plugin = LocalSyncPlugin()

        # Exclude files in subdir
        docs = plugin._scan_filesystem(test_path, exclude_pattern=r"subdir")

        self.assertEqual(len(docs), 2)
        self.assertTrue(any("doc1.tei.xml" in str(p) for p in docs.keys()))
        self.assertTrue(any("other.tei.xml" in str(p) for p in docs.keys()))

    def test_scan_filesystem_with_include_and_exclude_filters(self):
        """Test filesystem scanning with both include and exclude patterns."""
        # Create test files
        test_path = Path(self.temp_dir)
        (test_path / "gold").mkdir()
        (test_path / "gold" / "doc1.tei.xml").write_text("<TEI>test1</TEI>")
        (test_path / "gold" / "doc2.tei.xml").write_text("<TEI>test2</TEI>")
        (test_path / "gold" / "draft.tei.xml").write_text("<TEI>draft</TEI>")
        (test_path / "draft").mkdir()
        (test_path / "draft" / "doc3.tei.xml").write_text("<TEI>test3</TEI>")

        from fastapi_app.plugins.local_sync.plugin import LocalSyncPlugin
        plugin = LocalSyncPlugin()

        # Include only files in gold, exclude files with "draft" in name
        docs = plugin._scan_filesystem(test_path, include_pattern=r"gold", exclude_pattern=r"draft")

        self.assertEqual(len(docs), 2)
        self.assertTrue(any("doc1.tei.xml" in str(p) for p in docs.keys()))
        self.assertTrue(any("doc2.tei.xml" in str(p) for p in docs.keys()))
        self.assertFalse(any("draft.tei.xml" in str(p) for p in docs.keys()))

    def test_scan_filesystem_with_filename_pattern(self):
        """Test filesystem scanning with filename-based pattern."""
        # Create test files
        test_path = Path(self.temp_dir)
        (test_path / "article-001.tei.xml").write_text("<TEI>test1</TEI>")
        (test_path / "article-002.tei.xml").write_text("<TEI>test2</TEI>")
        (test_path / "review-001.tei.xml").write_text("<TEI>review</TEI>")

        from fastapi_app.plugins.local_sync.plugin import LocalSyncPlugin
        plugin = LocalSyncPlugin()

        # Only include files starting with "article"
        docs = plugin._scan_filesystem(test_path, include_pattern=r"article-\d+\.tei\.xml")

        self.assertEqual(len(docs), 2)
        self.assertTrue(any("article-001.tei.xml" in str(p) for p in docs.keys()))
        self.assertTrue(any("article-002.tei.xml" in str(p) for p in docs.keys()))
        self.assertFalse(any("review-001.tei.xml" in str(p) for p in docs.keys()))

    def test_extract_fileref(self):
        """Test fileref extraction from TEI content using tei_utils."""
        tei_content = b"""<?xml version="1.0"?>
<TEI xmlns="http://www.tei-c.org/ns/1.0">
    <teiHeader>
        <fileDesc>
            <editionStmt>
                <edition>
                    <idno type="fileref">test-doc-123</idno>
                </edition>
            </editionStmt>
        </fileDesc>
    </teiHeader>
</TEI>"""

        from fastapi_app.lib.tei_utils import extract_fileref

        fileref = extract_fileref(tei_content)
        self.assertEqual(fileref, "test-doc-123")

    def test_extract_fileref_no_match(self):
        """Test fileref extraction with missing element."""
        tei_content = b"""<?xml version="1.0"?>
<TEI xmlns="http://www.tei-c.org/ns/1.0">
    <teiHeader>
        <fileDesc>
            <titleStmt><title>Test</title></titleStmt>
        </fileDesc>
    </teiHeader>
</TEI>"""

        from fastapi_app.lib.tei_utils import extract_fileref

        fileref = extract_fileref(tei_content)
        self.assertIsNone(fileref)

    def test_extract_timestamp(self):
        """Test timestamp extraction from last revision change using tei_utils."""
        tei_content = b"""<?xml version="1.0"?>
<TEI xmlns="http://www.tei-c.org/ns/1.0">
    <teiHeader>
        <revisionDesc>
            <change when="2025-01-01T10:00:00">First change</change>
            <change when="2025-01-08T15:30:00">Latest change</change>
        </revisionDesc>
    </teiHeader>
</TEI>"""

        from fastapi_app.lib.tei_utils import extract_revision_timestamp

        timestamp = extract_revision_timestamp(tei_content)
        self.assertEqual(timestamp, "2025-01-08T15:30:00")

    def test_extract_timestamp_no_changes(self):
        """Test timestamp extraction with no changes."""
        tei_content = b"""<?xml version="1.0"?>
<TEI xmlns="http://www.tei-c.org/ns/1.0">
    <teiHeader>
        <fileDesc>
            <titleStmt><title>Test</title></titleStmt>
        </fileDesc>
    </teiHeader>
</TEI>"""

        from fastapi_app.lib.tei_utils import extract_revision_timestamp

        timestamp = extract_revision_timestamp(tei_content)
        self.assertIsNone(timestamp)

    @patch('fastapi_app.lib.plugin_tools.get_plugin_config')
    def test_plugin_availability_disabled(self, mock_config):
        """Test plugin is not available when disabled."""
        from fastapi_app.plugins.local_sync.plugin import LocalSyncPlugin

        # Mock config to return disabled
        def config_side_effect(key, env_var, default=None, value_type="string"):
            if key == "plugin.local-sync.enabled":
                return False
            return None

        mock_config.side_effect = config_side_effect

        self.assertFalse(LocalSyncPlugin.is_available())

    @patch('fastapi_app.lib.plugin_tools.get_plugin_config')
    def test_plugin_availability_no_repo_path(self, mock_config):
        """Test plugin is not available when repo path not configured."""
        from fastapi_app.plugins.local_sync.plugin import LocalSyncPlugin

        # Mock config to return enabled but no repo path
        def config_side_effect(key, env_var, default=None, value_type="string"):
            if key == "plugin.local-sync.enabled":
                return True
            if key == "plugin.local-sync.repo.path":
                return None
            return None

        mock_config.side_effect = config_side_effect

        self.assertFalse(LocalSyncPlugin.is_available())

    @patch('fastapi_app.lib.plugin_tools.get_plugin_config')
    def test_plugin_availability_enabled(self, mock_config):
        """Test plugin is available when enabled and repo path configured."""
        from fastapi_app.plugins.local_sync.plugin import LocalSyncPlugin

        # Mock config to return enabled and repo path
        def config_side_effect(key, env_var, default=None, value_type="string"):
            if key == "plugin.local-sync.enabled":
                return True
            if key == "plugin.local-sync.repo.path":
                return "/some/path"
            return None

        mock_config.side_effect = config_side_effect

        self.assertTrue(LocalSyncPlugin.is_available())

    def test_update_filesystem_with_backup(self):
        """Test filesystem update creates backup."""
        from fastapi_app.plugins.local_sync.plugin import LocalSyncPlugin

        plugin = LocalSyncPlugin()
        test_path = Path(self.temp_dir)
        test_file = test_path / "test.tei.xml"
        test_file.write_text("old content")

        plugin._update_filesystem(test_file, b"new content", backup_enabled=True)

        # Check new content
        self.assertEqual(test_file.read_text(), "new content")

        # Check backup exists
        backups = list(test_path.glob("test.*.backup"))
        self.assertEqual(len(backups), 1)
        self.assertEqual(backups[0].read_text(), "old content")

    def test_update_filesystem_without_backup(self):
        """Test filesystem update without backup."""
        from fastapi_app.plugins.local_sync.plugin import LocalSyncPlugin

        plugin = LocalSyncPlugin()
        test_path = Path(self.temp_dir)
        test_file = test_path / "test.tei.xml"
        test_file.write_text("old content")

        plugin._update_filesystem(test_file, b"new content", backup_enabled=False)

        # Check new content
        self.assertEqual(test_file.read_text(), "new content")

        # Check no backup exists
        backups = list(test_path.glob("test.*.backup"))
        self.assertEqual(len(backups), 0)


if __name__ == '__main__':
    unittest.main()
