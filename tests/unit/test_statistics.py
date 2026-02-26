"""
Unit tests for statistics module.

@testCovers fastapi_app/lib/statistics.py
"""

import unittest
from datetime import datetime
from unittest.mock import MagicMock

from fastapi_app.lib.services.statistics import calculate_collection_statistics


class TestCalculateCollectionStatistics(unittest.TestCase):
    """Test cases for calculate_collection_statistics function."""

    def setUp(self):
        """Set up test fixtures."""
        self.file_repo = MagicMock()
        self.lifecycle_order = ["draft", "review", "final"]

    def test_empty_collection(self):
        """Test statistics for empty collection."""
        self.file_repo.get_files_by_collection.return_value = []

        result = calculate_collection_statistics(
            file_repo=self.file_repo,
            collection="empty-collection",
            variant=None,
            lifecycle_order=self.lifecycle_order
        )

        self.assertEqual(result["total_docs"], 0)
        self.assertEqual(result["total_annotations"], 0)
        self.assertEqual(result["avg_progress"], 0)
        self.assertEqual(result["stage_counts"]["draft"], 0)
        self.assertEqual(result["stage_counts"]["review"], 0)
        self.assertEqual(result["stage_counts"]["final"], 0)
        self.assertEqual(result["stage_counts"]["no-status"], 0)
        self.assertEqual(len(result["doc_annotations"]), 0)

    def test_collection_with_single_document(self):
        """Test statistics for collection with single document and annotation."""
        pdf_file = MagicMock()
        pdf_file.doc_id = "doc1"
        pdf_file.file_type = "pdf"

        tei_file = MagicMock()
        tei_file.doc_id = "doc1"
        tei_file.file_type = "tei"
        tei_file.label = "Test Annotation"
        tei_file.stable_id = "abc123"
        tei_file.status = "draft"
        tei_file.updated_at = datetime(2024, 1, 15, 10, 0, 0)
        tei_file.variant = None

        self.file_repo.get_files_by_collection.return_value = [pdf_file, tei_file]

        result = calculate_collection_statistics(
            file_repo=self.file_repo,
            collection="test-collection",
            variant=None,
            lifecycle_order=self.lifecycle_order
        )

        self.assertEqual(result["total_docs"], 1)
        self.assertEqual(result["total_annotations"], 1)
        self.assertAlmostEqual(result["avg_progress"], 100.0 / 3, places=2)  # First stage out of 3
        self.assertEqual(result["stage_counts"]["draft"], 1)
        self.assertEqual(result["stage_counts"]["review"], 0)
        self.assertEqual(result["stage_counts"]["final"], 0)
        self.assertEqual(result["stage_counts"]["no-status"], 0)

        # Check annotation data
        self.assertIn("doc1", result["doc_annotations"])
        annotations = result["doc_annotations"]["doc1"]
        self.assertEqual(len(annotations), 1)
        self.assertEqual(annotations[0]["annotation_label"], "Test Annotation")
        self.assertEqual(annotations[0]["stable_id"], "abc123")
        self.assertEqual(annotations[0]["status"], "draft")

    def test_collection_with_multiple_documents(self):
        """Test statistics for collection with multiple documents."""
        pdf1 = MagicMock()
        pdf1.doc_id = "doc1"
        pdf1.file_type = "pdf"

        pdf2 = MagicMock()
        pdf2.doc_id = "doc2"
        pdf2.file_type = "pdf"

        tei1 = MagicMock()
        tei1.doc_id = "doc1"
        tei1.file_type = "tei"
        tei1.label = "Annotation 1"
        tei1.stable_id = "abc123"
        tei1.status = "draft"
        tei1.updated_at = datetime(2024, 1, 15, 10, 0, 0)
        tei1.variant = None

        tei2 = MagicMock()
        tei2.doc_id = "doc2"
        tei2.file_type = "tei"
        tei2.label = "Annotation 2"
        tei2.stable_id = "def456"
        tei2.status = "final"
        tei2.updated_at = datetime(2024, 1, 16, 10, 0, 0)
        tei2.variant = None

        self.file_repo.get_files_by_collection.return_value = [pdf1, pdf2, tei1, tei2]

        result = calculate_collection_statistics(
            file_repo=self.file_repo,
            collection="test-collection",
            variant=None,
            lifecycle_order=self.lifecycle_order
        )

        self.assertEqual(result["total_docs"], 2)
        self.assertEqual(result["total_annotations"], 2)
        # doc1 is at stage 1/3 (33.33%), doc2 is at stage 3/3 (100%)
        # Average: (33.33 + 100) / 2 = 66.67%
        self.assertAlmostEqual(result["avg_progress"], 66.67, places=1)
        self.assertEqual(result["stage_counts"]["draft"], 1)
        self.assertEqual(result["stage_counts"]["review"], 0)
        self.assertEqual(result["stage_counts"]["final"], 1)
        self.assertEqual(result["stage_counts"]["no-status"], 0)

    def test_document_with_multiple_annotations_uses_newest(self):
        """Test that document status is based on most recent annotation."""
        pdf = MagicMock()
        pdf.doc_id = "doc1"
        pdf.file_type = "pdf"

        tei1 = MagicMock()
        tei1.doc_id = "doc1"
        tei1.file_type = "tei"
        tei1.label = "Annotation 1"
        tei1.stable_id = "abc123"
        tei1.status = "draft"
        tei1.updated_at = datetime(2024, 1, 15, 10, 0, 0)  # Older
        tei1.variant = None

        tei2 = MagicMock()
        tei2.doc_id = "doc1"
        tei2.file_type = "tei"
        tei2.label = "Annotation 2"
        tei2.stable_id = "def456"
        tei2.status = "review"
        tei2.updated_at = datetime(2024, 1, 16, 10, 0, 0)  # Newer
        tei2.variant = None

        self.file_repo.get_files_by_collection.return_value = [pdf, tei1, tei2]

        result = calculate_collection_statistics(
            file_repo=self.file_repo,
            collection="test-collection",
            variant=None,
            lifecycle_order=self.lifecycle_order
        )

        self.assertEqual(result["total_docs"], 1)
        self.assertEqual(result["total_annotations"], 2)
        # Should use "review" status from newer annotation
        self.assertEqual(result["stage_counts"]["draft"], 0)
        self.assertEqual(result["stage_counts"]["review"], 1)
        self.assertEqual(result["stage_counts"]["final"], 0)

    def test_variant_filtering(self):
        """Test variant filtering."""
        pdf = MagicMock()
        pdf.doc_id = "doc1"
        pdf.file_type = "pdf"

        tei1 = MagicMock()
        tei1.doc_id = "doc1"
        tei1.file_type = "tei"
        tei1.label = "Variant A"
        tei1.stable_id = "abc123"
        tei1.status = "draft"
        tei1.updated_at = datetime(2024, 1, 15, 10, 0, 0)
        tei1.variant = "variant-a"

        tei2 = MagicMock()
        tei2.doc_id = "doc1"
        tei2.file_type = "tei"
        tei2.label = "Variant B"
        tei2.stable_id = "def456"
        tei2.status = "final"
        tei2.updated_at = datetime(2024, 1, 16, 10, 0, 0)
        tei2.variant = "variant-b"

        self.file_repo.get_files_by_collection.return_value = [pdf, tei1, tei2]

        # Filter by variant-a
        result = calculate_collection_statistics(
            file_repo=self.file_repo,
            collection="test-collection",
            variant="variant-a",
            lifecycle_order=self.lifecycle_order
        )

        self.assertEqual(result["total_annotations"], 1)
        self.assertIn("doc1", result["doc_annotations"])
        self.assertEqual(len(result["doc_annotations"]["doc1"]), 1)
        self.assertEqual(result["doc_annotations"]["doc1"][0]["annotation_label"], "Variant A")

    def test_variant_all_includes_all(self):
        """Test that variant='all' includes all variants."""
        pdf = MagicMock()
        pdf.doc_id = "doc1"
        pdf.file_type = "pdf"

        tei1 = MagicMock()
        tei1.doc_id = "doc1"
        tei1.file_type = "tei"
        tei1.label = "Variant A"
        tei1.stable_id = "abc123"
        tei1.status = "draft"
        tei1.updated_at = datetime(2024, 1, 15, 10, 0, 0)
        tei1.variant = "variant-a"

        tei2 = MagicMock()
        tei2.doc_id = "doc1"
        tei2.file_type = "tei"
        tei2.label = "Variant B"
        tei2.stable_id = "def456"
        tei2.status = "final"
        tei2.updated_at = datetime(2024, 1, 16, 10, 0, 0)
        tei2.variant = "variant-b"

        self.file_repo.get_files_by_collection.return_value = [pdf, tei1, tei2]

        result = calculate_collection_statistics(
            file_repo=self.file_repo,
            collection="test-collection",
            variant="all",
            lifecycle_order=self.lifecycle_order
        )

        self.assertEqual(result["total_annotations"], 2)

    def test_document_without_annotations(self):
        """Test document with no annotations counts as no-status."""
        pdf = MagicMock()
        pdf.doc_id = "doc1"
        pdf.file_type = "pdf"

        self.file_repo.get_files_by_collection.return_value = [pdf]

        result = calculate_collection_statistics(
            file_repo=self.file_repo,
            collection="test-collection",
            variant=None,
            lifecycle_order=self.lifecycle_order
        )

        self.assertEqual(result["total_docs"], 1)
        self.assertEqual(result["total_annotations"], 0)
        self.assertEqual(result["stage_counts"]["no-status"], 1)
        self.assertEqual(result["avg_progress"], 0)

    def test_annotation_with_no_status(self):
        """Test annotation with empty status counts as no-status."""
        pdf = MagicMock()
        pdf.doc_id = "doc1"
        pdf.file_type = "pdf"

        tei = MagicMock()
        tei.doc_id = "doc1"
        tei.file_type = "tei"
        tei.label = "Test Annotation"
        tei.stable_id = "abc123"
        tei.status = ""  # Empty status
        tei.updated_at = datetime(2024, 1, 15, 10, 0, 0)
        tei.variant = None

        self.file_repo.get_files_by_collection.return_value = [pdf, tei]

        result = calculate_collection_statistics(
            file_repo=self.file_repo,
            collection="test-collection",
            variant=None,
            lifecycle_order=self.lifecycle_order
        )

        self.assertEqual(result["total_docs"], 1)
        self.assertEqual(result["total_annotations"], 1)
        self.assertEqual(result["stage_counts"]["no-status"], 1)
        # No progress since status is not in lifecycle_order
        self.assertEqual(result["avg_progress"], 0)

    def test_annotation_with_unknown_status(self):
        """Test annotation with status not in lifecycle_order counts as no-status."""
        pdf = MagicMock()
        pdf.doc_id = "doc1"
        pdf.file_type = "pdf"

        tei = MagicMock()
        tei.doc_id = "doc1"
        tei.file_type = "tei"
        tei.label = "Test Annotation"
        tei.stable_id = "abc123"
        tei.status = "unknown-status"
        tei.updated_at = datetime(2024, 1, 15, 10, 0, 0)
        tei.variant = None

        self.file_repo.get_files_by_collection.return_value = [pdf, tei]

        result = calculate_collection_statistics(
            file_repo=self.file_repo,
            collection="test-collection",
            variant=None,
            lifecycle_order=self.lifecycle_order
        )

        self.assertEqual(result["stage_counts"]["no-status"], 1)
        self.assertEqual(result["avg_progress"], 0)

    def test_annotation_with_none_status(self):
        """Test annotation with None status counts as no-status."""
        pdf = MagicMock()
        pdf.doc_id = "doc1"
        pdf.file_type = "pdf"

        tei = MagicMock()
        tei.doc_id = "doc1"
        tei.file_type = "tei"
        tei.label = "Test Annotation"
        tei.stable_id = "abc123"
        tei.status = None
        tei.updated_at = datetime(2024, 1, 15, 10, 0, 0)
        tei.variant = None

        self.file_repo.get_files_by_collection.return_value = [pdf, tei]

        result = calculate_collection_statistics(
            file_repo=self.file_repo,
            collection="test-collection",
            variant=None,
            lifecycle_order=self.lifecycle_order
        )

        self.assertEqual(result["stage_counts"]["no-status"], 1)
        # Annotation should still be included in doc_annotations with empty status
        self.assertEqual(result["doc_annotations"]["doc1"][0]["status"], "")

    def test_default_label_for_untitled_annotation(self):
        """Test that annotations without label get default 'Untitled'."""
        pdf = MagicMock()
        pdf.doc_id = "doc1"
        pdf.file_type = "pdf"

        tei = MagicMock()
        tei.doc_id = "doc1"
        tei.file_type = "tei"
        tei.label = None  # No label
        tei.stable_id = "abc123"
        tei.status = "draft"
        tei.updated_at = datetime(2024, 1, 15, 10, 0, 0)
        tei.variant = None

        self.file_repo.get_files_by_collection.return_value = [pdf, tei]

        result = calculate_collection_statistics(
            file_repo=self.file_repo,
            collection="test-collection",
            variant=None,
            lifecycle_order=self.lifecycle_order
        )

        self.assertEqual(result["doc_annotations"]["doc1"][0]["annotation_label"], "Untitled")

    def test_empty_lifecycle_order(self):
        """Test statistics with empty lifecycle order."""
        pdf = MagicMock()
        pdf.doc_id = "doc1"
        pdf.file_type = "pdf"

        tei = MagicMock()
        tei.doc_id = "doc1"
        tei.file_type = "tei"
        tei.label = "Test"
        tei.stable_id = "abc123"
        tei.status = "draft"
        tei.updated_at = datetime(2024, 1, 15, 10, 0, 0)
        tei.variant = None

        self.file_repo.get_files_by_collection.return_value = [pdf, tei]

        result = calculate_collection_statistics(
            file_repo=self.file_repo,
            collection="test-collection",
            variant=None,
            lifecycle_order=[]  # Empty lifecycle order
        )

        # With no lifecycle order, all documents should count as no-status
        self.assertEqual(result["stage_counts"]["no-status"], 1)
        self.assertEqual(result["avg_progress"], 0)


if __name__ == "__main__":
    unittest.main()
