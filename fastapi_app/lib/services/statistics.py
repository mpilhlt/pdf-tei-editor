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
        variant: Optional variant filter (if None or "all", includes all variants)
        lifecycle_order: Ordered list of lifecycle stages for progress calculation

    Returns:
        Dictionary with statistics:
        - total_docs: Total number of documents
        - total_annotations: Total number of TEI annotations
        - avg_progress: Average lifecycle progress percentage (0-100)
        - stage_counts: Dict mapping lifecycle stages to document counts
        - doc_annotations: Dict mapping doc_id to list of annotation info
    """
    lifecycle_order = lifecycle_order or []

    # Get all files in the collection
    all_files = file_repo.get_files_by_collection(collection)

    # Get all unique doc_ids from the collection
    all_doc_ids = set()
    for f in all_files:
        if f.doc_id:
            all_doc_ids.add(f.doc_id)

    # Filter to TEI files only
    tei_files = [f for f in all_files if f.file_type == "tei"]

    # Filter by variant if specified
    if variant and variant not in ("all", ""):
        tei_files = [
            f for f in tei_files if getattr(f, "variant", None) == variant
        ]

    # Group annotations by doc_id
    doc_annotations = defaultdict(list)
    for file_metadata in tei_files:
        annotation_info = {
            "annotation_label": file_metadata.label or "Untitled",
            "stable_id": file_metadata.stable_id,
            "status": file_metadata.status or "",
            "updated_at": file_metadata.updated_at,
        }
        doc_id = file_metadata.doc_id or "Unknown"
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

    return {
        "total_docs": total_docs,
        "total_annotations": total_annotations,
        "avg_progress": avg_progress,
        "stage_counts": stage_counts,
        "doc_annotations": doc_annotations,
    }
