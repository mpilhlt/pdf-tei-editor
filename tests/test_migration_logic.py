#!/usr/bin/env python3
"""
Test the migration logic for old version files.

Tests that when saving existing files, old version structures are automatically
migrated to the new structure.
"""

import unittest
import tempfile
import os
import shutil
from pathlib import Path
from unittest.mock import MagicMock
import sys

# Add the project root directory to the path so we can import the modules
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from server.lib.server_utils import migrate_old_version_files


class TestMigrationLogic(unittest.TestCase):
    """Test the old version file migration logic."""
    
    def setUp(self):
        """Set up a temporary directory with test file structures."""
        self.test_data_root = tempfile.mkdtemp()
        self.mock_logger = MagicMock()
        
    def tearDown(self):
        """Clean up the temporary directory."""
        shutil.rmtree(self.test_data_root)
        
    def create_file(self, filepath, content):
        """Create a file with the given content."""
        os.makedirs(os.path.dirname(filepath), exist_ok=True)
        with open(filepath, 'w', encoding='utf-8') as f:
            f.write(content)

    def test_migrate_old_version_files(self):
        """Test that old version files are correctly migrated to new structure."""
        
        file_id = "test.document.123"
        
        # Create old structure version files
        old_version_1 = os.path.join(self.test_data_root, "versions", "2025-01-01_12-00-00", f"{file_id}.xml")
        old_version_2 = os.path.join(self.test_data_root, "versions", "2025-01-02_14-30-15", f"{file_id}.tei.xml")
        old_version_3 = os.path.join(self.test_data_root, "versions", "2025-01-03_16-45-30", f"{file_id}.xml")
        
        self.create_file(old_version_1, "Old version 1 content")
        self.create_file(old_version_2, "Old version 2 content (.tei.xml)")
        self.create_file(old_version_3, "Old version 3 content")
        
        # Create a new structure file that should not be migrated
        new_structure_file = os.path.join(self.test_data_root, "versions", file_id, f"2025-01-04_10-20-30-{file_id}.xml")
        self.create_file(new_structure_file, "Already in new structure")
        
        # Run migration
        migrated_count = migrate_old_version_files(file_id, self.test_data_root, self.mock_logger, webdav_enabled=False)
        
        # Verify results
        self.assertEqual(migrated_count, 3, "Should have migrated 3 files")
        
        # Check that old files no longer exist
        self.assertFalse(os.path.exists(old_version_1), "Old version 1 should be moved")
        self.assertFalse(os.path.exists(old_version_2), "Old version 2 should be moved")  
        self.assertFalse(os.path.exists(old_version_3), "Old version 3 should be moved")
        
        # Check that new structure files exist
        expected_new_1 = os.path.join(self.test_data_root, "versions", file_id, f"2025-01-01_12-00-00-{file_id}.xml")
        expected_new_2 = os.path.join(self.test_data_root, "versions", file_id, f"2025-01-02_14-30-15-{file_id}.tei.xml")
        expected_new_3 = os.path.join(self.test_data_root, "versions", file_id, f"2025-01-03_16-45-30-{file_id}.xml")
        
        self.assertTrue(os.path.exists(expected_new_1), "New structure file 1 should exist")
        self.assertTrue(os.path.exists(expected_new_2), "New structure file 2 should exist")
        self.assertTrue(os.path.exists(expected_new_3), "New structure file 3 should exist")
        
        # Check that existing new structure file wasn't touched
        self.assertTrue(os.path.exists(new_structure_file), "Existing new structure file should remain")
        
        # Check file contents
        with open(expected_new_1) as f:
            self.assertEqual(f.read(), "Old version 1 content")
        with open(expected_new_2) as f:
            self.assertEqual(f.read(), "Old version 2 content (.tei.xml)")
        with open(expected_new_3) as f:
            self.assertEqual(f.read(), "Old version 3 content")
        
        # Check that old timestamp directories were removed (if empty)
        old_dir_1 = os.path.dirname(old_version_1)
        old_dir_2 = os.path.dirname(old_version_2)
        old_dir_3 = os.path.dirname(old_version_3)
        
        self.assertFalse(os.path.exists(old_dir_1), "Empty old timestamp directory 1 should be removed")
        self.assertFalse(os.path.exists(old_dir_2), "Empty old timestamp directory 2 should be removed")
        self.assertFalse(os.path.exists(old_dir_3), "Empty old timestamp directory 3 should be removed")
        
    def test_migrate_with_webdav_markers(self):
        """Test migration with WebDAV deletion markers."""
        
        file_id = "webdav.test"
        
        # Create old structure version file
        old_version = os.path.join(self.test_data_root, "versions", "2025-01-01_12-00-00", f"{file_id}.xml")
        self.create_file(old_version, "WebDAV test content")
        
        # Run migration with WebDAV enabled
        migrated_count = migrate_old_version_files(file_id, self.test_data_root, self.mock_logger, webdav_enabled=True)
        
        # Verify results
        self.assertEqual(migrated_count, 1, "Should have migrated 1 file")
        
        # Check that deletion marker was created
        deletion_marker = old_version + ".deleted"
        self.assertTrue(os.path.exists(deletion_marker), "WebDAV deletion marker should be created")
        
    def test_no_migration_needed(self):
        """Test behavior when no old version files exist."""
        
        file_id = "no.old.versions"
        
        # Only create new structure files
        new_file = os.path.join(self.test_data_root, "versions", file_id, f"2025-01-01_12-00-00-{file_id}.xml")
        self.create_file(new_file, "New structure content")
        
        # Run migration
        migrated_count = migrate_old_version_files(file_id, self.test_data_root, self.mock_logger)
        
        # Verify no migration occurred
        self.assertEqual(migrated_count, 0, "Should not migrate any files")
        self.assertTrue(os.path.exists(new_file), "New structure file should remain untouched")
        
    def test_tei_extension_migration_no_double_suffix(self):
        """Test that .tei.xml files don't get double .tei suffix during migration."""
        
        # This simulates the case where file_id might contain .tei (from old processing)
        file_id_with_tei = "10.25364__01.10:2023.2.1.tei"  # This shouldn't happen now, but test the fix
        
        # Create old structure .tei.xml file - this is the pattern that migration looks for
        old_version_tei = os.path.join(self.test_data_root, "versions", "2025-07-12_15-17-04", f"{file_id_with_tei}.xml")
        self.create_file(old_version_tei, "TEI XML content with potential double suffix issue")
        
        # Run migration
        migrated_count = migrate_old_version_files(file_id_with_tei, self.test_data_root, self.mock_logger)
        
        # Verify migration occurred
        self.assertEqual(migrated_count, 1, "Should migrate 1 file")
        
        # Check that the new file doesn't have double .tei
        clean_file_id = "10.25364__01.10:2023.2.1"  # Expected clean file_id
        expected_new_file = os.path.join(
            self.test_data_root, "versions", clean_file_id, 
            f"2025-07-12_15-17-04-{clean_file_id}.tei.xml"
        )
        
        self.assertTrue(os.path.exists(expected_new_file), 
                       f"New file should exist at {expected_new_file}")
        
        # Verify content is preserved
        with open(expected_new_file) as f:
            content = f.read()
        self.assertEqual(content, "TEI XML content with potential double suffix issue")
        
        # Verify no double .tei in filename
        filename = os.path.basename(expected_new_file)
        self.assertNotIn('.tei.tei', filename, "Filename should not contain double .tei")
        
        # The key test: verify the directory name doesn't contain .tei
        directory_name = os.path.basename(os.path.dirname(expected_new_file))
        self.assertEqual(directory_name, clean_file_id, "Directory should be cleaned file_id without .tei")
        self.assertNotIn('.tei', directory_name, "Directory name should not contain .tei")
        
    def test_mixed_file_ids_in_old_structure(self):
        """Test that migration only affects the specified file_id."""
        
        target_file_id = "target.file"
        other_file_id = "other.file"
        
        # Create old structure files for both file IDs
        target_old = os.path.join(self.test_data_root, "versions", "2025-01-01_12-00-00", f"{target_file_id}.xml")
        other_old = os.path.join(self.test_data_root, "versions", "2025-01-01_12-00-00", f"{other_file_id}.xml")
        
        self.create_file(target_old, "Target file content")
        self.create_file(other_old, "Other file content")
        
        # Run migration for target file only
        migrated_count = migrate_old_version_files(target_file_id, self.test_data_root, self.mock_logger)
        
        # Verify only target file was migrated
        self.assertEqual(migrated_count, 1, "Should migrate only 1 file")
        
        # Check target file was migrated
        expected_new_target = os.path.join(self.test_data_root, "versions", target_file_id, f"2025-01-01_12-00-00-{target_file_id}.xml")
        self.assertTrue(os.path.exists(expected_new_target), "Target file should be migrated")
        self.assertFalse(os.path.exists(target_old), "Old target file should be moved")
        
        # Check other file was not affected
        self.assertTrue(os.path.exists(other_old), "Other file should remain in old location")
        
        # The old timestamp directory should still exist because it contains the other file
        old_timestamp_dir = os.path.dirname(target_old)
        self.assertTrue(os.path.exists(old_timestamp_dir), "Old timestamp directory should remain due to other file")


def run_tests():
    """Run the tests when this file is executed directly."""
    unittest.main(verbosity=2)


if __name__ == '__main__':
    run_tests()