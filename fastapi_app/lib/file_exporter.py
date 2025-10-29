"""
File exporter for exporting files from hash-sharded storage to human-readable directories.

Exports files from the content-addressable repository into organized directory
structures based on various grouping strategies.
"""

from pathlib import Path
from typing import Optional, List, Dict, TypedDict
import logging
import re
import fnmatch

from .file_storage import FileStorage
from .file_repository import FileRepository
from .database import DatabaseManager
from .models import FileMetadata
from .hash_utils import get_file_extension
from .doi_utils import encode_filename

logger = logging.getLogger(__name__)


class ExportStats(TypedDict):
    """Statistics for file export operations."""
    files_scanned: int
    files_exported: int
    files_skipped: int
    errors: List[Dict[str, str]]


class FileExporter:
    """
    Export files from hash-sharded storage to human-readable directory structure.

    Usage:
        exporter = FileExporter(db, storage, repo)
        stats = exporter.export_files(
            target_path=Path("export"),
            collections=["corpus1", "corpus2"],
            variants=["grobid*"],
            group_by="collection"
        )
        print(f"Exported {stats['files_exported']} files")
    """

    def __init__(
        self,
        db: DatabaseManager,
        storage: FileStorage,
        repo: FileRepository,
        dry_run: bool = False
    ):
        """
        Initialize file exporter.

        Args:
            db: Database manager
            storage: File storage manager
            repo: File repository
            dry_run: If True, scan but don't export
        """
        self.db = db
        self.storage = storage
        self.repo = repo
        self.dry_run = dry_run

        self.stats: ExportStats = {
            'files_scanned': 0,
            'files_exported': 0,
            'files_skipped': 0,
            'errors': []
        }

    def export_files(
        self,
        target_path: Path,
        collections: Optional[List[str]] = None,
        variants: Optional[List[str]] = None,
        regex: Optional[str] = None,
        include_versions: bool = False,
        group_by: str = "type",
        filename_transform: Optional[str] = None
    ) -> ExportStats:
        """
        Export files to target directory with optional filters and grouping.

        Args:
            target_path: Destination directory for export
            collections: Filter by collection names (None = all collections)
            variants: Filter by variant names, supports glob patterns like "grobid*"
            regex: Regular expression to filter filenames
            include_versions: If True, export versioned TEI files
            group_by: Grouping strategy: "type" (default), "collection", or "variant"
            filename_transform: sed-style transform pattern (/search/replace/)

        Returns:
            Export statistics

        Raises:
            ValueError: If group_by is invalid or target_path is invalid
        """
        # Validate parameters
        if group_by not in ("type", "collection", "variant"):
            raise ValueError(f"Invalid group_by: {group_by}. Must be 'type', 'collection', or 'variant'")

        # Validate transform pattern if provided
        if filename_transform:
            self._validate_transform(filename_transform)

        # Create target directory
        if not self.dry_run:
            target_path = Path(target_path)
            target_path.mkdir(parents=True, exist_ok=True)
        else:
            logger.info("[DRY RUN] Would create target directory: %s", target_path)

        # Reset stats
        self.stats = {
            'files_scanned': 0,
            'files_exported': 0,
            'files_skipped': 0,
            'errors': []
        }

        # Query files based on filters
        files_to_export = self._query_files(collections, variants, include_versions)

        logger.info(f"Found {len(files_to_export)} files matching filters")

        # Export each file
        for file_meta in files_to_export:
            self.stats['files_scanned'] += 1

            try:
                # Construct filename
                filename = self._construct_filename(file_meta)

                # Apply regex filter if provided
                if regex and not re.search(regex, filename):
                    logger.debug(f"Skipping {filename} (regex filter)")
                    self.stats['files_skipped'] += 1
                    continue

                # Apply filename transform if provided
                if filename_transform:
                    filename = self._apply_transform(filename, filename_transform)

                # Determine output paths based on grouping
                output_paths = self._get_output_paths(
                    target_path, file_meta, filename, group_by
                )

                # Export to all paths (handles multi-collection duplication)
                for output_path in output_paths:
                    self._export_file(file_meta, output_path)

            except Exception as e:
                logger.error(f"Error exporting file {file_meta.id[:8]}: {e}")
                self.stats['errors'].append({
                    'file_id': file_meta.id,
                    'filename': file_meta.filename,
                    'error': str(e)
                })

        logger.info(
            f"Export complete: {self.stats['files_exported']} exported, "
            f"{self.stats['files_skipped']} skipped, "
            f"{len(self.stats['errors'])} errors"
        )

        return self.stats

    def _query_files(
        self,
        collections: Optional[List[str]],
        variants: Optional[List[str]],
        include_versions: bool
    ) -> List[FileMetadata]:
        """
        Query files from database based on filters.

        Args:
            collections: Collection filter
            variants: Variant filter (supports glob patterns)
            include_versions: Include versioned files

        Returns:
            List of file metadata matching filters
        """
        all_files: List[FileMetadata] = []

        # If collections specified, query each collection
        if collections:
            for collection in collections:
                # Get PDFs for this collection
                pdfs = self.repo.list_files(
                    collection=collection,
                    file_type='pdf',
                    include_deleted=False
                )
                all_files.extend(pdfs)

                # Get gold TEI files for this collection
                tei_files = self.repo.list_files(
                    collection=collection,
                    file_type='tei',
                    include_deleted=False
                )
                # Filter for gold standard (version IS NULL or version = 1 with is_gold_standard)
                gold_files = [
                    f for f in tei_files
                    if f.version is None or (f.version == 1 and f.is_gold_standard)
                ]
                all_files.extend(gold_files)

                # If include_versions, get versioned files
                if include_versions:
                    version_files = [
                        f for f in tei_files
                        if f.version is not None and f.version > 1
                    ]
                    all_files.extend(version_files)
        else:
            # No collection filter - get all files
            # Get all PDFs
            pdfs = self.repo.list_files(file_type='pdf', include_deleted=False)
            all_files.extend(pdfs)

            # Get all gold TEI files
            tei_files = self.repo.list_files(file_type='tei', include_deleted=False)
            gold_files = [
                f for f in tei_files
                if f.version is None or (f.version == 1 and f.is_gold_standard)
            ]
            all_files.extend(gold_files)

            # If include_versions, get versioned files
            if include_versions:
                version_files = [
                    f for f in tei_files
                    if f.version is not None and f.version > 1
                ]
                all_files.extend(version_files)

        # Apply variant filter if specified
        if variants:
            all_files = self._filter_by_variants(all_files, variants)

        return all_files

    def _filter_by_variants(
        self,
        files: List[FileMetadata],
        variants: List[str]
    ) -> List[FileMetadata]:
        """
        Filter files by variant names with glob pattern support.

        Args:
            files: List of file metadata
            variants: List of variant patterns (supports * wildcard)

        Returns:
            Filtered list of files
        """
        filtered = []

        for file_meta in files:
            # PDFs don't have variants, always include them
            if file_meta.file_type == 'pdf':
                filtered.append(file_meta)
                continue

            # Check if variant matches any pattern
            file_variant = file_meta.variant or ""
            for pattern in variants:
                if fnmatch.fnmatch(file_variant, pattern):
                    filtered.append(file_meta)
                    break

        return filtered

    def _construct_filename(self, file_meta: FileMetadata) -> str:
        """
        Construct human-readable filename from file metadata.

        Filename format:
        - PDFs: <encoded_doc_id>.pdf
        - Gold TEI (with variant): <encoded_doc_id>.<variant>.tei.xml
        - Gold TEI (no variant): <encoded_doc_id>.tei.xml
        - Versioned TEI: <encoded_doc_id>.<variant>-v<version>.tei.xml

        Args:
            file_meta: File metadata

        Returns:
            Constructed filename
        """
        # Encode doc_id for filesystem safety
        encoded_doc_id = encode_filename(file_meta.doc_id)

        # Get extension
        extension = get_file_extension(file_meta.file_type)

        # Build filename based on file type
        if file_meta.file_type == 'pdf':
            return f"{encoded_doc_id}{extension}"

        elif file_meta.file_type == 'tei':
            # Check if this is a versioned file
            if file_meta.version is not None and file_meta.version > 1:
                # Versioned file: doc_id.variant-vN.tei.xml
                variant_part = file_meta.variant or "default"
                return f"{encoded_doc_id}.{variant_part}-v{file_meta.version}{extension}"
            else:
                # Gold file
                if file_meta.variant:
                    # With variant: doc_id.variant.tei.xml
                    return f"{encoded_doc_id}.{file_meta.variant}{extension}"
                else:
                    # No variant: doc_id.tei.xml
                    return f"{encoded_doc_id}{extension}"

        else:
            # Other file types (e.g., rng)
            return f"{encoded_doc_id}{extension}"

    def _validate_transform(self, transform: str) -> None:
        """
        Validate sed-style transformation pattern.

        Args:
            transform: Transform pattern to validate

        Raises:
            ValueError: If transform pattern is invalid
        """
        # Parse /search/replace/ pattern
        if not transform.startswith('/'):
            raise ValueError("Transform pattern must start with '/'")

        parts = transform[1:].split('/')
        if len(parts) < 2:
            raise ValueError("Transform pattern must be in format /search/replace/")

        search = parts[0]

        # Validate regex
        try:
            re.compile(search)
        except re.error as e:
            raise ValueError(f"Invalid regex in transform: {e}")

    def _apply_transform(self, filename: str, transform: str) -> str:
        """
        Apply sed-style transformation to filename.

        Supports basic /search/replace/ syntax.
        Transform should be validated before calling this method.

        Args:
            filename: Original filename
            transform: Transform pattern (/search/replace/)

        Returns:
            Transformed filename
        """
        # Parse /search/replace/ pattern (already validated)
        parts = transform[1:].split('/')
        search = parts[0]
        replace = parts[1] if len(parts) > 1 else ""

        # Apply regex substitution
        return re.sub(search, replace, filename)

    def _get_output_paths(
        self,
        target_path: Path,
        file_meta: FileMetadata,
        filename: str,
        group_by: str
    ) -> List[Path]:
        """
        Determine output path(s) based on grouping strategy.

        For multi-collection files with group_by="collection", returns multiple paths.

        Args:
            target_path: Base target directory
            file_meta: File metadata
            filename: Constructed filename
            group_by: Grouping strategy

        Returns:
            List of output paths (usually one, multiple for multi-collection with group_by="collection")
        """
        if group_by == "type":
            # Group by file type: pdf/, tei/, versions/
            if file_meta.file_type == 'pdf':
                subdir = "pdf"
            elif file_meta.version is not None and file_meta.version > 1:
                subdir = "versions"
            else:
                subdir = "tei"

            return [target_path / subdir / filename]

        elif group_by == "collection":
            # Group by collection: collection/pdf/, collection/tei/, collection/versions/
            paths = []

            # Get collections (may be multiple)
            collections = file_meta.doc_collections if file_meta.doc_collections else ["uncategorized"]

            for collection in collections:
                # Determine subdirectory based on file type
                if file_meta.file_type == 'pdf':
                    subdir = "pdf"
                elif file_meta.version is not None and file_meta.version > 1:
                    subdir = "versions"
                else:
                    subdir = "tei"

                paths.append(target_path / collection / subdir / filename)

            return paths

        elif group_by == "variant":
            # Group by variant: pdf/ for PDFs, variant_name/ for TEI files
            if file_meta.file_type == 'pdf':
                return [target_path / "pdf" / filename]
            else:
                variant_name = file_meta.variant or "default"
                return [target_path / variant_name / filename]

        else:
            raise ValueError(f"Invalid group_by: {group_by}")

    def _export_file(self, file_meta: FileMetadata, output_path: Path) -> None:
        """
        Export a single file to the specified path.

        Uses atomic write (write to temp, then rename).

        Args:
            file_meta: File metadata
            output_path: Destination path

        Raises:
            OSError: If file write fails
        """
        if self.dry_run:
            logger.info(f"[DRY RUN] Would export {file_meta.filename} to {output_path}")
            self.stats['files_exported'] += 1
            return

        # Read file content from storage
        content = self.storage.read_file(file_meta.id, file_meta.file_type)
        if content is None:
            raise FileNotFoundError(f"File not found in storage: {file_meta.id}")

        # Ensure parent directory exists
        output_path.parent.mkdir(parents=True, exist_ok=True)

        # Write atomically (temp file + rename)
        temp_path = output_path.with_suffix(output_path.suffix + '.tmp')

        try:
            temp_path.write_bytes(content)
            temp_path.rename(output_path)

            logger.debug(f"Exported {file_meta.filename} to {output_path}")
            self.stats['files_exported'] += 1

        except Exception as e:
            # Cleanup temp file on error
            if temp_path.exists():
                temp_path.unlink()
            raise
