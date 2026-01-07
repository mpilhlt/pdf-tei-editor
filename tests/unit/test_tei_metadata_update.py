"""
Unit tests for TEI metadata extraction and PDF metadata update functionality.

Tests the shared functions in tei_utils.py:
- build_pdf_label_from_metadata()
- update_pdf_metadata_from_tei()
"""

import unittest
from unittest.mock import Mock, MagicMock
from lxml import etree
import logging

from fastapi_app.lib.tei_utils import (
    build_pdf_label_from_metadata,
    update_pdf_metadata_from_tei,
    extract_tei_metadata
)


class TestBuildPdfLabelFromMetadata(unittest.TestCase):
    """Test build_pdf_label_from_metadata() function."""

    def test_full_metadata(self):
        """Label with author, year, and title."""
        doc_metadata = {
            'title': 'Machine Learning for Scholars',
            'authors': [{'given': 'Jane', 'family': 'Smith'}],
            'date': '2023'
        }
        label = build_pdf_label_from_metadata(doc_metadata)
        self.assertEqual(label, "Smith (2023) Machine Learning for Scholars")

    def test_author_and_title_only(self):
        """Label with author and title, no date."""
        doc_metadata = {
            'title': 'Deep Learning',
            'authors': [{'given': 'John', 'family': 'Doe'}]
        }
        label = build_pdf_label_from_metadata(doc_metadata)
        self.assertEqual(label, "Doe Deep Learning")

    def test_date_and_title_only(self):
        """Label with date and title, no author."""
        doc_metadata = {
            'title': 'Neural Networks',
            'date': '2022'
        }
        label = build_pdf_label_from_metadata(doc_metadata)
        self.assertEqual(label, "(2022) Neural Networks")

    def test_title_only(self):
        """Label with title only."""
        doc_metadata = {
            'title': 'Introduction to AI'
        }
        label = build_pdf_label_from_metadata(doc_metadata)
        self.assertEqual(label, "Introduction to AI")

    def test_no_title(self):
        """No label when title is missing."""
        doc_metadata = {
            'authors': [{'given': 'Jane', 'family': 'Smith'}],
            'date': '2023'
        }
        label = build_pdf_label_from_metadata(doc_metadata)
        self.assertIsNone(label)

    def test_empty_metadata(self):
        """No label when metadata is empty."""
        label = build_pdf_label_from_metadata({})
        self.assertIsNone(label)

    def test_author_without_family_name(self):
        """Author without family name is ignored."""
        doc_metadata = {
            'title': 'Research Paper',
            'authors': [{'given': 'Jane'}],
            'date': '2023'
        }
        label = build_pdf_label_from_metadata(doc_metadata)
        self.assertEqual(label, "(2023) Research Paper")

    def test_multiple_authors_uses_first(self):
        """Multiple authors: use first author's family name."""
        doc_metadata = {
            'title': 'Collaborative Work',
            'authors': [
                {'given': 'Jane', 'family': 'Smith'},
                {'given': 'John', 'family': 'Doe'}
            ],
            'date': '2024'
        }
        label = build_pdf_label_from_metadata(doc_metadata)
        self.assertEqual(label, "Smith (2024) Collaborative Work")


class TestUpdatePdfMetadataFromTei(unittest.TestCase):
    """Test update_pdf_metadata_from_tei() function."""

    def setUp(self):
        """Set up mock objects for each test."""
        self.mock_pdf_file = Mock()
        self.mock_pdf_file.id = "abc123def456"

        self.mock_file_repo = Mock()
        self.mock_logger = Mock()

    def test_update_with_full_metadata(self):
        """Update PDF with full metadata and label."""
        tei_metadata = {
            'doc_metadata': {
                'title': 'Research Paper',
                'authors': [{'given': 'Jane', 'family': 'Smith'}],
                'date': '2023',
                'journal': 'Science Journal',
                'publisher': 'Academic Press'
            }
        }

        result = update_pdf_metadata_from_tei(
            self.mock_pdf_file,
            tei_metadata,
            self.mock_file_repo,
            self.mock_logger
        )

        self.assertTrue(result)
        self.mock_file_repo.update_file.assert_called_once()

        # Check the FileUpdate argument
        call_args = self.mock_file_repo.update_file.call_args
        self.assertEqual(call_args[0][0], "abc123def456")  # file_id

        file_update = call_args[0][1]
        self.assertEqual(file_update.label, "Smith (2023) Research Paper")
        self.assertIsNotNone(file_update.doc_metadata)
        self.assertEqual(file_update.doc_metadata['title'], 'Research Paper')

    def test_update_with_collections(self):
        """Update PDF with collections sync."""
        tei_metadata = {
            'doc_metadata': {
                'title': 'Research Paper'
            }
        }
        doc_collections = ['collection1', 'collection2']

        result = update_pdf_metadata_from_tei(
            self.mock_pdf_file,
            tei_metadata,
            self.mock_file_repo,
            self.mock_logger,
            doc_collections=doc_collections
        )

        self.assertTrue(result)

        call_args = self.mock_file_repo.update_file.call_args
        file_update = call_args[0][1]
        self.assertEqual(file_update.doc_collections, ['collection1', 'collection2'])

    def test_fallback_to_doc_id_for_label(self):
        """Use doc_id as label when no title in metadata."""
        tei_metadata = {
            'doc_id': '10.1234/example.doi',
            'doc_metadata': {
                'authors': [{'given': 'Jane', 'family': 'Smith'}]
            }
        }

        result = update_pdf_metadata_from_tei(
            self.mock_pdf_file,
            tei_metadata,
            self.mock_file_repo,
            self.mock_logger
        )

        self.assertTrue(result)

        call_args = self.mock_file_repo.update_file.call_args
        file_update = call_args[0][1]
        self.assertEqual(file_update.label, '10.1234/example.doi')

    def test_no_update_when_no_metadata(self):
        """No update when metadata is empty."""
        tei_metadata = {
            'doc_metadata': {}
        }

        result = update_pdf_metadata_from_tei(
            self.mock_pdf_file,
            tei_metadata,
            self.mock_file_repo,
            self.mock_logger
        )

        self.assertFalse(result)
        self.mock_file_repo.update_file.assert_not_called()

    def test_handles_update_failure_gracefully(self):
        """Handle update failure gracefully."""
        self.mock_file_repo.update_file.side_effect = Exception("Database error")

        tei_metadata = {
            'doc_metadata': {
                'title': 'Research Paper'
            }
        }

        result = update_pdf_metadata_from_tei(
            self.mock_pdf_file,
            tei_metadata,
            self.mock_file_repo,
            self.mock_logger
        )

        self.assertFalse(result)

        # Verify logger.warning was called with the error message
        self.mock_logger.warning.assert_called_once()
        warning_message = self.mock_logger.warning.call_args[0][0]
        self.assertIn("Failed to update PDF metadata", warning_message)


class TestExtractTeiMetadataIntegration(unittest.TestCase):
    """Integration test: extract_tei_metadata() produces valid input for update_pdf_metadata_from_tei()."""

    def test_extraction_and_update_flow(self):
        """Complete flow: extract metadata from TEI, then update PDF."""
        # Sample TEI XML
        tei_xml = """
        <TEI xmlns="http://www.tei-c.org/ns/1.0">
            <teiHeader>
                <fileDesc>
                    <titleStmt>
                        <title level="a">Machine Learning in Digital Humanities</title>
                        <author>
                            <persName>
                                <forename>Jane</forename>
                                <surname>Smith</surname>
                            </persName>
                        </author>
                    </titleStmt>
                    <publicationStmt>
                        <publisher>Academic Press</publisher>
                        <date type="publication">2023</date>
                        <idno type="DOI">10.1234/ml.dh.2023</idno>
                    </publicationStmt>
                    <sourceDesc>
                        <bibl>
                            <title level="j">Digital Humanities Quarterly</title>
                        </bibl>
                    </sourceDesc>
                </fileDesc>
                <encodingDesc>
                    <appInfo>
                        <application version="0.7.1" ident="GROBID" when="2023-01-01" type="extractor">
                            <label type="variant-id">grobid-segmentation</label>
                        </application>
                    </appInfo>
                </encodingDesc>
            </teiHeader>
        </TEI>
        """

        tei_root = etree.fromstring(tei_xml.encode('utf-8'))
        tei_metadata = extract_tei_metadata(tei_root)

        # Verify extracted metadata structure
        self.assertIn('doc_metadata', tei_metadata)
        self.assertEqual(tei_metadata['doc_metadata']['title'], 'Machine Learning in Digital Humanities')
        self.assertEqual(tei_metadata['doc_metadata']['date'], '2023')
        self.assertEqual(tei_metadata['doc_id'], '10.1234/ml.dh.2023')
        self.assertEqual(tei_metadata['variant'], 'grobid-segmentation')

        # Mock PDF file and repository
        mock_pdf_file = Mock()
        mock_pdf_file.id = "pdf123abc"
        mock_file_repo = Mock()
        mock_logger = Mock()

        # Update PDF metadata
        result = update_pdf_metadata_from_tei(
            mock_pdf_file,
            tei_metadata,
            mock_file_repo,
            mock_logger
        )

        self.assertTrue(result)

        # Verify update was called with correct data
        call_args = mock_file_repo.update_file.call_args
        file_update = call_args[0][1]

        self.assertEqual(file_update.label, "Smith (2023) Machine Learning in Digital Humanities")
        self.assertIsNotNone(file_update.doc_metadata)
        self.assertEqual(file_update.doc_metadata['title'], 'Machine Learning in Digital Humanities')
        self.assertEqual(file_update.doc_metadata['publisher'], 'Academic Press')
        self.assertEqual(file_update.doc_metadata['journal'], 'Digital Humanities Quarterly')


if __name__ == '__main__':
    unittest.main()
