# bin/migrations/

One-off scripts that must be run against existing (live) instances after upgrading. They ship in the Docker image.
`run-migration.py` runs the automatic database schema migrations (see docs/development/migrations.md); the other scripts are data migrations.

Convention: state in each script's docstring the release that introduced it. Remove a script once no supported deployment predates that release.

| Script | Purpose |
| --- | --- |
| `run-migration.py` | Run database schema migrations manually |
| `migrate-tei-fileref-to-xml-id.py` | Convert TEI file references to xml:id |
| `migrate-tei-flavor-rename.py` | Rename TEI flavors |
| `fix-doc-ids.py` | Rename files/contents containing outdated doc ids |
| `update-metadata.py` | Run/revert named maintenance functions on metadata.db |
| `update-tei-metadata.py` | Enrich TEI metadata (CrossRef/DataCite/LLM) |
| `preprocess_legacy_files.py` | Convert the legacy webdav-data layout for import |
