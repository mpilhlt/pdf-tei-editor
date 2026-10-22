# Backup restore with worker recycling

Date: 2026-10-22

## Problem

The backup-restore plugin extracted an uploaded backup to `<project>/data_restore/`, sent SIGTERM to its own process, and the next startup renamed `data/` to `data_<timestamp>/` and `data_restore/` to `data/`. Three things went wrong:

- With `bin/start-prod` (4 uvicorn workers) SIGTERM only ended the uploading worker. The replacement worker swapped `data/` while the other workers kept their SQLite connections and caches on the renamed directory.
- In Docker, `/app/data` is a volume mount point. It cannot be renamed (EBUSY), and `/app/data_restore` is outside the volume and is lost when the container is recreated.
- Members of ZIPs with a `data/` prefix were extracted without checking for `..`.

## Change

- `fastapi_app/lib/core/data_restore.py`: `stage_restore()` extracts into `data/.restore/data/` (refusing unsafe paths) and writes `data/.restore/ready`. `apply_pending_restore()` runs at module import of `fastapi_app.main`, before plugin discovery opens anything, under an exclusive lock on `data/.restore.lock` (flock / msvcrt). It moves the data root's contents to `data/.restore-previous/<timestamp>/` and the staged contents in. Progress markers (`archive`, `moved-out`) make an interrupted swap resumable. `plugins/site/` (runtime-installed plugin code) is carried over.
- `fastapi_app/lib/core/worker_recycle.py`: `can_recycle_workers()` / `recycle_workers()` (SIGHUP to the uvicorn supervisor), shared with the plugin manager.
- The restore endpoint streams the upload to `data/tmp/`, stages it, and on `bin/start-prod` servers recycles the workers after 10 s instead of sending SIGTERM. uvicorn starts each replacement and waits until it is ready before stopping the old worker, so the first replacement applies the restore and the server stays up. The SIGTERM path remains for other supervisors.

## Remaining limitation

SSE queues are per worker, so the `maintenanceOn` broadcast reaches only clients connected to the uploading worker, and the startup `maintenanceOff`/`maintenanceReload` broadcast reaches nobody (no client queues exist at startup). Users may have to reload the page after a restore.
