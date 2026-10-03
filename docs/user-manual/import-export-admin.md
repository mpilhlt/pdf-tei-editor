# Import/Export — Administrator Guide

This page covers batch import via the CLI, the REST export API, and backup procedures. For the web UI, see [Importing and Exporting Files](./import-export.md).

---

## CLI Import (`import_files.py`)

The `bin/import_files.py` script imports PDF and TEI files in bulk. It:

- groups related PDF and TEI files by document ID
- assigns files to collections
- deduplicates files by content hash
- identifies gold standard files

### Basic Usage

```bash
uv run python bin/import_files.py /path/to/files
```

Import into a specific collection:

```bash
uv run python bin/import_files.py /path/to/files --collection my_collection
```

Dry run (preview without writing):

```bash
uv run python bin/import_files.py /path/to/files --dry-run
```

Verbose logging:

```bash
uv run python bin/import_files.py /path/to/files --verbose
```

### Collection Assignment

**Single collection** — all imported files go to one collection:

```bash
uv run python bin/import_files.py /path/to/files --collection corpus1
```

**Auto-detect from subdirectory names** — each immediate subdirectory becomes a collection:

```bash
uv run python bin/import_files.py /path/to/data --recursive-collections
```

Example directory structure:

```text
/path/to/data/
├── corpus1/
│   ├── doc1.pdf
│   └── doc1.tei.xml
└── corpus2/
    ├── doc2.pdf
    └── doc2.tei.xml
```

Result: `corpus1/doc1.*` → collection `corpus1`, `corpus2/doc2.*` → collection `corpus2`.

**Skip organisational subdirectories** (e.g. `pdf/`, `tei/` inside a collection folder):

```bash
uv run python bin/import_files.py /path/to/data \
  --recursive-collections \
  --skip-dirs pdf tei versions version
```

The intermediate directory names are ignored and the parent directory is used as the collection name.

### Gold Standard Detection

Files without a `.vN.` version marker are treated as gold standard by default:

| Filename | Interpretation |
| --- | --- |
| `doc1.tei.xml` | Gold (no version marker) |
| `doc1.grobid.tei.xml` | Gold with variant |
| `doc1.v1.tei.xml` | Version 1 — not gold |
| `doc1.grobid.v2.tei.xml` | Version 2 with variant — not gold |

Custom version pattern:

```bash
uv run python bin/import_files.py /path/to/files --version-pattern '\.version\d+\.'
```

Legacy pattern-based gold detection (overrides version marker logic):

```bash
uv run python bin/import_files.py /path/to/files --gold-pattern '\.gold\.'
```

### Document ID Resolution

IDs are resolved in this order:

1. DOI from TEI metadata: `<idno type="DOI">10.1234/article</idno>`
2. DOI-like filename: `10.1234_article.pdf` → `10.1234/article`
3. Plain filename stem: `my_document.pdf` → `my_document`

### Custom Database / Storage Paths

```bash
uv run python bin/import_files.py /path/to/files \
  --db-path /custom/path/metadata.db \
  --storage-root /custom/path/storage
```

### Clearing Existing Data

```bash
uv run python bin/import_files.py /path/to/files --clean
```

This deletes all existing files and metadata before importing. Use with caution.

### Complete Example

```bash
uv run python bin/import_files.py source-data \
  --recursive-collections \
  --skip-dirs pdf tei versions \
  --db-path ./data/db/metadata.db \
  --storage-root ./data/files \
  --verbose
```

---

## REST Export API

The export endpoint is available for programmatic or scripted exports.

`GET /api/v1/export`

Authentication: pass the session ID as the `sessionId` query parameter.

| Parameter | Type | Description |
| --- | --- | --- |
| `sessionId` | string | Required. Session ID for authentication |
| `collections` | string | Comma-separated collection IDs. Omit to export all accessible collections |
| `variants` | string | Comma-separated variant names; supports glob patterns (e.g. `grobid*`) |
| `include_versions` | boolean | Include versioned TEI files (default: `false`) |
| `group_by` | string | ZIP directory layout: `collection` (default), `type`, or `variant` |

Response: a `application/zip` attachment named `export.zip`.

**`group_by=collection`** (default):

```text
export.zip/collection1/pdf/doc.pdf
export.zip/collection1/tei/doc.tei.xml
```

**`group_by=type`**:

```text
export.zip/pdf/doc.pdf
export.zip/tei/doc.tei.xml
export.zip/versions/doc.v1.tei.xml
```

**`group_by=variant`**:

```text
export.zip/pdf/doc.pdf
export.zip/grobid-0.8.1/doc.tei.xml
```

**Examples:**

```bash
# Export all accessible collections
curl -O "http://localhost:8000/api/v1/export?sessionId=SESSION"

# Specific collections
curl -O "http://localhost:8000/api/v1/export?sessionId=SESSION&collections=corpus1,corpus2"

# Grobid variants only
curl -O "http://localhost:8000/api/v1/export?sessionId=SESSION&variants=grobid*"

# Include versioned TEI files
curl -O "http://localhost:8000/api/v1/export?sessionId=SESSION&include_versions=true"
```

Access control: only collections the current user has access to are exported.

---

## Backup and Restore

Files are stored in content-addressable storage under `data/files/`, sharded by the first four hex characters of the SHA-256 hash:

```text
data/files/{first-2}/{next-2}/{full-hash}.{ext}
```

Example: `data/files/a1/b2/a1b2c3d4…xyz.pdf`

**Full backup** (database + storage):

```bash
tar -czf backup.tar.gz data/db/metadata.db data/files/
```

**Database-only backup:**

```bash
cp data/db/metadata.db backup/metadata.db
```

**Restore:** replace the database and storage directory from the backup, then restart the server.

### Backup & Restore plugin

Full guide for administrators and for the cron setup: [Backup & Restore plugin README](../../fastapi_app/plugins/backup_restore/README.md).

The Backup & Restore plugin (Administration menu) downloads the `db/` and `files/` directories as a ZIP file and restores from such a ZIP. SQLite databases are snapshotted consistently, so a backup can be taken while the server is running. Restore replaces all data and restarts the server (if running under a supervisor).

Access is controlled by two roles that can be assigned independently of `admin`:

| Role | Allows |
| --- | --- |
| `backup` | Downloading backups (UI and API) |
| `restore` | Restoring from a backup |

Users with `admin` or `*` have both roles. The roles are added to `data/db/roles.json` automatically when the plugin starts.

Security notes:

- A backup contains password hashes, configuration values (possibly API keys) and all documents. The `backup` role is read access to everything.
- `restore` is equivalent to `admin`: the restored `users.json` can contain any account.

### Scheduled backups with cron

`bin/backup-download.js` logs in, downloads a backup to a timestamped file (`pdf-tei-editor_20261003T020000Z.zip`, UTC), verifies it (size, SHA-256, ZIP structure) and prunes old backups. Create a dedicated user with only the `backup` role and store its password in a file readable only by the cron user.

```bash
# /etc/cron.d/pdf-tei-editor-backup: daily at 02:17
17 2 * * * backup cd /opt/pdf-tei-editor && node bin/backup-download.js --dest-dir /var/backups/pdf-tei-editor --user backup-cron --password-file /etc/pdf-tei-editor/backup.pw --base-url https://editor.example.org --quiet --ping-url https://hc-ping.com/<uuid>
```

| Option | Default | Purpose |
| --- | --- | --- |
| `--dest-dir <dir>` | required | Target directory (created with mode 0700) |
| `--env <path>` | `./.env` | `.env` with `API_BASE_URL`, `API_USER`, `API_PASSWORD` |
| `--base-url <url>` | `API_BASE_URL` or `http://localhost:8000` | Server URL |
| `--user <name>` | `API_USER` | Username |
| `--password-file <path>` | `API_PASSWORD` | File containing the password |
| `--prefix <str>` | `pdf-tei-editor` | File name prefix |
| `--keep-last <n>` | 7 | Always keep the newest n backups |
| `--keep-days <n>` | 30 | Delete backups older than n days (never below `--keep-last`) |
| `--keep-weekly <n>` | 0 | Also keep the newest backup of each of the n most recent ISO weeks |
| `--keep-monthly <n>` | 0 | Also keep the newest backup of each of the n most recent months |
| `--min-size <bytes>` | 1024 | Reject smaller downloads |
| `--retries <n>` | 3 | Retries on network errors, 5xx and 409 (backoff 5 s, 15 s, 45 s) |
| `--timeout <sec>` | 3600 | Timeout per attempt |
| `--ping-url <url>` | none | GET on success, `<url>/fail` on failure |
| `--dry-run` | off | Show what would happen, change nothing |
| `--quiet` | off | Print only errors |

Exit codes: 0 success, 1 download or verification failed, 2 authentication or authorization failed, 3 another run is active, 4 invalid arguments or unwritable destination.

Behavior: the file is written as a hidden `.part` file and renamed only after verification. Pruning runs only after a verified download and only touches files matching `<prefix>_<timestamp>.zip`, so a server outage never deletes the last good backups. Age is taken from the timestamp in the file name.

Recommendations:

- Copy the backup directory off-host (`rclone`, `restic`, `rsync`): 3 copies, 2 media, 1 off-site. Encrypt off-site copies.
- Test a restore on a scratch instance regularly.
- Alert on a missing or stale backup (`--ping-url` or the age of the newest file); a failure mail alone is easily overlooked.
- Use HTTPS; the password hash sent at login is equivalent to the password.
- Rotate the password file when staff change.

---

## Docker

When running in Docker, mount a host directory and run the import script inside the container:

```bash
docker run -v /path/to/data:/data/import \
  pdf-tei-editor \
  uv run python bin/import_files.py /data/import --recursive-collections
```

See [Docker Deployment](docker-deployment.md) for general Docker setup.
