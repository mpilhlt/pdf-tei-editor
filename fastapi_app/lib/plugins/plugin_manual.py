"""
Pages that plugins contribute to the user manual.

A plugin declares its pages in the ``manual`` list of its manifest (``pte-plugin.json``, see
:class:`~fastapi_app.lib.plugins.plugin_manifest.ManualPage`). Core manual pages contain slots,
HTML comments such as ``<!-- plugin-docs: tutorials -->``, which the manual drawer replaces with
links to the pages contributed to that slot (``app/src/plugins/info.js``). The slot names are fixed
here (:data:`MANUAL_SLOTS`); contributions to other slots are ignored.

A page is listed when its plugin and the plugins in its ``requires`` are active and the user has one
of its ``roles``. Administrators also see the pages of plugins that are not active, marked as such.
The files are served without authentication, like the core manual in ``docs/``, from the
directories that contain the declared Markdown files.
"""

import logging
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any

from fastapi_app.lib.plugins.plugin_manifest import ManualPage, is_safe_relative_path
from fastapi_app.lib.plugins.plugin_registry import PluginRecord, PluginRegistry

logger = logging.getLogger(__name__)

MANUAL_SLOTS: dict[str, str] = {
    "tutorials": "Step-by-step tutorials (index.md, user-manual/plugins.md)",
    "extraction": "Extractors and their options (user-manual/extraction-workflow.md)",
    "review": "Review aids (user-manual/review-workflow.md)",
    "inference": "Language models and their providers (user-manual/language-models.md)",
    "admin": "Configuration of plugins (user-manual/admin-guide.md)",
}
"""The slots of the core manual pages: name -> what belongs there (and where the slot is)."""

MANUAL_FILE_TYPES: dict[str, str] = {
    ".md": "text/markdown; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
}
"""File types served from the documentation directories of plugins. SVG is excluded since it can contain scripts."""

_warned_slots: set[tuple[str, str]] = set()


@dataclass(frozen=True)
class ManualContribution:
    """A page listed in a manual slot."""

    plugin_id: str
    plugin_name: str
    plugin_version: str
    page: ManualPage
    active: bool


def _user_has_role(user_roles: list[str], page_roles: tuple[str, ...]) -> bool:
    """Whether a user with ``user_roles`` may see a page restricted to ``page_roles``."""
    if not page_roles or "*" in page_roles:
        return True
    return "*" in user_roles or "admin" in user_roles or any(role in user_roles for role in page_roles)


def _plugin_version(record: PluginRecord) -> str:
    """Version of a plugin: the manifest's, else the metadata's."""
    if record.manifest and record.manifest.version:
        return record.manifest.version
    return str(record.metadata.get("version", ""))


def list_contributions(registry: PluginRegistry, user: dict[str, Any] | None) -> list[ManualContribution]:
    """
    The manual pages the user can see, sorted by slot, order and title.

    Args:
        registry: Plugin registry
        user: The current user, or None if not logged in

    Returns:
        Pages of active plugins whose required plugins are active and whose roles match the user; for
        administrators also the pages of installed plugins that are not active (``active=False``)
    """
    roles: list[str] = list(user.get("roles", [])) if user else []
    is_admin = "admin" in roles or "*" in roles
    result: list[ManualContribution] = []
    for record in registry.get_records():
        if record.manifest is None or not record.manifest.manual or record.directory is None:
            continue
        status, _reason = registry.status(record.id)
        if status in ("failed", "incompatible"):
            continue
        for page in record.manifest.manual:
            if page.slot not in MANUAL_SLOTS:
                if (record.id, page.slot) not in _warned_slots:
                    _warned_slots.add((record.id, page.slot))
                    logger.warning(f"Plugin {record.id}: manual page '{page.id}' names the unknown slot '{page.slot}' and is not listed")
                continue
            if not _user_has_role(roles, page.roles):
                continue
            active = registry.is_active(record.id) and all(registry.is_active(dep) for dep in page.requires)
            if not active and not is_admin:
                continue
            result.append(ManualContribution(
                plugin_id=record.id,
                plugin_name=str(record.metadata.get("name", record.id)),
                plugin_version=_plugin_version(record),
                page=page,
                active=active,
            ))
    slot_order = list(MANUAL_SLOTS)
    result.sort(key=lambda c: (slot_order.index(c.page.slot), c.page.order, c.page.title.lower(), c.plugin_id))
    return result


class ManualFileNotFound(LookupError):
    """The requested file is not a documentation file of the plugin."""


def resolve_manual_file(registry: PluginRegistry, plugin_id: str, path: str) -> tuple[Path, str]:
    """
    The file of a plugin's documentation that ``path`` names.

    Only files of the types in :data:`MANUAL_FILE_TYPES` are served, and only from the directories
    that contain the Markdown files declared in the plugin's manifest (and their subdirectories).

    Args:
        registry: Plugin registry
        plugin_id: Id of the plugin
        path: Path relative to the plugin directory, e.g. ``docs/images/menu.png``

    Returns:
        (absolute file path, media type)

    Raises:
        ManualFileNotFound: If the plugin has no such documentation file
    """
    record = registry.get_record(plugin_id)
    if record is None or record.directory is None or record.manifest is None or not record.manifest.manual:
        raise ManualFileNotFound(plugin_id)
    if not is_safe_relative_path(path):
        raise ManualFileNotFound(path)
    media_type = MANUAL_FILE_TYPES.get(PurePosixPath(path).suffix.lower())
    if media_type is None:
        raise ManualFileNotFound(path)
    plugin_dir = record.directory.resolve()
    target = (plugin_dir / path).resolve()
    allowed_dirs = {
        (plugin_dir / file).resolve().parent
        for page in record.manifest.manual
        for file in page.files.values()
    }
    if not any(target.is_relative_to(directory) for directory in allowed_dirs) or not target.is_relative_to(plugin_dir):
        raise ManualFileNotFound(path)
    if not target.is_file():
        raise ManualFileNotFound(path)
    return target, media_type
