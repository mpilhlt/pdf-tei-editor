"""
Recent Documents Plugin.

Contributes a "Recently edited" box to the login dashboard: up to five documents per
project that the user saved most recently. Edits are recorded from the `document.saved`
event in a plugin-owned store (see `edit_store.py`).
"""

import logging
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

from fastapi_app.lib.plugins.frontend_extension_registry import FrontendExtensionRegistry
from fastapi_app.lib.plugins.plugin_base import Plugin, PluginContext
from fastapi_app.lib.sse.event_bus import get_event_bus

logger = logging.getLogger(__name__)


class RecentDocumentsPlugin(Plugin):
    """Plugin listing the documents a user edited last on the dashboard."""

    @property
    def metadata(self) -> dict[str, Any]:
        return {
            "id": "recent-documents",
            "name": "Recent Documents",
            "description": "Dashboard box with the documents you edited last, per project",
            "category": "document",
            "version": "1.0.0",
            "required_roles": ["user"],
            "dependencies": ["dashboard"],
            "endpoints": [],
        }

    def get_endpoints(self) -> dict[str, Callable]:
        return {}

    async def initialize(self, context: PluginContext) -> None:
        """Register the frontend extension, subscribe to saves and seed the edit store once."""
        fe_registry = FrontendExtensionRegistry.get_instance()
        extension_file = Path(__file__).parent / "extensions" / "recent-documents.js"
        if extension_file.exists():
            fe_registry.register_extension(extension_file, self.metadata["id"])

        get_event_bus().on("document.saved", self._on_document_saved)

        try:
            self._seed_from_file_creators()
        except Exception as e:
            logger.warning(f"Could not seed recent document edits: {e}")

    async def cleanup(self) -> None:
        """Unsubscribe from save events."""
        get_event_bus().off("document.saved", self._on_document_saved)

    async def _on_document_saved(self, stable_id: str, doc_id: str, username: str | None, **kwargs: Any) -> None:
        """Record the save in the user's edit history."""
        if not username or not stable_id:
            return
        from fastapi_app.config import get_settings
        from fastapi_app.plugins.recent_documents.edit_store import record_edit

        record_edit(username, stable_id, get_settings().plugins_data_dir)

    def _seed_from_file_creators(self) -> None:
        """On first start, treat each TEI file's creator as its last editor."""
        from fastapi_app.config import get_settings
        from fastapi_app.lib.core.dependencies import get_db
        from fastapi_app.lib.repository.file_repository import FileRepository
        from fastapi_app.plugins.recent_documents.edit_store import is_seeded, seed_edits

        plugins_data_dir = get_settings().plugins_data_dir
        if is_seeded(plugins_data_dir):
            return

        entries: dict[str, dict[str, str]] = {}
        for file in FileRepository(get_db()).list_files(file_type="tei"):
            if not file.created_by:
                continue
            edited_at = file.updated_at
            if edited_at.tzinfo is None:
                edited_at = edited_at.replace(tzinfo=timezone.utc)
            entries.setdefault(file.created_by, {})[file.stable_id] = edited_at.isoformat()

        if seed_edits(entries, plugins_data_dir):
            logger.info(f"Seeded recent document edits for {len(entries)} user(s)")
