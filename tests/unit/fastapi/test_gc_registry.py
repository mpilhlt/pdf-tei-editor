"""
Unit tests for the garbage-collection task registry, the plugin handler shim, the file tasks
and the response of the GC endpoint.

@testCovers fastapi_app/lib/core/gc_registry.py
@testCovers fastapi_app/lib/core/gc_hooks.py
@testCovers fastapi_app/lib/storage/file_gc.py
@testCovers fastapi_app/routers/files_gc.py::build_response
"""

import gc
import shutil
import tempfile
import unittest
from datetime import datetime, timedelta
from pathlib import Path
from typing import cast

from fastapi_app.lib.core import gc_registry
from fastapi_app.lib.core.database import DatabaseManager
from fastapi_app.lib.core.gc_hooks import register_gc_handler, unregister_gc_handler
from fastapi_app.lib.core.gc_registry import (
    GcContext,
    GcResult,
    clear_directory_result,
    list_gc_tasks,
    register_gc_task,
    run_gc,
    unregister_gc_task,
)
from fastapi_app.lib.models.models import FileCreate
from fastapi_app.lib.repository.file_repository import FileRepository
from fastapi_app.lib.storage.file_gc import register_file_gc_tasks
from fastapi_app.lib.storage.file_storage import FileStorage
from fastapi_app.routers.files_gc import build_response


class RegistryTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self._saved = dict(gc_registry._tasks)
        gc_registry._tasks.clear()
        self.context = GcContext(
            deleted_before=datetime.now(),
            file_repo=cast(FileRepository, None),
            file_storage=cast(FileStorage, None),
            db_dir=Path("."),
        )

    def tearDown(self) -> None:
        gc_registry._tasks.clear()
        gc_registry._tasks.update(self._saved)


class TestRegistry(RegistryTestCase):
    def test_tasks_run_by_order_then_registration(self) -> None:
        calls: list[str] = []

        def task(name: str):
            def run(ctx: GcContext) -> GcResult:
                calls.append(name)
                return GcResult(items_deleted=1)
            return run

        register_gc_task("late", "Late", task("late"), order=900)
        register_gc_task("b", "B", task("b"), order=100)
        register_gc_task("c", "C", task("c"), order=100)
        register_gc_task("a", "A", task("a"), order=50)
        register_gc_task("b", "B again", task("b2"), order=100)  # replaced, keeps its position
        runs = run_gc(self.context)
        self.assertEqual(calls, ["a", "b2", "c", "late"])
        self.assertEqual([r.id for r in runs], ["a", "b", "c", "late"])
        self.assertEqual(runs[1].label, "B again")

    def test_failing_task_reports_error_and_others_run(self) -> None:
        def boom(ctx: GcContext) -> GcResult:
            raise RuntimeError("broken")

        register_gc_task("boom", "Boom", boom, order=1)
        register_gc_task("ok", "OK", lambda ctx: GcResult(items_deleted=2), order=2)
        runs = {r.id: r.result for r in run_gc(self.context)}
        self.assertEqual(runs["boom"].errors, ["broken"])
        self.assertEqual(runs["ok"].items_deleted, 2)

    def test_dry_run_skips_tasks_without_dry_run_support(self) -> None:
        seen: list[bool] = []

        def task(ctx: GcContext) -> GcResult:
            seen.append(ctx.dry_run)
            return GcResult()

        register_gc_task("dry", "Dry", task)
        register_gc_task("wet", "Wet", task, supports_dry_run=False)
        self.context.dry_run = True
        runs = {r.id: r.result for r in run_gc(self.context)}
        self.assertEqual(seen, [True])
        self.assertTrue(runs["wet"].skipped)
        self.assertFalse(runs["dry"].skipped)

    def test_task_filter(self) -> None:
        register_gc_task("a", "A", lambda ctx: GcResult())
        register_gc_task("b", "B", lambda ctx: GcResult())
        self.assertEqual([r.id for r in run_gc(self.context, ["b", "unknown"])], ["b"])

    def test_unregister(self) -> None:
        register_gc_task("a", "A", lambda ctx: GcResult())
        unregister_gc_task("a")
        unregister_gc_task("a")
        self.assertEqual(list_gc_tasks(), [])

    def test_plugin_handler_shim(self) -> None:
        register_gc_handler("myplugin", lambda: 3)
        runs = run_gc(self.context)
        self.assertEqual([(r.id, r.result.items_deleted) for r in runs], [("plugin:myplugin", 3)])
        response = build_response(runs, dry_run=False)
        self.assertEqual(response.plugin_items_deleted, {"myplugin": 3})
        unregister_gc_handler("myplugin")
        self.assertEqual(list_gc_tasks(), [])


class TestClearDirectory(unittest.TestCase):
    def test_counts_entries_and_bytes(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "a.txt").write_bytes(b"12345")
            (root / "sub").mkdir()
            (root / "sub" / "b.txt").write_bytes(b"123")
            dry = clear_directory_result(root, dry_run=True)
            self.assertEqual((dry.items_deleted, dry.bytes_freed), (2, 8))
            self.assertTrue((root / "a.txt").exists())
            result = clear_directory_result(root)
            self.assertEqual((result.items_deleted, result.bytes_freed), (2, 8))
            self.assertEqual(list(root.iterdir()), [])
            self.assertEqual(clear_directory_result(root / "missing").items_deleted, 0)


class TestFileTasks(RegistryTestCase):
    def setUp(self) -> None:
        super().setUp()
        self.test_dir = Path(tempfile.mkdtemp())
        (self.test_dir / "storage").mkdir()
        self.db = DatabaseManager(self.test_dir / "test.db")
        self.repo = FileRepository(self.db)
        self.storage = FileStorage(self.test_dir / "storage", self.db)
        self.context.file_repo = self.repo
        self.context.file_storage = self.storage
        self.context.deleted_before = datetime.now() + timedelta(seconds=1)
        register_file_gc_tasks()

    def tearDown(self) -> None:
        super().tearDown()
        gc.collect()
        shutil.rmtree(self.test_dir)

    def add_file(self, content: bytes, doc_id: str, file_type: str) -> str:
        file_hash, _ = self.storage.save_file(content, file_type, increment_ref=False)
        self.repo.insert_file(FileCreate(
            id=file_hash, filename=f"{doc_id}.{file_type}", doc_id=doc_id, file_type=file_type,
            file_size=len(content), label=doc_id,
        ))
        return file_hash

    def test_purges_deleted_and_orphaned_xml_files(self) -> None:
        self.add_file(b"%PDF-1.4 keep", "keep", "pdf")
        self.add_file(b"<TEI>keep</TEI>", "keep", "tei")
        deleted = self.add_file(b"%PDF-1.4 deleted", "gone", "pdf")
        self.repo.delete_file(deleted)
        self.add_file(b"<TEI>orphan</TEI>", "orphan", "tei")

        self.context.dry_run = True
        dry = {r.id: r.result for r in run_gc(self.context)}
        self.assertEqual(dry["deleted-files"].items_deleted, 1)
        self.assertEqual(dry["orphaned-xml"].items_deleted, 1)
        self.assertTrue(dry["duplicate-entries"].skipped)
        self.assertEqual(len(self.repo.get_deleted_files_for_gc(deleted_before=self.context.deleted_before)), 1)

        self.context.dry_run = False
        runs = run_gc(self.context)
        results = {r.id: r.result for r in runs}
        self.assertEqual(results["deleted-files"].details, {"records_purged": 1, "files_deleted": 1})
        self.assertEqual(results["deleted-files"].bytes_freed, len(b"%PDF-1.4 deleted"))
        self.assertEqual(results["orphaned-xml"].items_deleted, 1)
        self.assertEqual(self.repo.get_deleted_files_for_gc(deleted_before=self.context.deleted_before), [])
        self.assertEqual(self.repo.get_orphaned_xml_files(), [])

        response = build_response(runs, dry_run=False)
        self.assertEqual(response.purged_count, 2)
        self.assertEqual(response.files_deleted, 2)
        self.assertEqual(response.orphaned_xml_deleted, 1)
        self.assertEqual(response.storage_freed, sum(r.result.bytes_freed for r in runs))
        self.assertEqual([t.id for t in response.tasks][:2], ["deleted-files", "orphaned-storage-files"])


if __name__ == "__main__":
    unittest.main()
