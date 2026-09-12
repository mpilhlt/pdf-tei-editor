"""
Collection statistics utilities.

Provides functions for calculating annotation progress and lifecycle statistics
based on file metadata.
"""

import logging
from collections import defaultdict
from typing import Optional

from fastapi_app.lib.repository.file_repository import FileRepository

logger = logging.getLogger(__name__)


def calculate_collection_statistics(
    file_repo: FileRepository,
    collection: str,
    variant: Optional[str] = None,
    lifecycle_order: Optional[list[str]] = None
) -> dict:
    """
    Calculate collection-level annotation statistics.

    Args:
        file_repo: FileRepository instance for database access
        collection: Collection ID to analyze
        variant: Optional variant filter. "all" includes all variants; specific string filters to that variant; None/"" means untagged only.
        lifecycle_order: Ordered list of lifecycle stages for progress calculation

    Returns:
        Dictionary with statistics:
        - total_docs: Total number of documents
        - total_annotations: Total number of TEI annotations
        - avg_progress: Average lifecycle progress percentage (0-100)
        - stage_counts: Dict mapping lifecycle stages to document counts
        - doc_annotations: Dict mapping doc_id to list of annotation info
        - gold_count: Number of distinct documents with is_gold_standard annotations
    """
    lifecycle_order = lifecycle_order or []

    # Get all files in the collection
    all_files = file_repo.get_files_by_collection(collection)

    # Get all unique doc_ids from the collection. Normalize legacy $XX$
    # encoding so files with the same logical doc_id are not counted as
    # separate documents - matches annotation_progress/routes.py's own
    # normalization, which this function's numbers are compared against via
    # the "Open progress" deep link in the collection-overview plugin.
    from fastapi_app.lib.utils.doi_utils import normalize_legacy_encoding

    all_doc_ids = set()
    for f in all_files:
        if f.doc_id:
            all_doc_ids.add(normalize_legacy_encoding(f.doc_id))

    # Filter to TEI files only
    tei_files = [f for f in all_files if f.file_type == "tei"]

    # Filter by variant. "all" means no filter (every variant, tagged or not) -
    # kept exactly as before. None/"" now means "untagged only" (previously
    # grouped with "all" - see docs/superpowers/specs/2026-09-11-collection-coverage-overview-design.md).
    if variant == "all":
        pass
    elif variant:
        tei_files = [
            f for f in tei_files if getattr(f, "variant", None) == variant
        ]
    else:
        tei_files = [f for f in tei_files if not getattr(f, "variant", None)]

    # Group annotations by doc_id
    doc_annotations = defaultdict(list)
    for file_metadata in tei_files:
        annotation_info = {
            "annotation_label": file_metadata.label or "Untitled",
            "stable_id": file_metadata.stable_id,
            "status": file_metadata.status or "",
            "updated_at": file_metadata.updated_at,
            "is_gold_standard": file_metadata.is_gold_standard,
        }
        doc_id = normalize_legacy_encoding(file_metadata.doc_id or "Unknown")
        doc_annotations[doc_id].append(annotation_info)

    # Calculate statistics
    total_docs = len(all_doc_ids)
    total_annotations = sum(len(anns) for anns in doc_annotations.values())

    # Count documents by lifecycle stage and calculate progress
    stage_counts = {stage: 0 for stage in lifecycle_order}
    stage_counts["no-status"] = 0
    total_progress_sum = 0

    for doc_id in all_doc_ids:
        annotations = doc_annotations[doc_id]
        if not annotations:
            stage_counts["no-status"] += 1
            continue

        # Find the most recent status across all annotations for this document
        newest_timestamp = None
        newest_status = ""
        for ann in annotations:
            ann_timestamp = ann.get("updated_at")
            if ann_timestamp and (newest_timestamp is None or ann_timestamp > newest_timestamp):
                newest_timestamp = ann_timestamp
                newest_status = ann.get("status", "")

        if newest_status in stage_counts:
            stage_counts[newest_status] += 1
        else:
            stage_counts["no-status"] += 1

        # Calculate progress for this document (0-100%)
        if newest_status and newest_status in lifecycle_order:
            current_index = lifecycle_order.index(newest_status)
            doc_progress = ((current_index + 1) / len(lifecycle_order)) * 100
            total_progress_sum += doc_progress

    # Calculate average progress across all documents
    avg_progress = (total_progress_sum / total_docs) if total_docs > 0 else 0

    gold_doc_ids = {
        doc_id
        for doc_id, anns in doc_annotations.items()
        if any(a["is_gold_standard"] for a in anns)
    }

    return {
        "total_docs": total_docs,
        "total_annotations": total_annotations,
        "avg_progress": avg_progress,
        "stage_counts": stage_counts,
        "doc_annotations": doc_annotations,
        "gold_count": len(gold_doc_ids),
    }


def get_collection_variants(file_repo: FileRepository, collection_id: str) -> list[Optional[str]]:
    """
    Distinct variant values among a collection's TEI files, untagged (None) first.

    Args:
        file_repo: FileRepository instance for database access
        collection_id: Collection ID to inspect

    Returns:
        Sorted list of variant values (None represents "no variant tag").
        Always contains at least [None], even if the collection has no TEI
        files yet, so every collection produces at least one overview row.
    """
    files = file_repo.get_files_by_collection(collection_id)
    variants = {f.variant for f in files if f.file_type == "tei"}
    normalized = {v if v else None for v in variants}
    ordered = sorted(normalized, key=lambda v: (v is not None, v or ""))
    return ordered or [None]


def build_overview_rows(
    file_repo: FileRepository,
    collections: list[dict],
    lifecycle_order: list[str],
) -> list[dict]:
    """
    Build one overview row per (collection, variant) combination.

    Args:
        file_repo: FileRepository instance for database access
        collections: List of {"id": ..., "name": ...} dicts, already filtered
            to what the current user can access (e.g. by the caller combining
            fastapi_app.lib.utils.collection_utils.list_collections with
            fastapi_app.lib.permissions.user_utils.get_user_collections)
        lifecycle_order: Ordered list of lifecycle stages for progress calculation

    Returns:
        List of row dicts: collection_id, collection_name, variant, plus every
        field from calculate_collection_statistics (total_docs,
        total_annotations, avg_progress, stage_counts, doc_annotations,
        gold_count).
    """
    rows = []
    for collection in collections:
        collection_id = collection["id"]
        collection_name = collection.get("name") or collection_id
        for variant in get_collection_variants(file_repo, collection_id):
            stats = calculate_collection_statistics(
                file_repo, collection_id, variant, lifecycle_order
            )
            rows.append({
                "collection_id": collection_id,
                "collection_name": collection_name,
                "variant": variant,
                **stats,
            })
    return rows
