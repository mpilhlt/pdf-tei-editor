# Backup & Restore: Dedicated Roles and Cron Download Script — Design Spec

Date: 2026-10-03
Status: Approved for planning

## Goals

1. Add roles `backup` and `restore` so users can be allowed to download or restore backups without being admins.
2. Provide `bin/backup-download.js`, a script for cron jobs that logs in, downloads a backup to a local directory with a timestamped name, verifies it and prunes old backups.

## Current state

- `fastapi_app/plugins/backup_restore/routes.py`: `_authenticate_admin()` accepts only `admin` or `*`. It is used by `/view`, `/download` and `/restore`.
- Plugin metadata has `required_roles: ["admin"]`.
- `/download` builds the whole ZIP in memory (`io.BytesIO`) and zips the live `db/metadata.db` file directly, which can be inconsistent while SQLite is in WAL mode.
- Roles are defined in `config/roles.json`, copied to `data/db/roles.json` on first start. A role must exist there to be assignable in the user UI.
- `admin` users carry `*` in practice. Role checks elsewhere use the pattern `'*' in roles or '<role>' in roles`.

## Part 1: Roles

### New roles

Add to `config/roles.json`:

| id | roleName | description |
| --- | --- | --- |
| `backup` | Backup | Download backups of the application data (read-only access to all data) |
| `restore` | Restore | Restore the application data from a backup (replaces all data) |

The roles are independent: `backup` does not imply `restore` and vice versa.

### Authorization

Replace `_authenticate_admin()` with `_authenticate(required_role, ...)`:

| Endpoint | Allowed roles |
| --- | --- |
| `GET /view` | `backup`, `restore`, `admin`, `*` |
| `GET /download` | `backup`, `admin`, `*` |
| `POST /restore` | `restore`, `admin`, `*` |

`admin` (without `*`) still implies both roles, because existing instances have users with `["admin"]` only, and removing access on upgrade is a regression. The new roles then extend access to non-admins rather than redefining it. If admin should not imply them, a migration must add `*` or the new roles to existing admins.

Plugin metadata: `required_roles: ["backup", "restore"]`. `plugin_registry` already treats this as any-of, and `*` passes. The view (`view.html`) shows the download section only with `backup` and the restore section only with `restore` (or `admin`/`*`). The view needs the current user's roles; either pass them as template parameters from `/view` or fetch from the existing auth/status endpoint.

### Existing instances

`data/db/roles.json` is not overwritten on upgrade. Add an idempotent step that appends missing `backup`/`restore` entries to `data/db/roles.json`. The plugin calls an idempotent `ensure_roles()` in its `initialize()`; no operator action is needed. The `plugin.py` must then declare that it adds the roles, and the roles must not be removed if the plugin is deactivated.

### Security notes (to document in the admin guide)

- A backup contains `users.json` (password hashes), `config.json` (possibly API keys) and all documents. The `backup` role is therefore read access to everything; treat it as highly privileged.
- `restore` replaces `users.json`. A user with `restore` can supply a ZIP containing an admin account, so `restore` is **equivalent to admin** in practice. It decouples the UI permission, not the trust level. State this explicitly.
- Dedicated service accounts for cron should have only `backup`, no other roles, and a long random password.

### Server-side hardening (included in this work)

These make scripted downloads reliable and are needed once non-admins and cron can trigger backups:

1. **Streaming, no in-memory ZIP.** Write the ZIP to a temporary file in the data directory's parent (not inside `data/`), then serve it with `FileResponse` and delete it via a background task. Memory use stays flat for large `files/` trees.
2. **Consistent SQLite snapshot.** Create the snapshot of `db/metadata.db` (and any other `*.db`) with `sqlite3.Connection.backup()` into a temporary file and add that to the ZIP under the original name. Skip `*-wal` and `*-shm` files. See `docs/code-assistant/database-connections.md` for the connection handling.
3. **Integrity header.** Compute SHA-256 of the finished temp file and return it as `X-Content-SHA256`, along with `Content-Length`. The script verifies both.
4. **Single backup at a time.** A module-level lock; a second concurrent request gets `409 Conflict` with a clear message. A cron run overlapping a manual run then fails visibly instead of doubling I/O.
5. **Audit log.** Log user, role used, size and duration for every download and restore at INFO level.
6. **Authentication.** Use `require_authenticated_user` per the session-IP-binding spec once that migration reaches this plugin, rather than the hand-rolled session check. The script uses the `X-Session-ID` header, not the query parameter.

## Part 2: `bin/backup-download.js`

Node script in `bin/` (ships in the image, matches `manage-remote.js`: `commander`, `dotenv`, SHA-256 password hashing, login via `/api/v1/auth/login`). No new dependencies.

### Usage

```bash
node bin/backup-download.js --dest-dir /var/backups/pdf-tei-editor [options]
```

### Options

| Option | Default | Purpose |
| --- | --- | --- |
| `--dest-dir <dir>` | required | Target directory; created with mode 0700 if missing |
| `--env <path>` | `./.env` | `.env` file with `API_BASE_URL`, `API_USER`, `API_PASSWORD` (same as `manage-remote.js`) |
| `--base-url <url>` | `API_BASE_URL` or `http://localhost:8000` | Server URL |
| `--user <name>` | `API_USER` | Username |
| `--password-file <path>` | none | Read the password from a file (preferred over `API_PASSWORD`; `--password` on the command line is not offered because it appears in `ps`) |
| `--prefix <str>` | `pdf-tei-editor` | File name prefix, allows several instances in one directory |
| `--keep-last <n>` | `7` | Always keep the newest n backups, whatever their age |
| `--keep-days <n>` | `30` | Delete backups older than n days (but never below `--keep-last`) |
| `--keep-weekly <n>` / `--keep-monthly <n>` | `0` | Optional grandfather-father-son thinning: additionally keep the newest backup of each of the last n ISO weeks / calendar months |
| `--min-size <bytes>` | `1024` | Reject (and delete) a download smaller than this |
| `--retries <n>` | `3` | Retries with exponential backoff (5 s, 15 s, 45 s) on network errors and 5xx; no retry on 401/403 |
| `--timeout <sec>` | `3600` | Overall timeout for the download |
| `--ping-url <url>` | none | GET on success, `<url>/fail` on failure (healthchecks.io style dead-man monitoring) |
| `--dry-run` | off | Log what would be downloaded and deleted, change nothing |
| `--quiet` | off | Print only errors (cron mails any output) |

### Behavior

1. Acquire a lock file `<dest-dir>/.backup-download.lock` (stale locks detected via PID). If locked, exit 3 without error output beyond one line.
2. Log in; the session is used for one request and logged out in a `finally` block (best effort).
3. `GET /api/plugins/backup-restore/download` with `X-Session-ID`. Stream the body to `<dest-dir>/.<name>.part` with mode 0600.
4. Verify: byte count equals `Content-Length`, SHA-256 equals `X-Content-SHA256`, the file is larger than `--min-size`, and the ZIP central directory is readable and contains `db/users.json` and `db/config.json` (read via a small ZIP directory parse, no extraction).
5. `fsync`, then atomically `rename` to the final name. A partial or failed download never has a final name and is deleted.
6. **Only after a verified download**, apply retention. If the download failed, nothing is deleted, so an outage cannot erase the last good backups.
7. Ping the monitoring URL if configured.

### File naming

`<prefix>_<YYYYMMDDTHHMMSSZ>.zip`, e.g. `pdf-tei-editor_20261003T020000Z.zip`.

- UTC, so names sort lexicographically and are unaffected by DST.
- Retention matches only files with exactly this pattern and the configured prefix. Foreign files in the directory are never touched.
- Age is taken from the timestamp in the name, not the file mtime, since mtime changes on copy or restore of the backup directory.

### Retention rules

Keep set = union of: newest `--keep-last`, everything younger than `--keep-days`, GFS slots if configured. Delete everything else matching the pattern. The newest verified backup is always in the keep set. `--keep-days 0` and `--keep-last 0` together are rejected.

### Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Success |
| 1 | Download or verification failed |
| 2 | Authentication/authorization failed (wrong credentials, user lacks `backup`) |
| 3 | Another run holds the lock |
| 4 | Invalid arguments or unwritable destination |

Non-zero exits with a one-line message on stderr work with cron `MAILTO` and systemd timers.

### Example cron entry and credentials

```bash
# /etc/cron.d/pdf-tei-editor-backup  — daily at 02:17, new user "backup-cron" with role "backup" only
17 2 * * * backup umask 077; cd /opt/pdf-tei-editor && node bin/backup-download.js --dest-dir /var/backups/pdf-tei-editor --user backup-cron --password-file /etc/pdf-tei-editor/backup.pw --base-url https://editor.example.org --quiet --ping-url https://hc-ping.com/<uuid>
```

For Docker deployments, run the script on the host (or a sidecar) against the published port, with the destination on a bind-mounted host path.

## Best practices to document

- **Off-site copy.** A backup next to the data it protects survives neither disk failure nor ransomware. Copy the destination directory off-host (`rclone`, `restic`, `rsync`, object storage). Out of scope for the script; document the 3-2-1 rule (3 copies, 2 media, 1 off-site).
- **Encryption at rest.** Backups hold password hashes and API keys. Keep the directory at 0700 and encrypt off-site copies (`restic` and `rclone crypt` do this).
- **Test restores.** An unrestored backup is untested. Recommend a quarterly restore into a scratch instance.
- **Monitor.** Use `--ping-url` or alert on the age of the newest file; failures that only write to a mail spool go unnoticed.
- **Transport.** Use HTTPS to the server; the login sends a SHA-256 hash that is effectively the password.
- **Schedule off-peak** and keep `--keep-days` at least as long as the time it takes to notice data corruption.
- **Dedicated account.** One account per job, `backup` role only, rotate the password file on staff changes.

## Out of scope

- A restore script. Restore replaces all data and restarts the server; keep it a deliberate manual UI action.
- Long-lived API tokens as an alternative to username/password login. Worth a follow-up, since session login for unattended jobs is a workaround; it would also remove the password file.
- Incremental backups and server-side scheduled backups (the script is cron-driven by design; a server-side scheduler would need its own retention and failure reporting).

## Tests

Backend (`fastapi_app/plugins/backup_restore/tests/`):

- Authorization matrix: `backup`, `restore`, `admin`, `*`, none, against `/view`, `/download`, `/restore`.
- Download of a WAL-mode SQLite database yields a ZIP whose `metadata.db` opens and passes `PRAGMA integrity_check`; no `-wal`/`-shm` entries.
- `X-Content-SHA256` and `Content-Length` match the body; temp file removed after the response.
- Concurrent second download returns 409.
- `ensure_roles()` is idempotent and preserves custom roles.

Script (unit tests, `tests/unit/js/`, mocked `fetch` and a temp directory):

- Retention: keep-last, keep-days, GFS, never deletes foreign files, never deletes the newest, no deletion when the download failed.
- Atomic write: no final file after a truncated body, checksum mismatch, or too-small file.
- Exit codes for 401/403, 5xx with retries, lock contention.
- `--dry-run` changes nothing.

E2E: backup-only user sees only the download section and gets 403 from `/restore`.

## Documentation to update

- `docs/user-manual/import-export-admin.md` "Backup and Restore" section: the plugin, roles, cron script, best practices above.
- `docs/user-manual/admin-guide.md` role list.
- `bin/README.md` script table.
- `docs/code-assistant/backend-plugins.md`: plugin-defined roles via `ensure_roles()`.

## Decisions

1. `admin` without `*` implies both `backup` and `restore`.
2. The roles are added by the plugin (`ensure_roles()` on start), not by a `bin/migrations/` script.
3. The cron script is Node (`bin/backup-download.js`).
