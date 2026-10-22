# Config: admin-only writes, shared API keys in the config editor

Date: 2026-10-22

## Problem

- `POST /api/v1/config/set` only required a logged-in user. Any user could change any configuration key, e.g. point `plugin.anthropic-llm.api.url` to their own server and receive the API keys of all other users, or change `access-control.mode`.
- Shared API keys (`plugin.*.api.key`) only appeared in the config editor if the environment variable had been set at some point, because `get_plugin_config()` did not store unset keys. The editor cannot create keys.

## Changes

- `/config/set` requires the admin role (`require_admin_user`). The only frontend caller is the admin-only config editor; `manage-remote` uses an admin account. API test: a non-admin user gets 403.
- `get_plugin_config(..., masked=True)` stores an unset key as `""` with `.masked = True`. An empty masked value counts as unset (the environment variable still applies later) and is returned as `""` instead of the `****` sentinel by `/config/list` and `/config/get`, so the editor shows "(not set)".
