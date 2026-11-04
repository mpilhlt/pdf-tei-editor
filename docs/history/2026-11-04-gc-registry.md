# Garbage collection as a task registry, with message index cleanup

Issues: #665 (GC registry with per-task statistics), #664 (stale rows of `messages.db`).

## Registry (#665)

`fastapi_app/lib/core/gc_registry.py`:

- `GcContext`: `deleted_before`, `file_repo`, `file_storage`, `db_dir`, `sync_status`, `is_admin`, `dry_run`. The repository and storage are part of the context (not fetched by the tasks) so that the endpoint passes its injected instances and the CLI and unit tests can pass their own.
- `GcResult`: `items_deleted`, `bytes_freed`, `details: dict[str, int]`, `errors`, `skipped`.
- `register_gc_task(task_id, label, task, *, order=500, supports_dry_run=True)`, `unregister_gc_task`, `list_gc_tasks`, `run_gc(context, task_ids=None)`. Re-registering an id replaces the task and keeps its position. `run_gc` catches exceptions per task and logs one summary line per task. In a dry run, tasks registered with `supports_dry_run=False` are skipped and reported with `skipped=True`.
- `clear_directory_result(dir, dry_run)` and `register_directory_gc_task(id, label, get_dir, order=...)` for cache directories; `clear_directory` stays for plugins.
- `gc_hooks.py` is a deprecated shim: `register_gc_handler(plugin_id, fn)` registers task `plugin:<plugin_id>` (order 850, no dry run).
- Plugin API 1.1.0 exports `GcContext`, `GcResult`, `register_gc_task`, `unregister_gc_task`, `register_directory_gc_task`, `clear_directory_result`.

Core tasks, registered by `register_core_gc_tasks()` (`lib/core/gc_tasks.py`) in the lifespan:

| Order | Id | Owner | Dry run |
| --- | --- | --- | --- |
| 100 | `deleted-files` | `lib/storage/file_gc.py` | yes |
| 200 | `orphaned-storage-files` | `lib/storage/file_gc.py` | yes |
| 300 | `duplicate-entries` | `lib/storage/file_gc.py` | no |
| 400 | `tei-collections` | `lib/storage/file_gc.py` | no |
| 410 | `inbox-assignment` | `lib/storage/file_gc.py` | no |
| 500 | `orphaned-xml` | `lib/storage/file_gc.py` | yes |
| 600 | `message-index` | `lib/messages/service.py` | yes |
| 800 | `schema-cache` | `gc_tasks.py` | yes |
| 810 | `annotation-rules-cache` | `gc_tasks.py` | yes |
| 850 | `plugin:<id>` | plugins via `register_gc_handler` | no |
| 900 | `tmp` | `gc_tasks.py` | yes |

The order is the one of the old inline steps.

Behaviour change: `orphaned-xml` now releases the storage reference of each purged record before checking the reference count, so the physical file is deleted in the same run. Before, the record was deleted but the reference stayed, and the file was only removed as an orphaned storage file by the next run.

## Endpoint and response

`POST /api/v1/files/garbage_collect` builds the context (unchanged 24-hour admin check) and calls `run_gc`. New request fields: `dry_run`, `tasks` (task id filter). The response has `tasks: [{id, label, items_deleted, bytes_freed, details, errors, skipped}]`, `totals: {items_deleted, bytes_freed}` and `dry_run`. The old fields are derived:

- `purged_count`: sum of `details.records_purged`
- `files_deleted`: sum of `details.files_deleted`
- `storage_freed`: `bytes_freed` of the tasks that report `files_deleted` (file storage, not caches, as before)
- `orphaned_xml_deleted`, `annotation_rules_cache_deleted`, `plugin_items_deleted`: items of the matching tasks

## UI and CLI

- `app/src/plugins/filedata.js`: after GC, a result dialog (`gc-result-dialog.html`) with one row per task (label, items, bytes, details, errors) replaces the single notification.
- `manage-remote maintenance gc [--dry-run] [--task <id...>] [--deleted-before <iso>]` calls the endpoint and prints one line per task.
- `bin/cleanup-orphaned-xml.py` runs the `orphaned-xml` task locally (it deleted only the database rows before). `bin/cli_storage_gc.py` (reference count rebuild/verify) is unchanged.

## Message index cleanup (#664)

`MessageIndexer.collect_garbage(usernames, settled_retention_days=0, dry_run=False)`, run by the `message-index` task under `_index_lock`:

1. Occurrences of files that are missing or soft-deleted (`remove_file`, which refreshes or deletes their messages). Covers collection removal and the GC purge, which do not emit `file.deleted`.
2. All rows of recipients that are not user accounts (`delete_recipient`). Refuses to run with an empty user list.
3. Settled `r:`/`q:` occurrences whose `file_updated_at` (the time they were settled) is older than `messages.settled-retention-days`; default 0 keeps them forever. The affected messages are refreshed.
4. `read_state` rows without a message, after steps 1-3.

Recipients whose messages changed get `messagesChanged`. New `MessageStore` helpers: `recipients`, `count_recipient_rows`, `settled_review_occurrences`, `delete_occurrences`, `count_orphaned_read_state`, `delete_orphaned_read_state`.

Not done: emitting `file.deleted` from the collection removal path. The GC task removes these rows, and the access filter hides them until then.

## Tests

- `tests/unit/fastapi/test_gc_registry.py`: ordering, error isolation, dry-run skipping, task filter, plugin shim, directory clearing, file tasks against a real repository, derived response fields.
- `tests/unit/fastapi/test_messages_indexer.py::TestGarbageCollection`: each cleanup step, dry run, retention.
- `tests/api/v1/files_garbage_collect.test.js`: per-task results, order, dry run.
