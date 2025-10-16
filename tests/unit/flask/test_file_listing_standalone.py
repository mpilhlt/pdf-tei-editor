#!/usr/bin/env python3
"""
Standalone unit tests for file listing logic with new version structure support.

Tests the core file listing logic without Flask dependencies by copying the
relevant functions and testing them in isolation.
"""

import unittest
import tempfile
import os
import shutil
import re
from pathlib import Path
from glob import glob


# Copied and simplified version of the file types mapping
file_types = {'.pdf': 'pdf', '.tei.xml': 'xml', '.xml': 'xml'}


class MockLogger:
    """Mock logger for testing without Flask."""
    def debug(self, message):
        print(f"DEBUG: {message}")
    
    def info(self, message):
        print(f"INFO: {message}")
    
    def warning(self, message):
        print(f"WARNING: {message}")


# Global mock logger instance
mock_logger = MockLogger()


# Import the common utility functions
import sys
import os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from server.lib.file_data import (
    extract_file_id_from_version_filename, 
    extract_version_label_from_path
)


def create_file_data_standalone(data_root):
    """
    Standalone version of create_file_data function for testing.
    
    This is a copy of the function from server/api/files.py with Flask 
    dependencies removed and simplified for testing.
    """
    file_id_data = {}
    for file_path in glob(f"{data_root}/**/*", recursive=True):
        path = Path(file_path).relative_to(data_root)
        file_type = None
        for suffix, type in file_types.items():
            if file_path.endswith(suffix):
                file_type = type
                filename_without_suffix = path.name[:-len(suffix)]
                
                # Extract file_id using common utility function
                is_in_versions_dir = len(path.parts) >= 3 and path.parent.parent.name == "versions"
                file_id, is_new_format = extract_file_id_from_version_filename(
                    filename_without_suffix, is_in_versions_dir
                )
                
                if is_new_format:
                    mock_logger.debug(f"Extracted file_id '{file_id}' from new format filename '{filename_without_suffix}'")
                break
        if file_type is None:
            continue
        
        # create entry in id-type-data map
        if file_id not in file_id_data:
            file_id_data[file_id] = {}
        if file_type not in file_id_data[file_id]:
            file_id_data[file_id][file_type] = []
        file_id_data[file_id][file_type].append(path.as_posix())

    # create the files list
    file_list = []
    # iterate over file ids
    for file_id, file_type_data in file_id_data.items():
        file_dict = {"id": file_id, "versions":[]}
        # iterate over file types
        for file_type, files in file_type_data.items():
            for file_path in files:
                path = Path(file_path)
                path_from_root = "/data/" + file_path
                # Check if this is a version file (either old or new structure)
                is_version_file = (len(path.parts) >= 3 and path.parent.parent.name == "versions")
                
                if is_version_file:
                    # Distinguish between old and new structure
                    is_new_version = path.parent.name == file_id  # New: versions/file-id/timestamp-file-id.xml
                    is_old_version = not is_new_version            # Old: versions/timestamp/file-id.xml
                    
                    mock_logger.debug(f"Processing version file: {file_path}, file_id={file_id}, parent={path.parent.name}, is_new={is_new_version}")
                    
                    # Extract version label using common utility function
                    label = extract_version_label_from_path(path, file_id, is_old_version)
                    
                    file_dict['versions'].append({
                        'label': label,
                        'path': path_from_root
                    })
                else:     
                    file_dict[file_type] = path_from_root

        file_dict['versions'] = sorted(file_dict['versions'], key= lambda file: file.get('version', ''), reverse=True)
        # add original as first version if it exists
        if 'xml' in file_dict:
            file_dict['versions'].insert(0, {
                'path': file_dict['xml'],
                'label': "Gold"
            })
        
        # only add if we have both pdf and xml
        if 'pdf' in file_dict and 'xml' in file_dict:
            file_list.append(file_dict)

    # sort by id
    file_list = sorted(file_list, key=lambda file_dict: file_dict.get("id"))
    return file_list


class TestFileListingLogic(unittest.TestCase):
    """Test the file listing logic with synthetic data structures."""
    
    def setUp(self):
        """Set up a temporary directory with test file structures."""
        self.test_data_root = tempfile.mkdtemp()
        self.maxDiff = None  # Show full diff on assertion failures
        
    def tearDown(self):
        """Clean up the temporary directory."""
        shutil.rmtree(self.test_data_root)
        
    def create_test_files(self):
        """Create a comprehensive test file structure with both old and new version formats."""
        
        # File IDs we'll use for testing
        file_id_1 = "10.1000__test.article.1"
        file_id_2 = "sample_document_2"
        
        # Create directory structure
        os.makedirs(os.path.join(self.test_data_root, "pdf"), exist_ok=True)
        os.makedirs(os.path.join(self.test_data_root, "tei"), exist_ok=True)
        os.makedirs(os.path.join(self.test_data_root, "versions", "2025-01-01_12-00-00"), exist_ok=True)  # Old structure
        os.makedirs(os.path.join(self.test_data_root, "versions", "2025-01-02_14-30-15"), exist_ok=True)  # Old structure
        os.makedirs(os.path.join(self.test_data_root, "versions", file_id_1), exist_ok=True)              # New structure
        os.makedirs(os.path.join(self.test_data_root, "versions", file_id_2), exist_ok=True)              # New structure
        
        # Create main/gold standard files
        self.create_file(os.path.join(self.test_data_root, "pdf", f"{file_id_1}.pdf"), "PDF content 1")
        self.create_file(os.path.join(self.test_data_root, "tei", f"{file_id_1}.tei.xml"), "XML content 1")
        self.create_file(os.path.join(self.test_data_root, "pdf", f"{file_id_2}.pdf"), "PDF content 2")
        self.create_file(os.path.join(self.test_data_root, "tei", f"{file_id_2}.tei.xml"), "XML content 2")
        
        # Create old version structure files: versions/timestamp/file-id.xml
        self.create_file(
            os.path.join(self.test_data_root, "versions", "2025-01-01_12-00-00", f"{file_id_1}.xml"),
            "Old version 1 XML content"
        )
        self.create_file(
            os.path.join(self.test_data_root, "versions", "2025-01-02_14-30-15", f"{file_id_1}.xml"),
            "Old version 2 XML content"
        )
        
        # Create new version structure files: versions/file-id/timestamp-file-id.xml
        self.create_file(
            os.path.join(self.test_data_root, "versions", file_id_1, f"2025-01-03_16-45-30-{file_id_1}.tei.xml"),
            "New version 1 XML content"
        )
        self.create_file(
            os.path.join(self.test_data_root, "versions", file_id_1, f"2025-01-04_09-15-45-{file_id_1}.tei.xml"),
            "New version 2 XML content"
        )
        self.create_file(
            os.path.join(self.test_data_root, "versions", file_id_2, f"2025-01-05_11-20-35-{file_id_2}.xml"),
            "New version 1 XML content for doc 2"
        )
        
    def create_file(self, filepath, content):
        """Create a file with the given content."""
        os.makedirs(os.path.dirname(filepath), exist_ok=True)
        with open(filepath, 'w', encoding='utf-8') as f:
            f.write(content)

    def test_create_file_data_mixed_structures(self):
        """Test create_file_data with both old and new version structures."""
        
        # Create test file structure
        self.create_test_files()
        
        # Call the function under test
        result = create_file_data_standalone(self.test_data_root)
        
        # Debug output
        print(f"\n=== Test Results ===")
        print(f"Number of files found: {len(result)}")
        for file_data in result:
            print(f"\nFile ID: {file_data['id']}")
            print(f"PDF: {file_data.get('pdf', 'N/A')}")
            print(f"XML: {file_data.get('xml', 'N/A')}")
            print(f"Versions: {len(file_data.get('versions', []))}")
            for version in file_data.get('versions', []):
                print(f"  - {version['label']}: {version['path']}")
        
        # Verify we found both file IDs
        self.assertEqual(len(result), 2, "Should find exactly 2 file entries")
        
        # Sort results by ID for consistent testing
        result = sorted(result, key=lambda x: x['id'])
        
        file_1 = result[0]  # 10.1000__test.article.1
        file_2 = result[1]  # sample_document_2
        
        # Test file 1 (has both old and new versions)
        self.assertEqual(file_1['id'], "10.1000__test.article.1")
        self.assertTrue(file_1['pdf'].endswith("10.1000__test.article.1.pdf"))
        self.assertTrue(file_1['xml'].endswith("10.1000__test.article.1.tei.xml"))
        
        # Should have 5 versions: Gold + 2 old + 2 new
        versions_1 = file_1['versions']
        self.assertEqual(len(versions_1), 5, f"File 1 should have 5 versions, got {len(versions_1)}")
        
        # First version should always be "Gold"
        self.assertEqual(versions_1[0]['label'], "Gold")
        self.assertEqual(versions_1[0]['path'], file_1['xml'])
        
        # Check that we have the expected version paths
        version_paths_1 = [v['path'] for v in versions_1[1:]]  # Skip Gold
        expected_old_paths = [
            "/data/versions/2025-01-01_12-00-00/10.1000__test.article.1.xml",
            "/data/versions/2025-01-02_14-30-15/10.1000__test.article.1.xml"
        ]
        expected_new_paths = [
            "/data/versions/10.1000__test.article.1/2025-01-03_16-45-30-10.1000__test.article.1.tei.xml",
            "/data/versions/10.1000__test.article.1/2025-01-04_09-15-45-10.1000__test.article.1.tei.xml"
        ]
        
        for path in expected_old_paths + expected_new_paths:
            self.assertIn(path, version_paths_1, f"Should find version path: {path}")
        
        # Test file 2 (has only new version)
        self.assertEqual(file_2['id'], "sample_document_2")
        self.assertTrue(file_2['pdf'].endswith("sample_document_2.pdf"))
        self.assertTrue(file_2['xml'].endswith("sample_document_2.tei.xml"))
        
        # Should have 2 versions: Gold + 1 new
        versions_2 = file_2['versions']
        self.assertEqual(len(versions_2), 2, f"File 2 should have 2 versions, got {len(versions_2)}")
        
        # First version should be "Gold"
        self.assertEqual(versions_2[0]['label'], "Gold")
        
        # Check new structure version
        new_version_path = "/data/versions/sample_document_2/2025-01-05_11-20-35-sample_document_2.xml"
        self.assertIn(new_version_path, [v['path'] for v in versions_2])
        
    def test_version_file_id_extraction(self):
        """Test that file_id is correctly extracted from new version filename format."""
        
        # Create a single test case with complex file ID
        complex_file_id = "10.19164__ijple.v6i1.1295"
        
        os.makedirs(os.path.join(self.test_data_root, "pdf"), exist_ok=True)
        os.makedirs(os.path.join(self.test_data_root, "tei"), exist_ok=True)
        os.makedirs(os.path.join(self.test_data_root, "versions", complex_file_id), exist_ok=True)
        
        # Create main files
        self.create_file(os.path.join(self.test_data_root, "pdf", f"{complex_file_id}.pdf"), "PDF content")
        self.create_file(os.path.join(self.test_data_root, "tei", f"{complex_file_id}.tei.xml"), "XML content")
        
        # Create new version with the exact format from the user's example
        version_filename = f"2025-08-05_17-58-22-{complex_file_id}.tei.xml"
        self.create_file(
            os.path.join(self.test_data_root, "versions", complex_file_id, version_filename),
            "Version XML content"
        )
        
        # Call the function
        result = create_file_data_standalone(self.test_data_root)
        
        # Debug output
        print(f"\n=== File ID Extraction Test ===")
        for file_data in result:
            print(f"File ID: {file_data['id']}")
            for version in file_data.get('versions', []):
                print(f"  Version: {version['label']} -> {version['path']}")
        
        # Verify
        self.assertEqual(len(result), 1, "Should find exactly 1 file entry")
        
        file_entry = result[0]
        self.assertEqual(file_entry['id'], complex_file_id, "Should correctly extract complex file ID")
        
        # Should have 2 versions: Gold + 1 new version
        versions = file_entry['versions']
        self.assertEqual(len(versions), 2, "Should have Gold + 1 version")
        
        # Check that the new version path is correct
        expected_version_path = f"/data/versions/{complex_file_id}/{version_filename}"
        version_paths = [v['path'] for v in versions if v['label'] != "Gold"]
        self.assertIn(expected_version_path, version_paths, 
                     f"Should find version path: {expected_version_path}")
        
    def test_empty_directory_structure(self):
        """Test create_file_data with empty directories."""
        
        # Create empty directory structure
        os.makedirs(os.path.join(self.test_data_root, "pdf"), exist_ok=True)
        os.makedirs(os.path.join(self.test_data_root, "tei"), exist_ok=True)
        os.makedirs(os.path.join(self.test_data_root, "versions"), exist_ok=True)
        
        # Call the function
        result = create_file_data_standalone(self.test_data_root)
        
        # Should return empty list
        self.assertEqual(len(result), 0, "Should return empty list for empty directory structure")
        
    def test_only_pdf_files(self):
        """Test create_file_data when only PDF files exist (no XML counterparts)."""
        
        # Create only PDF files
        os.makedirs(os.path.join(self.test_data_root, "pdf"), exist_ok=True)
        self.create_file(os.path.join(self.test_data_root, "pdf", "test1.pdf"), "PDF content 1")
        self.create_file(os.path.join(self.test_data_root, "pdf", "test2.pdf"), "PDF content 2")
        
        # Call the function
        result = create_file_data_standalone(self.test_data_root)
        
        # Should return empty list because we need both PDF and XML
        self.assertEqual(len(result), 0, "Should return empty list when only PDF files exist")

    def test_file_id_extraction_with_tei_extension(self):
        """Test that file_id extraction correctly handles .tei.xml files."""
        from pathlib import Path
        
        def extract_file_id_test(file_path_rel):
            """Test version of file_id extraction logic."""
            file_id = Path(file_path_rel).stem
            if file_id.endswith('.tei'):
                file_id = file_id[:-4]
            return file_id
        
        test_cases = [
            # (input_path, expected_file_id)
            ("tei/10.19164__ijple.v6i1.1295.tei.xml", "10.19164__ijple.v6i1.1295"),
            ("tei/simple-document.xml", "simple-document"),
            ("tei/complex.file.name.tei.xml", "complex.file.name"),
            ("versions/timestamp/document.xml", "document"),
            ("versions/timestamp/test.tei.xml", "test"),
        ]
        
        for input_path, expected in test_cases:
            with self.subTest(input_path=input_path):
                result = extract_file_id_test(input_path)
                self.assertEqual(result, expected, 
                               f"File ID extraction failed for {input_path}")

    def test_version_label_extraction(self):
        """Test that version labels are correctly extracted, especially for .tei.xml files."""
        from pathlib import Path
        
        test_cases = [
            # (path, file_id, is_old_version, expected_label)
            (Path("versions/2025-01-01_12-00-00/test.xml"), "test", True, "2025-01-01 12-00-00"),
            (Path("versions/test/2025-08-05_17-58-22-test.xml"), "test", False, "2025-08-05 17-58-22"),
            (Path("versions/10.19164__ijple.v6i1.1295/2025-08-05_17-58-22-10.19164__ijple.v6i1.1295.tei.xml"), 
             "10.19164__ijple.v6i1.1295", False, "2025-08-05 17-58-22"),
            (Path("versions/complex-file-id/2024-12-25_00-00-01-complex-file-id.tei.xml"), 
             "complex-file-id", False, "2024-12-25 00-00-01"),
        ]
        
        for path, file_id, is_old_version, expected in test_cases:
            with self.subTest(path=str(path), file_id=file_id):
                result = extract_version_label_from_path(path, file_id, is_old_version)
                self.assertEqual(result, expected, 
                               f"Label extraction failed for {path} with file_id {file_id}")

    def test_regex_extraction_edge_cases(self):
        """Test the regex pattern matching for various edge cases."""
        
        test_cases = [
            # (filename_without_suffix, expected_file_id)
            ("2025-08-05_17-58-22-10.19164__ijple.v6i1.1295", "10.19164__ijple.v6i1.1295"),
            ("2024-12-25_00-00-01-simple_doc", "simple_doc"),
            ("2023-11-30_23-59-59-complex-file-with-dashes", "complex-file-with-dashes"),
            ("2025-01-01_12-30-45-file.with.dots", "file.with.dots"),
            ("invalid-timestamp-format", "invalid-timestamp-format"),  # Should not match, return as-is
            ("2025-13-45_25-70-80-invalid-timestamp", "invalid-timestamp"),  # Invalid date/time but still matches pattern
        ]
        
        timestamp_pattern = r'^(\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2})-(.+)$'
        
        for filename, expected_file_id in test_cases:
            with self.subTest(filename=filename):
                match = re.match(timestamp_pattern, filename)
                if match:
                    actual_file_id = match.group(2)
                else:
                    actual_file_id = filename
                
                self.assertEqual(actual_file_id, expected_file_id, 
                               f"Failed to extract correct file_id from '{filename}'")


def run_tests():
    """Run the tests when this file is executed directly."""
    unittest.main(verbosity=2)


if __name__ == '__main__':
    run_tests()