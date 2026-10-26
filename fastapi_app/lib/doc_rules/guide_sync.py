"""
Sync status between a human guideline section and its condensed machine
section.

The machine section carries a marker comment

    <!-- sync: guide=<sha256> llm=<sha256> -->

(optionally with ` base=<sha256>`) holding the hashes of the human and machine
sections when they were last brought in sync. The hashing is the algorithm of
fossil's `scripts/check-llm-digest.py`, so markers written there stay valid.
"""

import hashlib
import logging
import re
import time
from dataclasses import dataclass
from typing import Literal, Optional

import requests

from fastapi_app.lib.core.git_forge_adapters import GitForgeAdapterRegistry
from fastapi_app.lib.core.url_cache import UrlCache
from fastapi_app.lib.utils.annotation_rules_utils import (
    derelativize_markdown_urls,
    fetch_rule_excerpt,
    markdown_section_range,
)

logger = logging.getLogger(__name__)

SyncStatus = Literal["in_sync", "machine_outdated", "machine_edited", "both_changed", "no_marker"]

_SYNC_RE = re.compile(r"<!-- sync: guide=([0-9a-f]+) llm=([0-9a-f]+)(?: base=([0-9a-f]+))? -->\n?")


@dataclass(frozen=True)
class SyncMarker:
    """Hashes recorded when the machine section was last synced with the human section."""
    guide_hash: str
    llm_hash: str
    base: Optional[str]


def parse_sync_marker(machine_section: str) -> Optional[SyncMarker]:
    """Return the sync marker found in `machine_section`, or None if absent or malformed."""
    match = _SYNC_RE.search(machine_section)
    if match is None:
        return None
    return SyncMarker(match.group(1), match.group(2), match.group(3))


def format_sync_marker(marker: SyncMarker) -> str:
    """Render `marker` as its comment line, without a trailing newline."""
    base = f" base={marker.base}" if marker.base is not None else ""
    return f"<!-- sync: guide={marker.guide_hash} llm={marker.llm_hash}{base} -->"


def section_hash(text: str) -> str:
    """Hash of a section without its sync comment, ignoring trailing whitespace and blank lines."""
    text = _SYNC_RE.sub("", text)
    normalized = "\n".join(line.rstrip() for line in text.splitlines() if line.strip())
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest()


def human_section_hash(section: str, human_url: str) -> str:
    """Hash of a human section as core serves it, i.e. with relative links made absolute against `human_url`."""
    return section_hash(derelativize_markdown_urls(section, human_url))


def sync_status(human_section: str, machine_section: str, human_url: str) -> SyncStatus:
    """Compare the current hashes of both sections with the ones recorded in the machine section's marker."""
    marker = parse_sync_marker(machine_section)
    if marker is None:
        return "no_marker"
    outdated = human_section_hash(human_section, human_url) != marker.guide_hash
    edited = section_hash(machine_section) != marker.llm_hash
    if outdated and edited:
        return "both_changed"
    if outdated:
        return "machine_outdated"
    if edited:
        return "machine_edited"
    return "in_sync"


def find_synced_human_commit(
    human_url: str, marker: SyncMarker, cache: UrlCache, limit: int = 20, *, deadline_seconds: float = 20.0
) -> Optional[str]:
    """
    Find the commit of the guide file whose section hashes to `marker.guide_hash`.

    `human_url` is a heading-anchor blob URL. At most `limit` commits are
    checked, newest first, stopping after `marker.base` if that commit is
    reached, or before the next fetch once `deadline_seconds` have passed.
    Returns None if nothing matches, the anchor is absent, no forge adapter
    handles the URL, the deadline passes, or a listing or fetch fails (logged
    as a warning).
    """
    base_url, _, anchor = human_url.partition("#")
    adapter = GitForgeAdapterRegistry.get_instance().get_adapter_for(base_url)
    if adapter is None or not anchor:
        return None
    started = time.monotonic()
    try:
        for sha in adapter.list_file_commits(base_url, cache, limit):
            if time.monotonic() - started > deadline_seconds:
                logger.info(f"Gave up finding the synced commit for {human_url} after {deadline_seconds}s")
                return None
            commit_url = adapter.url_at_commit(base_url, sha)
            lines = fetch_rule_excerpt(commit_url, cache).splitlines()
            range_ = markdown_section_range("\n".join(lines), anchor)
            if range_ is not None:
                section = "\n".join(lines[range_[0] - 1:range_[1]])
                if human_section_hash(section, commit_url) == marker.guide_hash:
                    return sha
            if sha == marker.base:
                return None
    except requests.HTTPError as e:
        logger.warning(f"Could not find the synced commit for {human_url}: {e}")
    except Exception as e:
        logger.warning(f"Could not find the synced commit for {human_url}: {e}", exc_info=True)
    return None
