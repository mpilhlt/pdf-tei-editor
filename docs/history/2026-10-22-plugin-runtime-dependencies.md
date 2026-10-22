# Runtime install of plugin dependencies

Date: 2026-10-22

A plugin wheel contains only the plugin's code; its `Requires-Dist` lines name the packages it needs. Until now a runtime install refused every plugin with a requirement that was not installed (archival-edition, google-llm, kisski, llamore, webdav-sync).

## Behaviour

- New operator setting `PTE_PLUGIN_INSTALL_DEPENDENCIES` (off by default, Christian 2026-10-22). Off: unchanged, only plugins whose requirements are installed can be installed.
- On: `fastapi_app/lib/plugins/plugin_deps.py` resolves the missing requirements with `uv pip compile`, with every installed distribution pinned (`--constraint`), and installs the resolved packages that the environment (outside `data/plugins/site/`) lacks with `uv pip install --target <version dir> --no-deps`. The version directory is already on `sys.path` and is deleted with the plugin.
- Requirements are split by `plugin_deps.check()`: missing third-party packages (installable), and blocking ones: version conflicts with installed packages, missing `pte-plugin-*` plugins (install them first), invalid lines.
- Packages provided only by other runtime-installed plugins count as missing and are installed again (pinned to the same version), so removing one plugin does not break another.
- On upgrade, the replaced version's directory is excluded from the availability check and from the pins, because it is deleted after the restart.
- A failed package install removes the unpacked version directory.
- API: `available` entries have `install_packages`; install results have `packages`; both shown in the plugin manager.

## Tests

`tests/unit/fastapi/test_plugin_deps.py`; the uv tests resolve and install from a local wheel directory (`UV_NO_INDEX`, `UV_FIND_LINKS`), so they need uv but no network.
