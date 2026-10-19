"""Shared fixtures for the dashboard plugin tests and the tests of its contributing plugins."""

import tempfile
from pathlib import Path
from types import SimpleNamespace

from fastapi_app.lib.core.database import DatabaseManager
from fastapi_app.lib.models import FileCreate, FileMetadata
from fastapi_app.lib.repository.file_repository import FileRepository


class TempFileRepository:
    """A FileRepository on a temporary database, plus settings pointing to temporary directories."""

    def __init__(self) -> None:
        self._temp_dir = tempfile.TemporaryDirectory()
        root = Path(self._temp_dir.name)
        self.db = DatabaseManager(root / "metadata.db")
        self.repo = FileRepository(self.db)
        (root / "plugins").mkdir()
        self.settings = SimpleNamespace(db_dir=root, data_root=root, plugins_data_dir=root / "plugins")
        self._counter = 0

    def cleanup(self) -> None:
        import gc

        gc.collect()
        self._temp_dir.cleanup()

    def add(
        self,
        doc_id: str,
        file_type: str = "tei",
        collections: list[str] | None = None,
        status: str | None = None,
        variant: str | None = None,
        title: str | None = None,
        label: str | None = None,
    ) -> FileMetadata:
        """Insert a file; `title` is stored as document metadata."""
        self._counter += 1
        return self.repo.insert_file(FileCreate(
            id=f"{self._counter:064x}",
            filename=f"{self._counter}.{file_type}",
            doc_id=doc_id,
            file_type=file_type,
            file_size=1,
            status=status,
            variant=variant,
            doc_collections=collections or [],
            doc_metadata={"title": title} if title else {},
            label=label,
        ))

    def set_updated_at(self, stable_id: str, timestamp: str) -> None:
        """Overwrite a file's `updated_at` (CURRENT_TIMESTAMP only has second resolution)."""
        with self.db.get_connection() as conn:
            conn.execute("UPDATE files SET updated_at = ? WHERE stable_id = ?", (timestamp, stable_id))
