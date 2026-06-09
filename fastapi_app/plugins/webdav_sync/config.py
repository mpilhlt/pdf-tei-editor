"""WebDAV sync plugin configuration helpers."""

from fastapi_app.lib.plugins.plugin_tools import get_plugin_config
from fastapi_app.lib.utils.config_utils import get_config


def init_plugin_config() -> None:
    """Initialize plugin configuration keys from environment variables."""
    get_plugin_config("plugin.webdav-sync.enabled", "WEBDAV_ENABLED", default=False, value_type="boolean", description="Enable WebDAV synchronisation of files with a remote server")
    get_plugin_config("plugin.webdav-sync.base-url", "WEBDAV_BASE_URL", default="", description="Base URL of the WebDAV server (e.g. https://cloud.example.org/remote.php/dav/files/user)")
    get_plugin_config("plugin.webdav-sync.username", "WEBDAV_USERNAME", default="", description="Username for WebDAV authentication")
    get_plugin_config("plugin.webdav-sync.password", "WEBDAV_PASSWORD", default="", description="Password for WebDAV authentication")
    get_plugin_config("plugin.webdav-sync.remote-root", "WEBDAV_REMOTE_ROOT", default="/pdf-tei-editor", description="Remote WebDAV directory used as the sync root")
    get_plugin_config("plugin.webdav-sync.transfer-workers", "WEBDAV_TRANSFER_WORKERS", default="4", description="Number of parallel workers for WebDAV file transfers")
    get_plugin_config("plugin.webdav-sync.sync-interval", "WEBDAV_SYNC_INTERVAL", default="300", description="Interval in seconds between automatic WebDAV sync cycles (0 = disabled)")


def get_webdav_config() -> dict[str, str]:
    """Return WebDAV connection config dict for use with SyncService."""
    config = get_config()
    return {
        'base_url': config.get("plugin.webdav-sync.base-url", default=""),
        'username': config.get("plugin.webdav-sync.username", default=""),
        'password': config.get("plugin.webdav-sync.password", default=""),
        'remote_root': config.get("plugin.webdav-sync.remote-root", default="/pdf-tei-editor"),
    }


def get_sync_interval() -> int:
    """Return the periodic sync interval in seconds (0 = disabled)."""
    return int(get_config().get("plugin.webdav-sync.sync-interval", default="300"))


def get_transfer_workers() -> int:
    """Return the number of parallel transfer workers for uploads/downloads."""
    return int(get_config().get("plugin.webdav-sync.transfer-workers", default="4"))


def is_configured() -> bool:
    """Return True if WebDAV sync is enabled and a base URL is set."""
    config = get_config()
    enabled = config.get("plugin.webdav-sync.enabled", default=False)
    base_url = config.get("plugin.webdav-sync.base-url", default="")
    return bool(enabled and base_url)
