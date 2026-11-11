# Plugin list KeyError after a runtime-installed plugin fails to load

## Problem

After enabling mpcdf-llm failed (`ModuleNotFoundError: No module named 'mpcdf_llm'`), `GET /api/v1/plugins/admin` raised `KeyError: 'pte-plugin-mpcdf-llm'` in `PluginRegistry.status()`, so the Plugin Manager could no longer list the plugins.

`PluginRegistry.load_deferred()` stores the result of `_load_plugin()` under the installed id. When the import fails, that result is a failed record from `_failed_record()`, whose id is derived from the package directory name (`pte_plugin_mpcdf_llm` -> `pte-plugin-mpcdf-llm`), not the plugin id (`mpcdf-llm`). The list iterates over the records and looks each one up by its own id, which is not a key.

## Change

On a failed load, `load_deferred()` keeps the installed id and the deferred record's metadata, manifest and flags (as `add_deferred()` already does for an incompatible manifest). The plugin is then listed as failed with the import error, and can be removed and installed again.

Test: `test_failed_import_keeps_the_installed_id` in `tests/unit/fastapi/test_plugin_runtime_install.py`.
