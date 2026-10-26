"""
Generic, directory-backed, TTL-based cache for content fetched from a URL.

Extracted from schema_validator.py so the same caching behavior can be
reused by the git-forge adapters (git_forge_adapters.py) and the
annotation-rules fetcher (annotation_rules_utils.py). See
docs/superpowers/specs/2026-09-22-editorial-decl-annotation-rules-design.md
(Part E) for the rationale.
"""

import logging
import os
import re
import time
from pathlib import Path
from typing import Optional, Tuple

DEFAULT_CACHE_TTL_SECONDS = 3600

logger = logging.getLogger(__name__)


class UncacheableUrlError(ValueError):
    """Raised by get_cache_info() for a URL whose cache path would fall outside the cache root (e.g. via `..` segments)."""


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

    Raises:
        UncacheableUrlError: If the cache file would not lie strictly inside cache_root
    """
    url_parts = url.split("/")[2:-1]
    url_parts = [re.sub(r'[<>:"|?*]', '_', part) for part in url_parts]
    cache_dir = cache_root / Path(*url_parts)
    file_name = re.sub(r'[<>:"|?*]', '_', os.path.basename(url))
    cache_file = cache_dir / file_name
    root = cache_root.resolve()
    resolved = cache_file.resolve()
    if resolved == root or not resolved.is_relative_to(root):
        raise UncacheableUrlError(f"Cache path for {url} lies outside {cache_root}")
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

    def get_text(self, url: str, ignore_ttl: bool = False) -> Optional[str]:
        """
        Return cached text for `url`, or None if there is no cache entry or
        the URL is uncacheable (see get_cache_info()).

        Normally an entry older than `ttl_seconds` is treated as missing
        (the default, staleness-checked behavior every existing caller
        keeps). Pass `ignore_ttl=True` for a URL whose content is known to
        be immutable (a commit-SHA-pinned git-forge URL - see
        git_forge_adapters.py's `is_sha_pinned()`) to return any existing
        entry regardless of age, so pinned content stays resolvable
        offline/in development long after the normal TTL would have
        expired it.
        """
        try:
            _, cache_file, _ = get_cache_info(url, self.cache_root)
        except UncacheableUrlError as e:
            logger.warning(f"Not reading from cache: {e}")
            return None
        if not cache_file.is_file():
            return None
        if not ignore_ttl and is_cache_stale(cache_file, self.ttl_seconds):
            return None
        return cache_file.read_text(encoding="utf-8")

    def set_text(self, url: str, content: str) -> None:
        """Write `content` to the cache entry for `url`, creating directories as needed. A no-op for an uncacheable URL."""
        try:
            cache_dir, cache_file, _ = get_cache_info(url, self.cache_root)
        except UncacheableUrlError as e:
            logger.warning(f"Not writing to cache: {e}")
            return
        cache_dir.mkdir(parents=True, exist_ok=True)
        cache_file.write_text(content, encoding="utf-8")
