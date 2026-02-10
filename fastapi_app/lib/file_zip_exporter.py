"""
File zip exporter for creating in-memory zip archives from exported files.

Creates zip archives from exported files using FileExporter and directory structure.
Supports streaming responses for large archives.
"""

from pathlib import Path
from typing import Optional, List
import tempfile
import zipfile
import logging
import shutil

from .file_storage import FileStorage
from .file_repository import FileRepository
from .database import DatabaseManager
from .file_exporter import FileExporter

logger = logging.getLogger(__name__)


class FileZipExporter:
    """
    Export files to in-memory zip archive.

    Usage:
        zip_exporter = FileZipExporter(db, storage, repo)
        zip_path = zip_exporter.export_to_zip(
            collections=["corpus1", "corpus2"],
            group_by="collection"
        )
        # Use zip_path for streaming response
        # Clean up with zip_exporter.cleanup()
    """

    def __init__(
        self,
        db: DatabaseManager,
        storage: FileStorage,
        repo: FileRepository
    ):
        """
        Initialize file zip exporter.

        Args:
            db: Database manager
            storage: File storage manager
            repo: File repository
        """
        self.db = db
        self.storage = storage
        self.repo = repo
        self.temp_dir: Optional[Path] = None

    def export_to_zip(
        self,
        collections: Optional[List[str]] = None,
        variants: Optional[List[str]] = None,
        regex: Optional[str] = None,
        include_versions: bool = False,
        group_by: str = "collection",
        filename_transforms: Optional[List[str]] = None,
        tei_only: bool = False
    ) -> Path:
        """
        Export files to a zip archive.

        Args:
            collections: Filter by collection names (None = all collections)
            variants: Filter by variant names, supports glob patterns
            regex: Regular expression to filter filenames
            include_versions: If True, export versioned TEI files
            group_by: Grouping strategy: "type", "collection", or "variant"
            filename_transforms: List of sed-style transform patterns
            tei_only: If True, export only TEI files (no PDFs)

        Returns:
            Path to created zip file in temporary directory

        Raises:
            ValueError: If parameters are invalid
            RuntimeError: If export fails
        """
        # Create temporary directory for export
        self.temp_dir = Path(tempfile.mkdtemp(prefix="pdf-tei-export-"))
        export_dir = self.temp_dir / "export"
        export_dir.mkdir(parents=True)

        logger.info(f"Exporting files to temporary directory: {export_dir}")

        # Export files using FileExporter
        exporter = FileExporter(self.db, self.storage, self.repo, dry_run=False)

        try:
            stats = exporter.export_files(
                target_path=export_dir,
                collections=collections,
                variants=variants,
                regex=regex,
                include_versions=include_versions,
                group_by=group_by,
                filename_transforms=filename_transforms,
                tei_only=tei_only
            )

            logger.info(
                f"Exported {stats['files_exported']} files "
                f"({stats['files_skipped']} skipped, {len(stats['errors'])} errors)"
            )

            if stats['errors']:
                logger.warning(f"Export completed with {len(stats['errors'])} errors")

        except Exception as e:
            logger.error(f"Export failed: {e}")
            self.cleanup()
            raise RuntimeError(f"Export failed: {e}")

        # Create zip file
        zip_path = self.temp_dir / "export.zip"

        logger.info(f"Creating zip archive: {zip_path}")

        try:
            with zipfile.ZipFile(zip_path, 'w', zipfile.ZIP_DEFLATED) as zipf:
                # Walk the export directory and add all files
                for file_path in export_dir.rglob('*'):
                    if file_path.is_file():
                        # Store relative path in zip
                        arcname = file_path.relative_to(export_dir)
                        zipf.write(file_path, arcname=arcname)
                        logger.debug(f"Added to zip: {arcname}")

            logger.info(f"Zip archive created: {zip_path} ({zip_path.stat().st_size} bytes)")

        except Exception as e:
            logger.error(f"Failed to create zip archive: {e}")
            self.cleanup()
            raise RuntimeError(f"Failed to create zip archive: {e}")

        return zip_path

    def cleanup(self):
        """
        Clean up temporary directory and files.

        Should be called after the zip file has been sent to the client.
        """
        if self.temp_dir and self.temp_dir.exists():
            logger.info(f"Cleaning up temporary directory: {self.temp_dir}")
            shutil.rmtree(self.temp_dir)
            self.temp_dir = None
