# Config editor: delete plugin settings, clear hidden values

Date: 2026-10-22

## Problem

A masked value such as `plugin.anthropic-llm.api.key` could not be unset in the config editor: the masked input always starts empty, so leaving it empty does not count as a change and the editor refuses to save the `****` placeholder. There was also no way to remove a setting at all.

## Changes

- `DELETE /api/v1/config/{key}` (admin only). Only keys starting with `plugin.` can be deleted (400 otherwise, also for metadata keys such as `plugin.x.type`); 404 for a missing key. It removes the value and its `.type`, `.values` and `.description` in one locked write (`delete_config_value(..., with_metadata=True)`). `.masked` is kept so that a secret set again later stays hidden. A separate endpoint instead of an option on `/config/set`, because deleting is not a value.
- Config editor: a red trash button for `plugin.*` keys, behind a warning confirmation; an eraser button for masked keys that are set, which saves `""` after confirmation. `/config/set` already accepted `""`; an empty masked value is shown as "(not set)" (PR #595).
- `apiClient.configDelete(key)`.

## Defaults after deletion

Plugins register their keys with `get_plugin_config()` once per process (usually at startup). After a delete, the key is missing until the next start, when the registration writes the default or environment value and the metadata again. Readers in the meantime get no value (their own read default). The warning says so.

Clearing a masked value with an environment variable present: `get_plugin_config()` treats `""` as unset, so the environment value applies again at the next start.

## Multiple workers / clients

There is no server-side config cache: every request reads `config.json`, so all workers see a delete immediately. Browser clients cache config in the `config` plugin and keep the old value until they reload; the editor of another admin shows the old row until reopened. Deleting or saving a missing key from a stale editor gives a 404 / recreates the key, which is acceptable.

## Tests

- Unit: `tests/unit/fastapi/test_config_utils.py` (delete with/without metadata), `tests/unit/fastapi/test_plugin_config_masked.py` (clear, delete and re-registration).
- API: `tests/api/v1/config.test.js` (non-admin 403, non-plugin key 400, metadata key 400, delete + 404, clearing a masked value).
- E2E: `tests/e2e/tests/config-editor.spec.js`. Not runnable in the cloud sandbox (its Chromium is too old for the bundled PDF.js); relies on CI.
