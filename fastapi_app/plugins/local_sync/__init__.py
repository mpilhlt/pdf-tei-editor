from fastapi_app.lib.plugins.plugin_tools import get_plugin_config

# Initialize config values from environment variables
get_plugin_config("plugin.local-sync.enabled", "PLUGIN_LOCAL_SYNC_ENABLED", default=False, value_type="boolean", description="Enable local-sync plugin to mirror files to/from a local git repository")
get_plugin_config("plugin.local-sync.repo.path", "PLUGIN_LOCAL_SYNC_REPO_PATH", default=None, description="Absolute path to the local git repository used for syncing")
get_plugin_config("plugin.local-sync.backup", "PLUGIN_LOCAL_SYNC_BACKUP", default=True, value_type="boolean", description="Create a backup before each sync operation")
get_plugin_config("plugin.local-sync.repo.include", "PLUGIN_LOCAL_SYNC_REPO_INCLUDE", default=None, description="Glob pattern of files to include in sync (None = all files)")
get_plugin_config("plugin.local-sync.repo.exclude", "PLUGIN_LOCAL_SYNC_REPO_EXCLUDE", default=None, description="Glob pattern of files to exclude from sync")

from .plugin import LocalSyncPlugin

plugin = LocalSyncPlugin()
