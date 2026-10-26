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
import re
from dataclasses import dataclass
from typing import Literal, Optional

from fastapi_app.lib.utils.annotation_rules_utils import derelativize_markdown_urls

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
