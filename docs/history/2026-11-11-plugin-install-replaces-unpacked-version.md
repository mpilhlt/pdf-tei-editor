# Plugin install replaces an unpacked version directory

## Problem

Installing a plugin failed with "pte-plugin-mpcdf-llm 2.0.0 is unpacked already in .../data/plugins/site/pte-plugin-mpcdf-llm/2.0.0" when the version directory existed but the plugin state did not list that version as installed. This happens after removing a plugin and installing it again before the restart (the directory is only in `pending_removal`), or after an interrupted install. Only filesystem access could fix it.

## Change

- `plugin_wheel.extract_wheel()` takes `replace=True`: the wheel is unpacked into a temporary sibling directory, the existing directory is moved aside, the new one renamed into place and the old one deleted. A failed extraction keeps the existing directory.
- `plugin_install.unpack()` always replaces (logged at INFO).
- `PluginManager.install_wheel()` drops the installed path from `pending_removal`, so a reinstall after a removal is not deleted at the next start (it was already kept because `remove_pending()` skips paths in use, but the entry stayed).
- Installing the version that the state lists as installed is still refused ("is installed already"); that directory is the one in use.

Tests: `test_extract_replaces_existing_directory`, `test_reinstall_after_remove_replaces_the_directory_pending_removal`, `test_install_replaces_a_leftover_version_directory` in `tests/unit/fastapi/test_plugin_runtime_install.py`.
