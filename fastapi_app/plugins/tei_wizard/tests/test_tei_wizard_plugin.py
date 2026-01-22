"""
Tests for the TEI Wizard Enhancement Registry Plugin.

@testCovers fastapi_app/plugins/tei_wizard/plugin.py
"""

import unittest
from pathlib import Path
from unittest.mock import MagicMock
import logging

from fastapi_app.plugins.tei_wizard.plugin import TeiWizardPlugin


class TestTeiWizardPlugin(unittest.TestCase):
    """Tests for TeiWizardPlugin class."""

    def setUp(self):
        """Create a fresh plugin instance for each test."""
        # Suppress logging during tests to avoid output
        logging.getLogger().setLevel(logging.ERROR)
        self.plugin = TeiWizardPlugin()

    def tearDown(self):
        """Restore logging level after each test."""
        logging.getLogger().setLevel(logging.NOTSET)

    def test_metadata_has_required_fields(self):
        """Plugin metadata contains all required fields."""
        metadata = self.plugin.metadata
        required_fields = [
            "id",
            "name",
            "description",
            "category",
            "version",
            "required_roles",
        ]
        for field in required_fields:
            self.assertIn(field, metadata)

    def test_metadata_id(self):
        """Plugin ID is 'tei-wizard'."""
        self.assertEqual(self.plugin.metadata["id"], "tei-wizard")

    def test_metadata_endpoints_is_empty(self):
        """Plugin has no menu entries (empty endpoints)."""
        self.assertEqual(self.plugin.metadata["endpoints"], [])

    def test_register_enhancement_adds_file(self):
        """register_enhancement adds a file to the list."""
        # Create a temp file path that exists
        test_file = Path(__file__).parent / "test_enhancement.js"
        test_file.write_text("// test")
        try:
            self.plugin.register_enhancement(test_file, "test-plugin")
            files = self.plugin.get_enhancement_files()
            self.assertEqual(len(files), 1)
            self.assertEqual(files[0][0], test_file)
            self.assertEqual(files[0][1], "test-plugin")
        finally:
            test_file.unlink(missing_ok=True)

    def test_register_enhancement_nonexistent_file(self):
        """register_enhancement ignores nonexistent files."""
        # Suppress expected warning log
        with self.assertLogs('fastapi_app.plugins.tei_wizard.plugin', level='WARNING'):
            nonexistent = Path("/nonexistent/file.js")
            self.plugin.register_enhancement(nonexistent, "test-plugin")
        self.assertEqual(len(self.plugin.get_enhancement_files()), 0)

    def test_register_enhancement_replaces_duplicate(self):
        """Registering same filename replaces previous entry."""
        # Create two temp files with same name in different dirs
        test_dir1 = Path(__file__).parent / "dir1"
        test_dir2 = Path(__file__).parent / "dir2"
        test_dir1.mkdir(exist_ok=True)
        test_dir2.mkdir(exist_ok=True)

        file1 = test_dir1 / "enhancement.js"
        file2 = test_dir2 / "enhancement.js"
        file1.write_text("// version 1")
        file2.write_text("// version 2")

        try:
            # Suppress expected warning log
            with self.assertLogs('fastapi_app.plugins.tei_wizard.plugin', level='WARNING'):
                self.plugin.register_enhancement(file1, "plugin-a")
                self.plugin.register_enhancement(file2, "plugin-b")

            files = self.plugin.get_enhancement_files()
            self.assertEqual(len(files), 1)
            self.assertEqual(files[0][0], file2)
            self.assertEqual(files[0][1], "plugin-b")
        finally:
            file1.unlink(missing_ok=True)
            file2.unlink(missing_ok=True)
            test_dir1.rmdir()
            test_dir2.rmdir()

    def test_get_enhancement_files_returns_copy(self):
        """get_enhancement_files returns a copy, not the original list."""
        test_file = Path(__file__).parent / "test.js"
        test_file.write_text("// test")
        try:
            self.plugin.register_enhancement(test_file, "test")
            files1 = self.plugin.get_enhancement_files()
            files2 = self.plugin.get_enhancement_files()
            self.assertIsNot(files1, files2)
        finally:
            test_file.unlink(missing_ok=True)

    def test_list_enhancements_returns_metadata(self):
        """list_enhancements returns enhancement metadata."""
        import asyncio

        async def run_test():
            test_file = Path(__file__).parent / "my-enhancement.js"
            test_file.write_text("// test")
            try:
                self.plugin.register_enhancement(test_file, "my-plugin")
                context = MagicMock()
                result = await self.plugin.list_enhancements(context, {})

                self.assertIn("enhancements", result)
                self.assertEqual(len(result["enhancements"]), 1)
                self.assertEqual(
                    result["enhancements"][0]["file"], "my-enhancement.js"
                )
                self.assertEqual(result["enhancements"][0]["plugin_id"], "my-plugin")
            finally:
                test_file.unlink(missing_ok=True)

        asyncio.run(run_test())


if __name__ == "__main__":
    unittest.main()
