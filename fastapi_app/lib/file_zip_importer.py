"""
File zip importer for extracting and importing files from zip archives.

Extracts zip archives to temporary directories and uses FileImporter
to process the extracted files.
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
from .file_importer import FileImporter, ImportStats

logger = logging.getLogger(__name__)


class FileZipImporter:
    """
    Import files from zip archives.

    Usage:
        zip_importer = FileZipImporter(db, storage, repo)
        stats = zip_importer.import_from_zip(
            zip_path="/path/to/export.zip",
            collection="corpus1"
        )
        # Clean up with zip_importer.cleanup()
    """

    def __init__(
        self,
        db: DatabaseManager,
        storage: FileStorage,
        repo: FileRepository,
        dry_run: bool = False
    ):
        """
        Initialize file zip importer.

        Args:
            db: Database manager
            storage: File storage manager
            repo: File repository
            dry_run: If True, extract and scan but don't import
        """
        self.db = db
        self.storage = storage
        self.repo = repo
        self.dry_run = dry_run
        self.temp_dir: Optional[Path] = None

    def import_from_zip(
        self,
        zip_path: Path,
        collection: Optional[str] = None,
        recursive_collections: bool = False,
        skip_dirs: Optional[List[str]] = None,
        gold_dir_name: Optional[str] = None,
        gold_pattern: Optional[str] = None,
        version_pattern: Optional[str] = None,
        on_collection_created: Optional[callable] = None
    ) -> ImportStats:
        """
        Import files from a zip archive.

        Args:
            zip_path: Path to zip file
            collection: Default collection name (can be None for multi-collection docs)
            recursive_collections: If True, use subdirectory names as collection names
            skip_dirs: Directory names to skip when determining collections
            gold_dir_name: Name of directory containing gold standard files
            gold_pattern: Regular expression pattern to detect gold standard files
            version_pattern: Regular expression pattern to detect version markers

        Returns:
            ImportStats dictionary with import results

        Raises:
            ValueError: If zip file is invalid or structure is unrecognized
            RuntimeError: If extraction or import fails
        """
        # Validate zip file
        if not zip_path.exists():
            raise ValueError(f"Zip file does not exist: {zip_path}")

        if not zipfile.is_zipfile(zip_path):
            raise ValueError(f"Not a valid zip file: {zip_path}")

        # Create temporary directory for extraction
        self.temp_dir = Path(tempfile.mkdtemp(prefix="pdf-tei-import-"))

        logger.info(f"Extracting zip archive to: {self.temp_dir}")

        try:
            # Extract zip file
            with zipfile.ZipFile(zip_path, 'r') as zipf:
                zipf.extractall(self.temp_dir)

            logger.info(f"Zip archive extracted successfully")

            # Find the root directory to import from
            # ZIP may have a single root directory (e.g., "export/") or files at root
            # When using recursive_collections, don't descend into single root folder
            # so that folder becomes a collection name
            import_root = self._find_import_root(
                self.temp_dir,
                keep_single_root=recursive_collections
            )

            logger.info(f"Import root directory: {import_root}")

            # Create FileImporter with specified parameters
            importer = FileImporter(
                self.db,
                self.storage,
                self.repo,
                dry_run=self.dry_run,
                skip_collection_dirs=skip_dirs,
                gold_dir_name=gold_dir_name,
                gold_pattern=gold_pattern,
                version_pattern=version_pattern,
                on_collection_created=on_collection_created
            )

            # Import the extracted files
            stats = importer.import_directory(
                directory=import_root,
                collection=collection,
                recursive=True,  # Always scan subdirectories in zip
                recursive_collections=recursive_collections
            )

            logger.info(
                f"Import complete: {stats['files_imported']} imported, "
                f"{stats['files_skipped']} skipped, "
                f"{len(stats['errors'])} errors"
            )

            return stats

        except Exception as e:
            logger.error(f"Import from zip failed: {e}", exc_info=True)
            self.cleanup()
            raise RuntimeError(f"Import from zip failed: {e}")

    def _find_import_root(self, extract_dir: Path, keep_single_root: bool = False) -> Path:
        """
        Find the root directory to import from.

        Handles cases:
        1. Zip with single root directory containing only subdirs → descend into it
        2. Zip with single root directory containing files → keep it as collection
           (when keep_single_root=True, this makes the folder name a collection)
        3. Zip with files at root → use extract_dir

        Args:
            extract_dir: Directory where zip was extracted
            keep_single_root: If True and single root has files directly,
                keep it so the folder name becomes a collection.

        Returns:
            Path to import root directory

        Raises:
            ValueError: If directory structure is invalid
        """
        # List immediate children (excluding hidden files/dirs and macOS metadata)
        children = [
            p for p in extract_dir.iterdir()
            if not p.name.startswith('.') and p.name != '__MACOSX'
        ]

        if not children:
            raise ValueError("Zip archive is empty")

        # If there's exactly one directory at root
        if len(children) == 1 and children[0].is_dir():
            potential_root = children[0]

            # Check if root contains files directly (not just subdirectories)
            root_children = list(potential_root.iterdir())
            has_direct_files = any(c.is_file() and c.suffix in ['.pdf', '.xml'] for c in root_children)

            if keep_single_root and has_direct_files:
                # Root folder contains files directly - use it as collection name
                logger.info(f"Keeping single root directory '{potential_root.name}' as collection (contains files)")
                return extract_dir
            else:
                # Root is just a wrapper (only contains subdirs) - descend into it
                logger.info(f"Found single root directory: {potential_root.name}")
                return potential_root

        # Otherwise, use extract_dir as root
        logger.info("Files at zip root, using extract directory as import root")
        return extract_dir

    def cleanup(self):
        """
        Clean up temporary directory and files.

        Should be called after import completes or fails.
        """
        if self.temp_dir and self.temp_dir.exists():
            logger.info(f"Cleaning up temporary directory: {self.temp_dir}")
            shutil.rmtree(self.temp_dir)
            self.temp_dir = None
