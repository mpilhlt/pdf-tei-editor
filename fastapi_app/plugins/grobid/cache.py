"""Cache utilities for GROBID training data."""

import json
import os
import tempfile
import zipfile
from datetime import datetime
from pathlib import Path


def get_cache_dir() -> Path:
    """Get the cache directory for GROBID extractions."""
    from fastapi_app.config import get_settings
    settings = get_settings()
    return settings.plugins_data_dir / "grobid" / "extractions"


def _safe_doc_id(doc_id: str) -> str:
    """Return a filesystem-safe version of doc_id (replace path separators)."""
    return doc_id.replace("/", "_").replace("\\", "_")


def _safe_flavor(flavor: str) -> str:
    """Return a filesystem-safe version of flavor (replace path separators)."""
    return flavor.replace("/", "-").replace("\\", "-")


def get_cache_key(doc_id: str, revision: str, flavor: str) -> str:
    """
    Build the cache key for a (doc_id, revision, flavor) combination.

    The flavor is part of the key because different flavors make GROBID emit
    different feature columns; reusing a cache entry across flavors would
    silently serve a feature file missing the other flavor's columns (#480).
    """
    safe_id = _safe_doc_id(doc_id)
    safe_flavor = _safe_flavor(flavor)
    key = f"{safe_id}_{revision}" if revision != "unknown" else safe_id
    return key if safe_flavor == "default" else f"{key}_{safe_flavor}"


def check_cache(doc_id: str, revision: str, flavor: str = "default", force_refresh: bool = False) -> dict | None:
    """
    Check if cached training data exists for doc_id, revision and flavor.

    Args:
        doc_id: Document ID
        revision: GROBID revision string
        flavor: GROBID processing flavor used for the extraction
        force_refresh: If True, ignore cache

    Returns:
        Dict with temp_dir and files if cache hit, None otherwise
    """
    if force_refresh:
        return None

    cache_dir = get_cache_dir()
    cache_key = get_cache_key(doc_id, revision, flavor)
    cache_path = cache_dir / cache_key

    zip_path = cache_path / "training.zip"
    if not zip_path.exists():
        return None

    # Extract to temp location
    temp_dir = tempfile.mkdtemp(prefix=f"grobid_cache_{_safe_doc_id(doc_id)}_")
    with zipfile.ZipFile(zip_path, "r") as zf:
        zf.extractall(temp_dir)

    files = [f for f in os.listdir(temp_dir) if f != "training.zip"]
    return {"temp_dir": temp_dir, "files": files}


def cache_training_data(doc_id: str, revision: str, flavor: str, temp_dir: str, files: list[str]) -> None:
    """
    Cache training data for a document.

    Args:
        doc_id: Document ID
        revision: GROBID revision string
        flavor: GROBID processing flavor used for the extraction
        temp_dir: Temp directory with training files
        files: List of files in temp_dir
    """
    cache_dir = get_cache_dir()
    cache_key = get_cache_key(doc_id, revision, flavor)
    cache_path = cache_dir / cache_key
    cache_path.mkdir(parents=True, exist_ok=True)

    # Create ZIP
    zip_path = cache_path / "training.zip"
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
        for filename in files:
            src_path = os.path.join(temp_dir, filename)
            if os.path.exists(src_path):
                zf.write(src_path, filename)

    # Save metadata
    metadata = {
        "doc_id": doc_id,
        "grobid_revision": revision,
        "flavor": flavor,
        "files": files,
        "cached_at": datetime.now().isoformat()
    }
    with open(cache_path / "metadata.json", "w") as f:
        json.dump(metadata, f, indent=2)


def delete_cache_for_doc(doc_id: str) -> bool:
    """
    Delete all cached training data for a document (all revisions).

    Args:
        doc_id: Document ID

    Returns:
        True if any cache entries were deleted, False otherwise
    """
    import shutil

    cache_dir = get_cache_dir()
    safe_id = _safe_doc_id(doc_id)
    deleted = False

    # Find all cache entries for this doc_id (any revision)
    # Pattern: {safe_id} or {safe_id}_{revision}
    for cache_path in cache_dir.glob(f"{safe_id}*"):
        if cache_path.is_dir():
            # Verify it's actually for this doc_id (not a prefix match of another doc)
            folder_name = cache_path.name
            if folder_name == safe_id or folder_name.startswith(f"{safe_id}_"):
                shutil.rmtree(cache_path, ignore_errors=True)
                deleted = True

    return deleted
