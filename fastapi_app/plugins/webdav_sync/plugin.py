"""
WebDAV Sync backend plugin.

Provides WebDAV-based file synchronization as a backend plugin.
"""

import threading
from pathlib import Path
from typing import Any

from fastapi_app.lib.plugins.plugin_base import Plugin, PluginContext
from fastapi_app.lib.plugins.plugin_tools import get_plugin_config
from fastapi_app.lib.sse.event_bus import get_event_bus
from fastapi_app.lib.utils.logging_utils import get_logger

from .config import init_plugin_config, get_webdav_config, is_configured

logger = get_logger(__name__)


class WebDavSyncPlugin(Plugin):
    """WebDAV synchronization plugin."""

    def __init__(self):
        super().__init__()
        init_plugin_config()

    @property
    def metadata(self) -> dict[str, Any]:
        return {
            "id": "webdav-sync",
            "name": "WebDAV Sync",
            "description": "Synchronize files with a WebDAV server",
            "category": "sync",
            "version": "1.0.0",
            "required_roles": ["user"],
            "endpoints": [
                {
                    "name": "execute",
                    "label": "Sync Now",
                    "description": "Synchronize files with the WebDAV server",
                    "state_params": []
                }
            ]
        }

    @classmethod
    def is_available(cls) -> bool:
        """Only available if WebDAV sync is enabled and configured."""
        return is_configured()

    def get_endpoints(self) -> dict[str, Any]:
        return {
            "execute": self.execute_sync,
        }

    async def initialize(self, context: PluginContext) -> None:
        """Register frontend extension."""
        from fastapi_app.lib.plugins.frontend_extension_registry import FrontendExtensionRegistry
        registry = FrontendExtensionRegistry.get_instance()
        extension_file = Path(__file__).parent / "extensions" / "webdav-sync.js"
        if extension_file.exists():
            registry.register_extension(extension_file, self.metadata["id"])
        get_event_bus().on("file.lock_changed", self._on_lock_changed)

    async def cleanup(self) -> None:
        """Unregister the lock change handler."""
        get_event_bus().off("file.lock_changed", self._on_lock_changed)

    async def _on_lock_changed(self, **kwargs: Any) -> None:
        """Push the updated lock state to the WebDAV server in the background (fire-and-forget)."""
        if not is_configured():
            return

        def _run() -> None:
            try:
                from fastapi_app.config import get_settings
                from fastapi_app.lib.core.dependencies import get_db
                from fastapi_app.lib.repository.file_repository import FileRepository
                from .service import SyncService
                service = SyncService(
                    file_repo=FileRepository(get_db()),
                    file_storage=None,
                    webdav_config=get_webdav_config(),
                    logger=logger,
                    db_dir=get_settings().db_dir,
                )
                service.sync_locks()
            except Exception as exc:
                logger.debug(f"Background lock sync failed (non-fatal): {exc}")

        threading.Thread(target=_run, daemon=True).start()

    async def execute_sync(self, context: PluginContext, params: dict) -> dict:
        """
        Trigger WebDAV synchronization.

        Returns SyncSummary dict directly so the frontend sync widget
        can process the result without an intermediate page.
        """
        import asyncio
        from fastapi_app.lib.core.dependencies import get_db, get_file_storage, get_sse_service
        from fastapi_app.lib.repository.file_repository import FileRepository
        from .service import SyncService

        try:
            db = get_db()
            file_repo = FileRepository(db)
            file_storage = get_file_storage()
            sse_service = get_sse_service()

            client_id = params.get('_session_id') or (context.user.get('username') if context.user else None)
            active_queues = sse_service.get_active_clients()
            if client_id and client_id not in active_queues:
                logger.warning(
                    f"SSE queue not found for client_id '{client_id}' "
                    f"(active queues: {[q[:8] for q in active_queues]}). "
                    "Progress events will not be delivered."
                )

            from fastapi_app.config import get_settings
            webdav_config = get_webdav_config()
            sync_service = SyncService(
                file_repo=file_repo,
                file_storage=file_storage,
                webdav_config=webdav_config,
                sse_service=sse_service,
                logger=logger,
                db_dir=get_settings().db_dir,
            )

            def _run_sync() -> None:
                file_repo.set_sync_metadata('sync_in_progress', '1')
                try:
                    return sync_service.perform_sync(client_id=client_id, force=False)
                finally:
                    file_repo.set_sync_metadata('sync_in_progress', '0')

            # Run blocking sync in a thread pool to avoid blocking the event loop
            loop = asyncio.get_running_loop()
            summary = await loop.run_in_executor(None, _run_sync)
            file_repo.set_sync_metadata('last_sync_summary', summary.model_dump_json())

            return summary.model_dump()

        except Exception as e:
            logger.error(f"WebDAV sync failed: {e}")
            raise
