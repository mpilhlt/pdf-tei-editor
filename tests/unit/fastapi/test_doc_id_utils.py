"""
Unit tests for doc_id_utils and the FileRepository counter method it depends on.

@testCovers fastapi_app/lib/utils/doc_id_utils.py
@testCovers fastapi_app/lib/repository/file_repository.py
"""
import shutil
import tempfile
import unittest
import uuid as _uuid
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).parent.parent.parent.parent))

from fastapi_app.lib.core.database import DatabaseManager
from fastapi_app.lib.repository.file_repository import FileRepository
from fastapi_app.lib.models.models import FileCreate
from fastapi_app.lib.utils.doc_id_utils import resolve_doc_id
from unittest.mock import MagicMock, patch


class TestGetMaxCollectionCounter(unittest.TestCase):
    """Test FileRepository.get_max_collection_counter."""

    def setUp(self):
        self.test_dir = Path(tempfile.mkdtemp())
        self.db = DatabaseManager(self.test_dir / "test.db")
        self.repo = FileRepository(self.db)

    def tearDown(self):
        import gc
        gc.collect()
        shutil.rmtree(self.test_dir)

    def _insert(self, file_id: str, doc_id: str) -> None:
        self.repo.insert_file(FileCreate(
            id=file_id, filename=f"{file_id}.pdf",
            doc_id=doc_id, file_type='pdf', file_size=100
        ))

    def test_returns_zero_when_no_files(self):
        """Returns 0 when no files match the prefix."""
        self.assertEqual(self.repo.get_max_collection_counter("mycol"), 0)

    def test_returns_max_of_multiple_entries(self):
        """Returns the highest numeric suffix."""
        self._insert("f1", "mycol-0001")
        self._insert("f2", "mycol-0003")
        self._insert("f3", "mycol-0002")
        self.assertEqual(self.repo.get_max_collection_counter("mycol"), 3)

    def test_ignores_different_prefix(self):
        """Does not count files with a different prefix."""
        self._insert("f1", "other-0005")
        self.assertEqual(self.repo.get_max_collection_counter("mycol"), 0)

    def test_ignores_non_numeric_suffixes(self):
        """Files whose suffix is not all digits are not counted."""
        self._insert("f1", "mycol-0001")
        self._insert("f2", "mycol-extra")
        self.assertEqual(self.repo.get_max_collection_counter("mycol"), 1)


class TestResolveDocId(unittest.TestCase):
    """Test resolve_doc_id() for all four modes."""

    def test_filename_mode_strips_extension(self):
        self.assertEqual(resolve_doc_id('filename', 'my-doc.pdf', b'', 'pdf'), 'my-doc')

    def test_filename_mode_replaces_whitespace(self):
        self.assertEqual(resolve_doc_id('filename', 'My Document.pdf', b'', 'pdf'), 'My_Document')

    def test_filename_mode_decodes_double_underscore(self):
        self.assertEqual(resolve_doc_id('filename', '10.1111__eulj.12049.pdf', b'', 'pdf'), '10.1111/eulj.12049')

    def test_filename_mode_decodes_single_underscore_doi(self):
        self.assertEqual(resolve_doc_id('filename', '10.1111_eulj.12049.pdf', b'', 'pdf'), '10.1111/eulj.12049')

    def test_filename_mode_does_not_extract_doi(self):
        with patch('fastapi_app.lib.utils.doc_id_utils.extract_doi_from_pdf') as mock_ex:
            resolve_doc_id('filename', 'my-doc.pdf', b'fake-bytes', 'pdf')
            mock_ex.assert_not_called()

    def test_doi_mode_extracts_doi_from_pdf_content(self):
        with patch('fastapi_app.lib.utils.doc_id_utils.extract_doi_from_pdf', return_value='10.5678/found'):
            result = resolve_doc_id('doi', 'my-doc.pdf', b'fake-pdf', 'pdf')
        self.assertEqual(result, '10.5678/found')

    def test_doi_mode_falls_back_to_filename_when_no_doi(self):
        with patch('fastapi_app.lib.utils.doc_id_utils.extract_doi_from_pdf', return_value=None):
            result = resolve_doc_id('doi', 'my-doc.pdf', b'', 'pdf')
        self.assertEqual(result, 'my-doc')

    def test_doi_mode_skips_extraction_for_xml(self):
        with patch('fastapi_app.lib.utils.doc_id_utils.extract_doi_from_pdf') as mock_ex:
            result = resolve_doc_id('doi', 'my-doc.xml', b'', 'xml')
            mock_ex.assert_not_called()
        self.assertEqual(result, 'my-doc')

    def test_doi_mode_skips_extraction_when_filename_is_already_doi(self):
        with patch('fastapi_app.lib.utils.doc_id_utils.extract_doi_from_pdf') as mock_ex:
            result = resolve_doc_id('doi', '10.1111__eulj.12049.pdf', b'', 'pdf')
            mock_ex.assert_not_called()
        self.assertEqual(result, '10.1111/eulj.12049')

    def test_collection_mode_first_doc_is_0001(self):
        mock_repo = MagicMock()
        mock_repo.get_max_collection_counter.return_value = 0
        result = resolve_doc_id('collection', 'irrelevant.pdf', b'', 'pdf', 'mycol', mock_repo)
        self.assertEqual(result, 'mycol-0001')
        mock_repo.get_max_collection_counter.assert_called_once_with('mycol')

    def test_collection_mode_increments_counter(self):
        mock_repo = MagicMock()
        mock_repo.get_max_collection_counter.return_value = 5
        result = resolve_doc_id('collection', 'irrelevant.pdf', b'', 'pdf', 'mycol', mock_repo)
        self.assertEqual(result, 'mycol-0006')

    def test_collection_mode_pads_to_four_digits(self):
        mock_repo = MagicMock()
        mock_repo.get_max_collection_counter.return_value = 99
        result = resolve_doc_id('collection', 'irrelevant.pdf', b'', 'pdf', 'mycol', mock_repo)
        self.assertEqual(result, 'mycol-0100')

    def test_collection_mode_falls_back_to_doi_without_collection_id(self):
        with patch('fastapi_app.lib.utils.doc_id_utils.extract_doi_from_pdf', return_value=None):
            result = resolve_doc_id('collection', 'my-doc.pdf', b'', 'pdf', None, None)
        self.assertEqual(result, 'my-doc')

    def test_collection_mode_uses_counter_1_on_db_failure(self):
        mock_repo = MagicMock()
        mock_repo.get_max_collection_counter.side_effect = Exception("DB error")
        with patch('fastapi_app.lib.utils.doc_id_utils.extract_doi_from_pdf', return_value=None):
            result = resolve_doc_id('collection', 'my-doc.pdf', b'', 'pdf', 'mycol', mock_repo)
        self.assertEqual(result, 'mycol-0001')

    def test_uuid_mode_returns_valid_uuid4(self):
        result = resolve_doc_id('uuid', 'irrelevant.pdf', b'', 'pdf')
        parsed = _uuid.UUID(result)
        self.assertEqual(parsed.version, 4)

    def test_unknown_mode_falls_back_to_doi_with_warning(self):
        with patch('fastapi_app.lib.utils.doc_id_utils.extract_doi_from_pdf', return_value=None):
            with self.assertLogs('fastapi_app.lib.utils.doc_id_utils', level='WARNING') as log:
                result = resolve_doc_id('bogus', 'my-doc.pdf', b'', 'pdf')
        self.assertEqual(result, 'my-doc')
        self.assertTrue(any('bogus' in line for line in log.output))
