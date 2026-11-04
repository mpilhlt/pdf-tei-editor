# Prune missing runtime-installed plugins at startup

## Problem

`data/db/plugins-state.json` lists runtime-installed plugins in `installed`. If a plugin's directory in `data/plugins/site/` was deleted by hand (for example to clean up a broken install), the entry stayed. Startup only logged "missing", the plugin manager still showed the plugin as installed, and reinstalling the same version was refused with "is installed already".

## Change

- `plugin_site.missing()` returns the `installed` entries whose package directory does not exist (or whose path leaves the site directory).
- `PluginManager.discover_plugins()` calls `_prune_missing_installed()` after deleting pending directories and before activating the site directories. It logs a warning per plugin and removes the entries under the state lock, re-checking there so that a version installed by another worker in the meantime is not dropped.
- The `disabled` entry of the plugin is kept; a new install adds it to `disabled` anyway.

## Tests

`tests/unit/fastapi/test_plugin_runtime_install.py`: deleting the site directory of an installed plugin and starting a new worker removes the entry and allows reinstalling; a startup with intact directories does not change the state (no generation bump).
