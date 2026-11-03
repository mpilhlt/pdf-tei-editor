"""
Moves interpretation-ref overrides stored under a pre-#666 line-range key
(`file.md#L28-L53`) to the file + heading-anchor key that
InterpretationRefKind.resource_key() derives now (`file.md#citation-model`).

Row-driven: each row is resolved against its own stored, possibly
SHA-pinned `base_url`, since legacy keys are SHA-stripped and the same key
may stand for different headings in different pinned files. Runs once per
process start in a background thread (see main.py's lifespan); rows whose
file cannot be fetched are retried on the next start, rows whose start line
is no heading keep their line-range key, which resource_key() still returns
for them.
"""

import logging
import threading
from typing import Callable

from fastapi_app.lib.doc_rules.interpretation_ref_kind import InterpretationRefKind, legacy_resource_key
from fastapi_app.lib.doc_rules.storage import DocumentRulesStore
from fastapi_app.lib.utils.annotation_rules_utils import RuleFetchError, is_line_range_fragment

logger = logging.getLogger(__name__)


def _is_line_range_key(key: str) -> bool:
    _, _, fragment = key.partition("#")
    return bool(fragment) and is_line_range_fragment(fragment)


def migrate_legacy_override_keys(store: DocumentRulesStore) -> int:
    """
    Move every interpretation-ref override under a line-range key whose
    start line is a Markdown heading to that heading's key (see
    DocumentRulesStore.rekey_override() for how selections follow).
    Idempotent. Returns the number of overrides moved.
    """
    kind = InterpretationRefKind()
    moved = 0
    for row in store.list_overrides_of_kind(kind.name):
        old_key = row["resource_key"]
        if not _is_line_range_key(old_key):
            continue
        base_url = row["base_url"]
        if legacy_resource_key(base_url) != old_key:
            # Not the URL the key was derived from, so it cannot tell which heading is meant
            continue
        try:
            new_key = kind.resource_key(base_url, strict=True)
        except RuleFetchError as e:
            logger.warning(f"Could not move override {row['id']} from its line-range key {old_key}, retrying on the next start: {e}")
            continue
        if _is_line_range_key(new_key):
            continue
        if store.rekey_override(row["id"], new_key):
            logger.info(f"Moved override {row['id']} of {row['owner']} from {old_key} to {new_key}")
            moved += 1
    return moved


def start_legacy_override_key_migration(get_store: Callable[[], DocumentRulesStore]) -> threading.Thread:
    """Run migrate_legacy_override_keys() in a daemon thread; exceptions are logged, never raised."""

    def run() -> None:
        try:
            moved = migrate_legacy_override_keys(get_store())
            if moved:
                logger.info(f"Moved {moved} document rules override(s) from line-range to heading-anchor keys")
        except Exception as e:
            logger.error(f"Could not migrate legacy document rules override keys: {e}", exc_info=True)

    thread = threading.Thread(target=run, name="legacy-override-key-migration", daemon=True)
    thread.start()
    return thread
