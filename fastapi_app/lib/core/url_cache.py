"""
Generic, directory-backed, TTL-based cache for content fetched from a URL.

Extracted from schema_validator.py so the same caching behavior can be
reused by the git-forge adapters (git_forge_adapters.py) and the
annotation-rules fetcher (annotation_rules_utils.py). See
docs/superpowers/specs/2026-09-22-editorial-decl-annotation-rules-design.md
(Part E) for the rationale.
"""

import os
import re
import time
from pathlib import Path
from typing import Optional, Tuple

DEFAULT_CACHE_TTL_SECONDS = 3600


def get_cache_info(url: str, cache_root: Path) -> Tuple[Path, Path, str]:
    """
    Derive the cache directory, cache file path, and file name for a URL.

    Mirrors a URL's path structure under cache_root so different URLs never
    collide, with filesystem-unsafe characters replaced.

    Args:
        url: The URL whose fetched content will be cached
        cache_root: Root directory for this cache

    Returns:
        Tuple of (cache_dir, cache_file, file_name)
    """
    url_parts = url.split("/")[2:-1]
    url_parts = [re.sub(r'[<>:"|?*]', '_', part) for part in url_parts]
    cache_dir = cache_root / Path(*url_parts)
    file_name = re.sub(r'[<>:"|?*]', '_', os.path.basename(url))
    cache_file = cache_dir / file_name
    return cache_dir, cache_file, file_name


def is_cache_stale(cache_file: Path, ttl_seconds: int = DEFAULT_CACHE_TTL_SECONDS) -> bool:
    """
    Check whether a cached file needs to be re-fetched.

    A cache entry is stale if it doesn't exist yet, or if it was last
    written longer than ttl_seconds ago.

    Args:
        cache_file: Path to the cached file
        ttl_seconds: Maximum age in seconds before the cache is considered stale

    Returns:
        True if the file is missing or older than the TTL
    """
    if not cache_file.is_file():
        return True
    age_seconds = time.time() - cache_file.stat().st_mtime
    return age_seconds > ttl_seconds


class UrlCache:
    """A directory-backed, TTL-based text cache for fetched URL content."""

    def __init__(self, cache_root: Path, ttl_seconds: int = DEFAULT_CACHE_TTL_SECONDS):
        self.cache_root = cache_root
        self.ttl_seconds = ttl_seconds

    def get_text(self, url: str) -> Optional[str]:
        """Return cached text for `url` if a fresh cache entry exists, else None."""
        _, cache_file, _ = get_cache_info(url, self.cache_root)
        if is_cache_stale(cache_file, self.ttl_seconds):
            return None
        return cache_file.read_text(encoding="utf-8")

    def set_text(self, url: str, content: str) -> None:
        """Write `content` to the cache entry for `url`, creating directories as needed."""
        cache_dir, cache_file, _ = get_cache_info(url, self.cache_root)
        cache_dir.mkdir(parents=True, exist_ok=True)
        cache_file.write_text(content, encoding="utf-8")
