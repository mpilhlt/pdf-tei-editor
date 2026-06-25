"""WebDAV sync plugin configuration helpers."""

from fastapi_app.lib.plugins.plugin_tools import PluginConfigSpec, get_plugin_config
from fastapi_app.lib.utils.config_utils import get_config

PLUGIN_CONFIG_SPECS: list[PluginConfigSpec] = [
    {
        "config_key": "plugin.webdav-sync.enabled",
        "env_var":    "WEBDAV_ENABLED",
        "default":     False,
        "value_type":  "boolean",
        "description": "Enable WebDAV synchronisation of files with a remote server",
    },
    {
        "config_key": "plugin.webdav-sync.base-url",
        "env_var":    "WEBDAV_BASE_URL",
        "default":     "",
        "description": "Base URL of the WebDAV server (e.g. https://cloud.example.org/remote.php/dav/files/user)",
    },
    {
        "config_key": "plugin.webdav-sync.username",
        "env_var":    "WEBDAV_USERNAME",
        "default":     "",
        "description": "Username for WebDAV authentication",
    },
    {
        "config_key": "plugin.webdav-sync.password",
        "env_var":    "WEBDAV_PASSWORD",
        "default":     "",
        "description": "Password for WebDAV authentication",
        "masked":      True,
    },
    {
        "config_key": "plugin.webdav-sync.remote-root",
        "env_var":    "WEBDAV_REMOTE_ROOT",
        "default":     "/pdf-tei-editor",
        "description": "Remote WebDAV directory used as the sync root",
    },
    {
        "config_key": "plugin.webdav-sync.transfer-workers",
        "env_var":    "WEBDAV_TRANSFER_WORKERS",
        "default":     "4",
        "description": "Number of parallel workers for WebDAV file transfers",
    },
    {
        "config_key": "plugin.webdav-sync.sync-interval",
        "env_var":    "WEBDAV_SYNC_INTERVAL",
        "default":     "300",
        "description": "Interval in seconds between automatic WebDAV sync cycles (0 = disabled)",
    },
]


def init_plugin_config() -> None:
    """Register plugin config keys from environment variables."""
    for spec in PLUGIN_CONFIG_SPECS:
        get_plugin_config(**spec)


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
