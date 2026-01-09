from fastapi_app.lib.plugin_tools import get_plugin_config

# Initialize config values from environment variables
get_plugin_config("plugin.local-sync.enabled", "PLUGIN_LOCAL_SYNC_ENABLED", default=False, value_type="boolean")
get_plugin_config("plugin.local-sync.repo.path", "PLUGIN_LOCAL_SYNC_REPO_PATH", default=None)
get_plugin_config("plugin.local-sync.backup", "PLUGIN_LOCAL_SYNC_BACKUP", default=True, value_type="boolean")
get_plugin_config("plugin.local-sync.repo.include", "PLUGIN_LOCAL_SYNC_REPO_INCLUDE", default=None)
get_plugin_config("plugin.local-sync.repo.exclude", "PLUGIN_LOCAL_SYNC_REPO_EXCLUDE", default=None)

from .plugin import LocalSyncPlugin

plugin = LocalSyncPlugin()
