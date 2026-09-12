"""
Unit tests for statistics module.

@testCovers fastapi_app/lib/services/statistics.py
"""

import unittest
from datetime import datetime
from unittest.mock import MagicMock

from fastapi_app.lib.services.statistics import (
    build_overview_rows,
    calculate_collection_statistics,
    get_collection_variants,
)


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

    def test_newer_regression_does_not_shadow_higher_status(self):
        """A newer annotation with a lower lifecycle status must not shadow
        an older one that already reached a higher stage - the document's
        status is the furthest stage reached by any of its versions, not
        whichever version was touched last."""
        pdf = MagicMock()
        pdf.doc_id = "doc1"
        pdf.file_type = "pdf"

        tei1 = MagicMock()
        tei1.doc_id = "doc1"
        tei1.file_type = "tei"
        tei1.label = "Annotation 1"
        tei1.stable_id = "abc123"
        tei1.status = "final"
        tei1.updated_at = datetime(2024, 1, 15, 10, 0, 0)  # Older, but further along
        tei1.variant = None

        tei2 = MagicMock()
        tei2.doc_id = "doc1"
        tei2.file_type = "tei"
        tei2.label = "Annotation 2"
        tei2.stable_id = "def456"
        tei2.status = "draft"
        tei2.updated_at = datetime(2024, 1, 16, 10, 0, 0)  # Newer, but a regression
        tei2.variant = None

        self.file_repo.get_files_by_collection.return_value = [pdf, tei1, tei2]

        result = calculate_collection_statistics(
            file_repo=self.file_repo,
            collection="test-collection",
            variant=None,
            lifecycle_order=self.lifecycle_order
        )

        # Should use "final" (the highest status reached), not "draft" (the newest)
        self.assertEqual(result["stage_counts"]["draft"], 0)
        self.assertEqual(result["stage_counts"]["review"], 0)
        self.assertEqual(result["stage_counts"]["final"], 1)
        self.assertAlmostEqual(result["avg_progress"], 100.0, places=2)

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

    def test_gold_count_for_variant(self):
        """gold_count counts distinct doc_ids with an is_gold_standard TEI file, scoped to the variant filter."""
        pdf = MagicMock()
        pdf.doc_id = "doc1"
        pdf.file_type = "pdf"

        gold = MagicMock()
        gold.doc_id = "doc1"
        gold.file_type = "tei"
        gold.label = "Gold"
        gold.stable_id = "gold1"
        gold.status = "final"
        gold.updated_at = datetime(2024, 1, 15, 10, 0, 0)
        gold.variant = "variant-a"
        gold.is_gold_standard = True

        pdf2 = MagicMock()
        pdf2.doc_id = "doc2"
        pdf2.file_type = "pdf"

        draft = MagicMock()
        draft.doc_id = "doc2"
        draft.file_type = "tei"
        draft.label = "Draft"
        draft.stable_id = "draft1"
        draft.status = "draft"
        draft.updated_at = datetime(2024, 1, 15, 10, 0, 0)
        draft.variant = "variant-a"
        draft.is_gold_standard = False

        self.file_repo.get_files_by_collection.return_value = [pdf, gold, pdf2, draft]

        result = calculate_collection_statistics(
            file_repo=self.file_repo,
            collection="test-collection",
            variant="variant-a",
            lifecycle_order=self.lifecycle_order,
        )

        self.assertEqual(result["gold_count"], 1)

    def test_none_variant_matches_untagged_only(self):
        """variant=None now means 'untagged only', not 'every variant' (that's variant='all')."""
        pdf = MagicMock()
        pdf.doc_id = "doc1"
        pdf.file_type = "pdf"

        tagged = MagicMock()
        tagged.doc_id = "doc1"
        tagged.file_type = "tei"
        tagged.label = "Tagged"
        tagged.stable_id = "tagged1"
        tagged.status = "draft"
        tagged.updated_at = datetime(2024, 1, 15, 10, 0, 0)
        tagged.variant = "grobid"
        tagged.is_gold_standard = False

        untagged = MagicMock()
        untagged.doc_id = "doc1"
        untagged.file_type = "tei"
        untagged.label = "Untagged"
        untagged.stable_id = "untagged1"
        untagged.status = "final"
        untagged.updated_at = datetime(2024, 1, 16, 10, 0, 0)
        untagged.variant = None
        untagged.is_gold_standard = False

        self.file_repo.get_files_by_collection.return_value = [pdf, tagged, untagged]

        result = calculate_collection_statistics(
            file_repo=self.file_repo,
            collection="test-collection",
            variant=None,
            lifecycle_order=self.lifecycle_order,
        )

        self.assertEqual(result["total_annotations"], 1)
        self.assertEqual(
            result["doc_annotations"]["doc1"][0]["annotation_label"], "Untagged"
        )

    def test_gold_count_excludes_doc_gold_in_other_variant(self):
        """gold_count must not include docs with gold status in an unqueried variant."""
        pdf = MagicMock()
        pdf.doc_id = "doc1"
        pdf.file_type = "pdf"

        gold_in_variant_a = MagicMock()
        gold_in_variant_a.doc_id = "doc1"
        gold_in_variant_a.file_type = "tei"
        gold_in_variant_a.label = "Gold A"
        gold_in_variant_a.stable_id = "gold_a1"
        gold_in_variant_a.status = "final"
        gold_in_variant_a.updated_at = datetime(2024, 1, 15, 10, 0, 0)
        gold_in_variant_a.variant = "variant-a"
        gold_in_variant_a.is_gold_standard = True

        non_gold_in_variant_b = MagicMock()
        non_gold_in_variant_b.doc_id = "doc1"
        non_gold_in_variant_b.file_type = "tei"
        non_gold_in_variant_b.label = "Non-Gold B"
        non_gold_in_variant_b.stable_id = "nongold_b1"
        non_gold_in_variant_b.status = "draft"
        non_gold_in_variant_b.updated_at = datetime(2024, 1, 15, 10, 0, 0)
        non_gold_in_variant_b.variant = "variant-b"
        non_gold_in_variant_b.is_gold_standard = False

        self.file_repo.get_files_by_collection.return_value = [
            pdf,
            gold_in_variant_a,
            non_gold_in_variant_b,
        ]

        # Query with variant-b; should not count doc1 as gold since its gold file is in variant-a
        result = calculate_collection_statistics(
            file_repo=self.file_repo,
            collection="test-collection",
            variant="variant-b",
            lifecycle_order=self.lifecycle_order,
        )

        self.assertEqual(result["gold_count"], 0)
        self.assertEqual(result["total_annotations"], 1)
        self.assertEqual(
            result["doc_annotations"]["doc1"][0]["annotation_label"], "Non-Gold B"
        )

    def test_legacy_encoded_doc_id_not_double_counted(self):
        """Legacy $XX$-encoded doc_ids normalize to match their modern equivalent, matching annotation_progress's own normalization."""
        pdf = MagicMock()
        pdf.doc_id = "10.1234$2F$example"  # legacy encoding of "10.1234/example"
        pdf.file_type = "pdf"

        tei = MagicMock()
        tei.doc_id = "10.1234_x2F_example"  # modern encoding of the same logical doc_id
        tei.file_type = "tei"
        tei.label = "Test"
        tei.stable_id = "abc123"
        tei.status = "draft"
        tei.updated_at = datetime(2024, 1, 15, 10, 0, 0)
        tei.variant = None
        tei.is_gold_standard = False

        self.file_repo.get_files_by_collection.return_value = [pdf, tei]

        result = calculate_collection_statistics(
            file_repo=self.file_repo,
            collection="test-collection",
            variant=None,
            lifecycle_order=self.lifecycle_order,
        )

        # Both files represent the same logical document - must count as 1, not 2
        self.assertEqual(result["total_docs"], 1)
        self.assertEqual(len(result["doc_annotations"]), 1)


class TestGetCollectionVariants(unittest.TestCase):
    """Test cases for get_collection_variants function."""

    def setUp(self):
        self.file_repo = MagicMock()

    def test_distinct_variants_sorted_with_none_first(self):
        pdf = MagicMock(file_type="pdf", variant=None)
        tei_a = MagicMock(file_type="tei", variant="llamore")
        tei_b = MagicMock(file_type="tei", variant="grobid")
        tei_c = MagicMock(file_type="tei", variant=None)
        self.file_repo.get_files_by_collection.return_value = [pdf, tei_a, tei_b, tei_c]

        result = get_collection_variants(self.file_repo, "coll-a")

        self.assertEqual(result, [None, "grobid", "llamore"])

    def test_empty_string_variant_normalized_to_none(self):
        tei = MagicMock(file_type="tei", variant="")
        self.file_repo.get_files_by_collection.return_value = [tei]

        result = get_collection_variants(self.file_repo, "coll-a")

        self.assertEqual(result, [None])

    def test_no_tei_files_returns_none_bucket(self):
        """A collection with only PDFs (no annotations yet) still produces one row."""
        pdf = MagicMock(file_type="pdf", variant=None)
        self.file_repo.get_files_by_collection.return_value = [pdf]

        result = get_collection_variants(self.file_repo, "coll-a")

        self.assertEqual(result, [None])

    def test_no_files_at_all_returns_none_bucket(self):
        self.file_repo.get_files_by_collection.return_value = []

        result = get_collection_variants(self.file_repo, "coll-a")

        self.assertEqual(result, [None])

    def test_multiple_files_same_variant_collapse_to_one_entry(self):
        """Multiple TEI files sharing the same variant collapse to a single entry."""
        tei1 = MagicMock(file_type="tei", variant="grobid", label="File 1")
        tei2 = MagicMock(file_type="tei", variant="grobid", label="File 2")
        tei3 = MagicMock(file_type="tei", variant="grobid", label="File 3")
        self.file_repo.get_files_by_collection.return_value = [tei1, tei2, tei3]

        result = get_collection_variants(self.file_repo, "coll-a")

        self.assertEqual(result, ["grobid"])


class TestBuildOverviewRows(unittest.TestCase):
    """Test cases for build_overview_rows function."""

    def setUp(self):
        self.file_repo = MagicMock()
        self.lifecycle_order = ["draft", "final"]

    def test_one_row_per_collection_variant(self):
        def files_for(collection_id, include_deleted=False):
            if collection_id == "coll-a":
                return [
                    MagicMock(doc_id="doc1", file_type="pdf", variant=None),
                    MagicMock(
                        doc_id="doc1", file_type="tei", variant="grobid",
                        label="A", stable_id="s1", status="draft",
                        updated_at=datetime(2024, 1, 1), is_gold_standard=False,
                    ),
                ]
            return []

        self.file_repo.get_files_by_collection.side_effect = files_for

        rows = build_overview_rows(
            self.file_repo,
            [{"id": "coll-a", "name": "Collection A"}],
            self.lifecycle_order,
        )

        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["collection_id"], "coll-a")
        self.assertEqual(rows[0]["collection_name"], "Collection A")
        self.assertEqual(rows[0]["variant"], "grobid")
        self.assertEqual(rows[0]["total_docs"], 1)

    def test_multiple_variants_produce_multiple_rows(self):
        def files_for(collection_id, include_deleted=False):
            return [
                MagicMock(doc_id="doc1", file_type="pdf", variant=None),
                MagicMock(
                    doc_id="doc1", file_type="tei", variant="grobid",
                    label="A", stable_id="s1", status="draft",
                    updated_at=datetime(2024, 1, 1), is_gold_standard=False,
                ),
                MagicMock(
                    doc_id="doc1", file_type="tei", variant="llamore",
                    label="B", stable_id="s2", status="final",
                    updated_at=datetime(2024, 1, 2), is_gold_standard=True,
                ),
            ]

        self.file_repo.get_files_by_collection.side_effect = files_for

        rows = build_overview_rows(
            self.file_repo,
            [{"id": "coll-a", "name": "Collection A"}],
            self.lifecycle_order,
        )

        variants = sorted(r["variant"] for r in rows)
        self.assertEqual(variants, ["grobid", "llamore"])

    def test_collection_with_no_tei_files_still_produces_one_row(self):
        self.file_repo.get_files_by_collection.return_value = []

        rows = build_overview_rows(
            self.file_repo,
            [{"id": "coll-empty", "name": "Empty Collection"}],
            self.lifecycle_order,
        )

        self.assertEqual(len(rows), 1)
        self.assertIsNone(rows[0]["variant"])
        self.assertEqual(rows[0]["total_docs"], 0)


if __name__ == "__main__":
    unittest.main()
