# Design: rename GROBID flavor `article/dh-law-footnotes` → `article/footnotes-refs`

Date: 2026-08-30
Status: approved (pending spec review)

## Problem

The GROBID processing flavor currently named `article/dh-law-footnotes` is being
renamed to `article/footnotes-refs`. The flavor string is:

- stored inside every affected TEI document at
  `TEI/teiHeader/encodingDesc/appInfo/application[@type="extractor"]/label[@type="flavor"]`
  (there is **no** database column or cached JSON copy of it);
- hardcoded in application source and config (`PROCESSING_FLAVORS`, a legacy
  helper in `tei_utils.py`), and referenced in docs.

The GROBID server recognises the new name, so the value sent to GROBID and the
value used to derive training-corpus export paths are both renamed too (no
mapping layer).

Existing TEI documents that carry the old flavor must be rewritten in
content-addressed storage and their database records marked for re-sync.

## Scope

1. A generic data-migration script that rewrites a given flavor label value to
   a new one across all stored TEI documents and re-queues those records for
   sync. Run once now for this rename; reusable for future flavor renames.
2. Rename the literal string in source, config, and user-facing docs so new
   extractions use the new name.

Out of scope: schema migration framework changes; rollback tooling; GROBID
server-side configuration.

## Part A — `bin/migrate-tei-flavor-rename.py`

Generic script following the pattern of `bin/migrate-tei-fileref-to-xml-id.py`.
It takes the search and replacement flavor strings as positional arguments, so
it can be reused for any future flavor rename:

```bash
uv run python bin/migrate-tei-flavor-rename.py <old-flavor> <new-flavor> [--dry-run] [--limit N] [-v]
```

For the current task it is invoked as:

```bash
uv run python bin/migrate-tei-flavor-rename.py article/dh-law-footnotes article/footnotes-refs
```

### Pure transform (no I/O)

```text
rename_flavor_in_tei(xml_bytes: bytes, old_flavor: str, new_flavor: str) -> tuple[bytes | None, str]
```

Returns `(new_bytes, status)` where `status` is one of:

| status | meaning |
| --- | --- |
| `updated` | flavor label held `old_flavor`; `new_bytes` is the rewritten document |
| `updated:extra-occurrences:N` | as `updated`, and `N` occurrences of the `old_flavor` token outside the flavor label(s) were rewritten too (the `"<variant> [<flavor>]"` note that `revisionDesc/change` carries) |
| `already_migrated` | flavor label already holds `new_flavor`; `new_bytes` is `None` |
| `skipped:no-flavor-label` | no `application[@type="extractor"]/label[@type="flavor"]` present |
| `skipped:other-flavor:<value>` | flavor label holds an unrelated value |
| `error:<message>` | parse failure |

Behaviour:

- Parse with `lxml.etree.XMLParser(recover=True)`.
- Locate `.//tei:application[@type="extractor"]//tei:label[@type="flavor"]`
  using the TEI namespace, with a non-namespaced fallback
  (`.//application[@type="extractor"]//label[@type="flavor"]`).
- Classify per the table above based on the label's stripped text.
- Rewrite via a whole-document string replacement on the decoded text
  (`xml_text.replace(old_flavor, new_flavor)`), then re-encode UTF-8. The
  `old_flavor` token is a specific compound string that only ever names this one
  flavor, so replacing it everywhere is safe; the dry run against the metadata
  DB confirmed the token appears only in the flavor `<label>` (739 docs) and, in
  2 of those, additionally in a `revisionDesc/change` note. When the occurrence
  count exceeds the number of flavor labels holding `old_flavor`, the status
  carries the `:extra-occurrences:N` suffix and the runner logs it at INFO.
  String replacement — rather than `serialize_tei_with_formatted_header()` —
  keeps the diff to the changed token, avoids reformatting the whole
  `teiHeader`, and does not drop processing instructions.

### Runner `run_migration(dry_run: bool, limit: int | None)`

1. `settings = get_settings()`;
   `db = DatabaseManager(settings.db_dir / "metadata.db")`;
   `file_repo = FileRepository(db)`;
   `file_storage = FileStorage(settings.data_root / "files", db, logger)`.
2. `tei_files = file_repo.list_files(file_type="tei")`. Deduplicate by
   `file_meta.id` (content hash) so a blob shared by several records is
   processed once. `--limit N` caps the number of distinct hashes processed.
3. For each distinct `old_id` (keeping one `FileMetadata` for logging context):
   - `xml_bytes = file_storage.read_file(old_id, "tei")`; warn + count as error
     if `None`.
   - `new_bytes, status = rename_flavor_in_tei(xml_bytes, old_flavor, new_flavor)`.
   - `status == "updated"` and not `dry_run`:
     - `new_hash, _ = file_storage.save_file(new_bytes, "tei", increment_ref=False)`
     - `file_repo.update_file(old_id, FileUpdate(id=new_hash, file_size=len(new_bytes)))`
       - updates **every** non-deleted `files` row on that hash;
       - auto-sets `sync_status='modified'`, `local_modified_at`,
         `updated_at` — this is the "re-sync" trigger;
       - handles storage ref counts: increments the new hash, decrements the
         old, and GCs the old blob if it becomes unreferenced.
   - Tally the status.
4. Print a summary: distinct hashes processed / updated / already-migrated /
   skipped / errors. Print a `DRY RUN — no files written` banner when
   `dry_run`.

### CLI

`argparse` positional args: `old_flavor`, `new_flavor`.
Flags: `--dry-run`, `--limit N`, `-v/--verbose`.
`logging.basicConfig(level=DEBUG if verbose else INFO, format="%(levelname)s: %(message)s")`.
`main()` guard. Module docstring documents purpose and usage.

### Properties

- **Idempotent**: a second run classifies rewritten files as
  `already_migrated` and makes no changes.
- **No rollback**: one-off script; restore from the automatic pre-migration DB
  backup / storage history if needed.
- **Not run automatically**: invoked manually, `--dry-run` first.

## Part B — source, config, and docs rename

Applied in the same commit as the script.

| File | Change |
| --- | --- |
| `fastapi_app/plugins/grobid/config/variants.py:23` | `PROCESSING_FLAVORS` entry `"article/dh-law-footnotes"` → `"article/footnotes-refs"` |
| `fastapi_app/lib/utils/tei_utils.py:281` | hardcoded literal → `"article/footnotes-refs"` (`create_encoding_desc_with_grobid` has no callers — legacy code, updated for consistency) |
| `fastapi_app/plugins/grobid/routes.py:373` | docstring example `"article/dh-law-footnotes"` → `"article/footnotes-refs"` |
| `fastapi_app/plugins/grobid/README.md:38` | supported-values list |
| `docs/user-manual/batch-processing.md:97` | `--option flavor=article/dh-law-footnotes` example |
| `docs/development/example.tei.xml:63` | sample `<label type="flavor">` value |

Left unchanged:

- `docs/history/**` — historical record.
- `docs/api/**` — generated from source (regenerated by the docs build).

### Behavioural consequences (accepted)

- GROBID extraction requests will send `flavor=article/footnotes-refs`
  (`plugin.py:180`). The GROBID server recognises this name.
- Training-data ZIP export paths change from
  `{model}/article/dh-law-footnotes/corpus/...` to
  `{model}/article/footnotes-refs/corpus/...`
  (`routes.py` `_corpus_base_path`).

## Testing

No automated test. The existing `bin/migrate-tei-*.py` scripts ship none, and
this is a one-off invocation of a generic script. Verification is manual:

```bash
uv run python bin/migrate-tei-flavor-rename.py article/dh-law-footnotes article/footnotes-refs --dry-run -v
uv run python bin/migrate-tei-flavor-rename.py article/dh-law-footnotes article/footnotes-refs -v
```

Then spot-check a rewritten document's flavor label and confirm the affected
`files` rows show `sync_status = 'modified'`.

## Files added / changed

- add: `bin/migrate-tei-flavor-rename.py`
- edit: `fastapi_app/plugins/grobid/config/variants.py`
- edit: `fastapi_app/lib/utils/tei_utils.py`
- edit: `fastapi_app/plugins/grobid/routes.py`
- edit: `fastapi_app/plugins/grobid/README.md`
- edit: `docs/user-manual/batch-processing.md`
- edit: `docs/development/example.tei.xml`
