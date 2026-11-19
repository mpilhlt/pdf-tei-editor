# "Upgrade installed" fails with "The server is restarting" (issue #847)

## Problem

"Upgrade all" in the plugin manager reported `Could not install archival-edition: The server is restarting. Please try again.` for all plugins after the first one. After each upgrade, the upgrade buttons of the already upgraded plugins showed "Upgrade to v…" again.

## Cause

- `bin/start-dev` runs uvicorn with `--reload`, which watches all `*.py` files in the project, including `data/plugins/site/`. Unpacking the first plugin wheel there reloaded the dev server, and the following install requests were cancelled by the shutdown (`CancelledRequestMiddleware` answers 503 with "The server is restarting"). The production server (`bin/start-prod`) does not reload on file changes.
- `#upgradeAll()` in `app/src/plugins/plugin-admin.js` removed each plugin from the set of running installs and re-rendered the "Available" tab with the list loaded before the upgrades, which still offered the upgrade. The list was reloaded only after all upgrades, and that reload failed while the server restarted.

## Changes

- `bin/start-dev` creates `data/plugins/site/` and excludes it from the watched files. It sets `PTE_DEV_RELOAD_TRIGGER` to `data/plugins/dev-reload-trigger.py` (adding its directory to `--reload-dir` if the data root lies outside the project).
- `fastapi_app/lib/core/worker_recycle.py`: `can_recycle_workers()` is also true on a reloading dev server; `recycle_workers()` writes the trigger file there, which makes the reloader restart the server. "Apply plugin changes" and the restart after a data restore thus work in dev mode too.
- `plugin-admin.js`: a successful install marks the plugin as installed in the loaded list, so its button disappears at once. "Upgrade installed" restarts the server processes once after all upgrades when an upgraded plugin is in use and the server can restart itself; the confirmation says so.
- Tests: `tests/unit/fastapi/test_worker_recycle.py`; the "upgrades all installed plugins" E2E test upgrades two plugins, checks the button of the first while the second is installed, and checks that exactly one restart is requested after both.
