# bin/

Scripts that ship in the production Docker image. Nothing here may depend on `scripts/`.

| Script | Purpose |
| --- | --- |
| `start-prod` / `start-dev` | Start the server (production / development with auto-reload) |
| `manage.py` | Deprecated user/group/collection/config CLI (used by `docker/entrypoint.sh`) |
| `manage-remote.js` | Admin CLI for local and remote instances |
| `import_files.py` / `export_files.py` | Import and export files |
| `batch-extract.js` | Batch extraction via the API |
| `cli_storage_gc.py` | Storage garbage collection |
| `cleanup-orphaned-xml.py` | Remove XML files without a PDF |
| `migrations/` | One-off migrations to run on live instances, see its README |

Build, development and deployment tooling lives in `scripts/`.
