# Backup version compatibility

Date: 2026-10-23

## Request

The Backup & Restore plugin should version backups and refuse to restore incompatible ones: compatibility is decided by the major version from 1.0.0 on, and by the minor version before 1.0.0.

## State before

Backups contained only `db/` and `files/`. The restore checked that the upload is a ZIP with `db/users.json` and `db/config.json` and that its paths are safe; nothing recorded or checked the application version. The `version` in the plugin metadata is a fixed label of the plugin.

## Implementation

- `fastapi_app/plugins/backup_restore/manifest.py`: builds and reads `backup-manifest.json` (`format`, `pte_version`, `created_at`) and implements the rule (`compatibility_line()`: `(major,)` from 1.0.0 on, `(0, minor)` before; `check_compatible()` raises `IncompatibleBackupError` with a message naming both versions).
- `archive.create_backup_zip()` writes the manifest with the version from `package.json` (`plugin_manifest.get_pte_version()`).
- The restore route reads the manifest (also under a `data/` prefix) and answers 400 before anything is staged if the backup is incompatible, unversioned or has an invalid manifest.
- `data_restore` does not extract `backup-manifest.json` into the data root (`BACKUP_MANIFEST`).
- Backups without a manifest (all backups made before this change) are refused. The README documents adding a manifest by hand as a deliberate override.
- Pre-release suffixes are ignored (`0.77.0-devel.2` belongs to the `0.77` line), as in `fastapi_app/lib/utils/semver.py`.

## Tests

`fastapi_app/plugins/backup_restore/tests/test_plugin.py`: rule pairs, manifest reading, manifest in the archive, not extracted on staging, round trip download → restore, refusal of incompatible and unversioned backups, manifest under a `data/` prefix.
