"""
File importer for SQLite database population.

Imports files from various directory structures into the hash-sharded
storage system with SQLite metadata tracking.
"""

from pathlib import Path
from typing import Optional, List, Dict, TypedDict
from datetime import datetime
import logging
import re
from lxml import etree

from .file_storage import FileStorage
from .file_repository import FileRepository
from .database import DatabaseManager
from .models import FileCreate, FileUpdate
from .tei_utils import extract_tei_metadata
from .hash_utils import generate_file_hash
from .doc_id_resolver import DocIdResolver
from .collection_utils import add_collection, load_entity_data
from ..config import get_settings

logger = logging.getLogger(__name__)


class ImportStats(TypedDict):
    """Statistics for file import operations."""
    files_scanned: int
    files_imported: int
    files_skipped: int
    files_updated: int
    errors: List[Dict[str, str]]


class DocumentFiles(TypedDict):
    """Files grouped by document."""
    pdf: List[Path]
    tei: List[Path]
    metadata: Dict[str, str]


class FileImporter:
    """
    Import files from directory structures into SQLite + hash-sharded storage.

    Usage:
        importer = FileImporter(db, storage, repo)
        stats = importer.import_directory("/path/to/data")
        print(f"Imported {stats['files_imported']} files")
    """

    def __init__(
        self,
        db: DatabaseManager,
        storage: FileStorage,
        repo: FileRepository,
        dry_run: bool = False,
        skip_collection_dirs: Optional[List[str]] = None,
        gold_dir_name: Optional[str] = None,
        gold_pattern: Optional[str] = None,
        version_pattern: Optional[str] = None,
        on_collection_created: Optional[callable] = None
    ):
        """
        Args:
            db: Database manager
            storage: File storage manager
            repo: File repository
            dry_run: If True, scan but don't import
            skip_collection_dirs: Directory names to skip when determining collection
                from path (e.g., ['pdf', 'tei', 'versions']). These are organizational
                directories that should not be used as collection names.
            gold_dir_name: Name of directory containing gold standard files (default: 'tei').
                Only used if gold_pattern is not specified.
            gold_pattern: Regular expression pattern to detect gold standard files.
                Can match either the full path or the filename. If matched in filename,
                the pattern is stripped before parsing doc_id. Default: matches files in
                a directory named 'tei' (platform-independent).
                Examples:
                  - '/tei/' - files in 'tei' directory (default behavior)
                  - r'\.gold\.' - files with '.gold.' in name (e.g., 'xyz.gold.tei.xml')
                  - '_gold_' - files with '_gold_' in name
            version_pattern: Regular expression pattern to detect and strip version markers
                from filenames for matching purposes. If matched in filename, the pattern
                is stripped before matching with PDF files.
                Examples:
                  - r'\.v\d+\.' - matches '.v1.', '.v2.', etc. (default)
                  - r'\.version\d+\.' - matches '.version1.', '.version2.', etc.
                Default: r'\.v\d+\.' (matches .v1., .v2., etc.)
        """
        self.db = db
        self.storage = storage
        self.repo = repo
        self.dry_run = dry_run
        self.resolver = DocIdResolver()
        self.gold_dir_name = gold_dir_name.lower() if gold_dir_name else None
        self.skip_collection_dirs = set(
            (name.lower() for name in skip_collection_dirs)
            if skip_collection_dirs else []
        )

        # Compile gold pattern regex
        if gold_pattern:
            try:
                self.gold_pattern = re.compile(gold_pattern)
            except re.error as e:
                logger.error(f"Invalid gold pattern '{gold_pattern}': {e}")
                raise ValueError(f"Invalid gold pattern: {e}")
        elif gold_dir_name:
            # If gold_dir_name is provided but no pattern, create directory pattern
            # Match /tei/ or \tei\ in path
            self.gold_pattern = re.compile(r'[/\\]' + re.escape(gold_dir_name) + r'[/\\]')
        else:
            # No pattern - use version marker logic instead
            self.gold_pattern = None

        # Compile version pattern regex
        if version_pattern:
            try:
                self.version_pattern = re.compile(version_pattern)
            except re.error as e:
                logger.error(f"Invalid version pattern '{version_pattern}': {e}")
                raise ValueError(f"Invalid version pattern: {e}")
        else:
            # Default: match .vN. pattern (.v1., .v2., etc.)
            self.version_pattern = re.compile(r'\.v\d+\.')

        # Callback when a collection is created (for granting user access)
        self.on_collection_created = on_collection_created

        self.stats: ImportStats = {
            'files_scanned': 0,
            'files_imported': 0,
            'files_skipped': 0,
            'files_updated': 0,
            'errors': []
        }

    def import_directory(
        self,
        directory: Path,
        collection: Optional[str] = None,
        recursive: bool = True,
        recursive_collections: bool = False
    ) -> ImportStats:
        """
        Import all PDF and XML files from a directory.

        Args:
            directory: Directory to import from
            collection: Default collection name (can be None for multi-collection docs)
            recursive: Scan subdirectories
            recursive_collections: If True, use subdirectory names as collection names.
                Files in root directory will have no collection assigned.

        Returns:
            Statistics dict with import results
        """
        logger.info(f"Starting import from {directory}")

        # Scan directory for files
        files = self._scan_directory(directory, recursive)

        # Group files by document
        documents = self._group_by_document(files, directory)

        # Import each document
        for doc_id, doc_files in documents.items():
            try:
                # Determine collection based on file location
                if recursive_collections:
                    # Use subdirectory name as collection
                    file_collection = self._get_collection_from_path(
                        doc_files, directory
                    )
                    # Fall back to explicit collection if path didn't yield one
                    if not file_collection:
                        file_collection = collection
                else:
                    # Use provided collection
                    file_collection = collection

                # Ensure files always have a collection
                if not file_collection:
                    file_collection = "_inbox"

                self._import_document(doc_id, doc_files, file_collection)
            except Exception as e:
                logger.error(f"Error importing document {doc_id}: {e}")
                self.stats['errors'].append({
                    'doc_id': doc_id,
                    'error': str(e)
                })

        logger.info(
            f"Import complete: {self.stats['files_imported']} imported, "
            f"{self.stats['files_skipped']} skipped, "
            f"{len(self.stats['errors'])} errors"
        )

        return self.stats

    def _get_collection_from_path(
        self,
        doc_files: DocumentFiles,
        base_directory: Path
    ) -> Optional[str]:
        """
        Determine collection name from file paths.

        Skips organizational directories (configured via skip_collection_dirs)
        and uses the first meaningful subdirectory name as the collection.

        Examples (with skip_collection_dirs=['pdf', 'tei', 'versions']):
            <root>/collection1/file.pdf -> "collection1"
            <root>/collection1/pdf/file.pdf -> "collection1"
            <root>/collection1/tei/file.xml -> "collection1"
            <root>/pdf/collection1/file.pdf -> "collection1"
            <root>/file.pdf -> None

        Args:
            doc_files: Document files dict with 'pdf' and 'tei' keys
            base_directory: Root directory being imported

        Returns:
            Collection name or None for files in root directory
        """
        # Get first available file path to determine location
        file_path = None
        if doc_files.get('pdf'):
            file_path = doc_files['pdf'][0]
        elif doc_files.get('tei'):
            file_path = doc_files['tei'][0]

        if not file_path:
            return None

        # Get relative path from base directory
        try:
            rel_path = file_path.relative_to(base_directory)
        except ValueError:
            # File is not under base_directory
            logger.warning(f"File {file_path} is not under {base_directory}")
            return None

        # Find first non-organizational directory
        parts = rel_path.parts[:-1]  # Exclude filename
        for part in parts:
            if part.lower() not in self.skip_collection_dirs:
                return part

        # No meaningful subdirectory found
        return None

    def _scan_directory(
        self,
        directory: Path,
        recursive: bool
    ) -> List[Path]:
        """Scan directory for PDF and XML files"""
        files = []

        pattern = "**/*" if recursive else "*"

        for path in directory.glob(pattern):
            if path.is_file() and path.suffix in ['.pdf', '.xml']:
                # Skip marker files
                if path.name.endswith('.deleted'):
                    continue

                # Skip macOS metadata files
                if '__MACOSX' in path.parts or path.name.startswith('._'):
                    continue

                files.append(path)
                self.stats['files_scanned'] += 1

        logger.info(f"Scanned {len(files)} files in {directory}")
        return files

    def _normalize_filename_for_matching(self, path: Path) -> Path:
        """
        Normalize filename for doc_id matching by stripping gold and version patterns.

        If gold pattern matches the filename, strip it for matching purposes.
        This allows 'xyz.gold.tei.xml' to match with 'xyz.pdf' when using
        filename-based gold detection.

        If version pattern matches the filename, strip it for matching purposes.
        This allows 'xyz.version1.tei.xml' and 'xyz.version2.tei.xml' to match
        with 'xyz.pdf' when using version patterns.

        Returns:
            Path with normalized filename for matching
        """
        filename = path.name
        cleaned_filename = filename

        # Strip gold pattern if present
        if self.gold_pattern and self.gold_pattern.search(cleaned_filename):
            cleaned_filename = self.gold_pattern.sub('', cleaned_filename)

        # Strip version pattern if present
        if self.version_pattern and self.version_pattern.search(cleaned_filename):
            cleaned_filename = self.version_pattern.sub('', cleaned_filename)

        # Return path with cleaned filename if anything changed
        if cleaned_filename != filename:
            return path.parent / cleaned_filename
        return path

    def _group_by_document(
        self,
        files: List[Path],
        base_path: Path
    ) -> Dict[str, DocumentFiles]:
        """
        Group files by document ID using intelligent matching.

        Uses DocIdResolver to match PDFs and TEIs even with different encodings.
        Normalizes filenames by stripping gold pattern before matching.

        Returns:
            {doc_id: {'pdf': [path], 'tei': [path1, path2], 'metadata': {...}}}
        """
        # Separate PDFs and TEIs
        pdf_files = [f for f in files if f.suffix == '.pdf']
        tei_files = [f for f in files if f.suffix == '.xml']

        # Normalize TEI filenames for matching (strip gold pattern if in filename)
        # Keep mapping from normalized to original paths
        tei_normalized_to_original: Dict[Path, Path] = {}
        tei_normalized = []
        for tei_path in tei_files:
            normalized = self._normalize_filename_for_matching(tei_path)
            tei_normalized.append(normalized)
            tei_normalized_to_original[normalized] = tei_path

        # First pass: Extract metadata from all TEI files (using original paths)
        tei_metadata: Dict[Path, Dict] = {}
        for tei_path in tei_files:
            try:
                tree = etree.parse(str(tei_path))
                metadata = extract_tei_metadata(tree.getroot())
                tei_metadata[tei_path] = metadata
            except Exception as e:
                logger.error(f"Failed to parse TEI {tei_path}: {e}")
                tei_metadata[tei_path] = {}

        # Create metadata dict keyed by normalized paths for resolver
        tei_metadata_normalized: Dict[Path, Dict] = {}
        for normalized_path in tei_normalized:
            original_path = tei_normalized_to_original[normalized_path]
            tei_metadata_normalized[normalized_path] = tei_metadata[original_path]

        # Second pass: Match PDFs to TEIs and resolve doc_ids
        documents: Dict[str, DocumentFiles] = {}

        for pdf_path in pdf_files:
            # Find matching TEI files for this PDF using normalized names
            matching_teis = self.resolver.find_matching_teis(
                pdf_path, tei_normalized, tei_metadata_normalized
            )

            # Resolve doc_id using all available information
            doc_id, doc_id_type = self.resolver.resolve_doc_id_for_pdf(
                pdf_path, matching_teis, tei_metadata_normalized
            )

            # Initialize document group
            if doc_id not in documents:
                documents[doc_id] = {
                    'pdf': [],
                    'tei': [],
                    'metadata': {
                        'doc_id_type': doc_id_type
                    }
                }

            documents[doc_id]['pdf'].append(pdf_path)

            # Add all matching TEIs to this document group (using original paths)
            for normalized_tei_path, metadata in matching_teis:
                original_tei_path = tei_normalized_to_original[normalized_tei_path]
                if original_tei_path not in documents[doc_id]['tei']:
                    documents[doc_id]['tei'].append(original_tei_path)

        # Third pass: Handle orphaned TEI files (no matching PDF)
        for tei_path in tei_files:
            metadata = tei_metadata.get(tei_path, {})

            # Check if this TEI is already in a document group
            already_grouped = False
            for doc_id, doc_files in documents.items():
                if tei_path in doc_files['tei']:
                    already_grouped = True
                    break

            if not already_grouped:
                # TEI without matching PDF - create standalone group
                doc_id, doc_id_type = self.resolver.resolve_doc_id_for_tei(metadata)

                if doc_id:
                    if doc_id not in documents:
                        documents[doc_id] = {
                            'pdf': [],
                            'tei': [],
                            'metadata': {
                                'doc_id_type': doc_id_type
                            }
                        }
                    documents[doc_id]['tei'].append(tei_path)
                else:
                    # No doc_id - use filename (normalized for gold pattern)
                    normalized_path = self._normalize_filename_for_matching(tei_path)
                    doc_id = normalized_path.stem.replace('.tei', '')
                    logger.warning(f"No doc_id for TEI {tei_path.name}, using filename: {doc_id}")
                    if doc_id not in documents:
                        documents[doc_id] = {
                            'pdf': [],
                            'tei': [],
                            'metadata': {
                                'doc_id_type': 'custom'
                            }
                        }
                    documents[doc_id]['tei'].append(tei_path)

        logger.info(f"Grouped files into {len(documents)} documents")
        return documents

    def _import_document(
        self,
        doc_id: str,
        doc_files: DocumentFiles,
        default_collection: Optional[str]
    ) -> None:
        """Import a single document (PDF + TEI files)"""

        # Auto-create collection if it doesn't exist
        if default_collection:
            try:
                settings = get_settings()
                db_dir = settings.db_dir
                collections_data = load_entity_data(db_dir, 'collections')

                # Check if collection exists
                collection_exists = any(
                    c.get('id') == default_collection
                    for c in collections_data
                )

                if not collection_exists:
                    # Create new collection with ID and name from directory name
                    success, message = add_collection(
                        db_dir,
                        collection_id=default_collection,
                        name=default_collection,
                        description=""
                    )
                    if success:
                        logger.info(f"Auto-created collection: {default_collection}")
                        # Notify callback so user can be granted access
                        if self.on_collection_created:
                            self.on_collection_created(default_collection)
                    else:
                        logger.warning(f"Failed to create collection '{default_collection}': {message}")
            except Exception as e:
                logger.error(f"Error checking/creating collection '{default_collection}': {e}")

        # Import PDF first (contains document metadata)
        pdf_paths = doc_files.get('pdf', [])
        pdf_file_id = None
        if pdf_paths:
            pdf_file_id = self._import_pdf(pdf_paths[0], doc_id, default_collection)
        else:
            logger.warning(f"No PDF found for document {doc_id}")

        # Import TEI files
        for tei_path in doc_files.get('tei', []):
            self._import_tei(tei_path, doc_id, pdf_file_id, default_collection)

    def _import_pdf(
        self,
        pdf_path: Path,
        doc_id: str,
        collection: Optional[str]
    ) -> Optional[str]:
        """Import a PDF file, returns file hash.

        Idempotent: if a PDF for this doc_id already exists with the same
        content, it is skipped. If the content differs, the existing entry
        is updated with the new content hash (the old physical file will be
        cleaned up on the next garbage collection).
        """

        # Read file content
        content = pdf_path.read_bytes()
        file_hash = generate_file_hash(content)

        if self.dry_run:
            logger.info(f"[DRY RUN] Would import PDF: {pdf_path}")
            return file_hash

        # Check for existing PDF with this doc_id
        existing_files = self.repo.get_files_by_doc_id(doc_id)
        existing_pdf = next(
            (f for f in existing_files if f.file_type == 'pdf' and not f.deleted),
            None
        )

        if existing_pdf:
            if existing_pdf.id == file_hash:
                # Identical content — skip, but ensure collection is assigned
                self._ensure_file_in_collection(existing_pdf, collection)
                logger.info(f"Skipping PDF (already exists): {pdf_path.name} -> {file_hash[:8]}")
                self.stats['files_skipped'] += 1
                return file_hash
            else:
                # Different content — update the existing entry with new hash
                logger.info(
                    f"Updating PDF (content changed): {pdf_path.name} "
                    f"{existing_pdf.id[:8]} -> {file_hash[:8]}"
                )
                # Ensure new content is in storage
                if not self.storage.file_exists(file_hash, 'pdf'):
                    self.storage.save_file(content, 'pdf', increment_ref=False)

                self.repo.update_file(existing_pdf.id, FileUpdate(
                    id=file_hash,
                    filename=pdf_path.name,
                    file_size=len(content),
                ))
                self.stats['files_updated'] += 1
                return file_hash

        # New PDF — save to storage and create database entry
        if not self.storage.file_exists(file_hash, 'pdf'):
            saved_hash, storage_path = self.storage.save_file(content, 'pdf', increment_ref=False)
            assert saved_hash == file_hash

        file_create = FileCreate(
            id=file_hash,
            filename=pdf_path.name,
            doc_id=doc_id,
            doc_id_type='custom',
            file_type='pdf',
            file_size=len(content),
            doc_collections=[collection] if collection else [],
            doc_metadata={},
            file_metadata={
                'original_path': str(pdf_path),
                'imported_at': datetime.now().isoformat()
            }
        )

        self.repo.insert_file(file_create)
        self.stats['files_imported'] += 1

        logger.info(f"Imported PDF: {pdf_path.name} -> {file_hash[:8]}")
        return file_hash

    def _import_tei(
        self,
        tei_path: Path,
        doc_id: str,
        pdf_file_id: Optional[str],
        collection: Optional[str] = None
    ) -> None:
        """Import a TEI/XML file.

        Idempotent: if a TEI with the same content hash already exists for
        this doc_id, the import is skipped. Different content creates a new
        version entry.
        """

        # Read file content
        content = tei_path.read_bytes()
        file_hash = generate_file_hash(content)

        # Parse TEI metadata first (needed to determine doc_id and variant for duplicate check)
        try:
            tree = etree.parse(str(tei_path))
            metadata = extract_tei_metadata(tree.getroot())
        except Exception as e:
            logger.error(f"Failed to parse TEI metadata from {tei_path}: {e}")
            metadata = {}

        # Use doc_id from metadata if available, otherwise use provided doc_id
        if metadata.get('doc_id'):
            doc_id = metadata['doc_id']
            doc_id_type = metadata.get('doc_id_type', 'doi')
        else:
            doc_id_type = 'custom'

        # Extract variant from TEI metadata
        variant = metadata.get('variant')

        if self.dry_run:
            logger.info(f"[DRY RUN] Would import TEI: {tei_path}")
            return

        # Check if a TEI with the same content hash already exists for this doc_id
        existing_files = self.repo.get_files_by_doc_id(doc_id)
        existing_tei = next(
            (f for f in existing_files if f.id == file_hash and f.file_type == 'tei'),
            None
        )
        if existing_tei:
            # Ensure collection is assigned even when skipping
            self._ensure_file_in_collection(existing_tei, collection)
            logger.info(f"Skipping TEI (already exists): {tei_path.name} -> {file_hash[:8]}")
            self.stats['files_skipped'] += 1
            return

        # Check if content already exists in storage (for deduplication)
        content_exists = self.storage.file_exists(file_hash, 'tei')

        # Determine if this is a gold standard file
        # Default: gold = file without .vN. version marker in filename
        # Can be overridden with gold_pattern (for legacy imports)
        filename = tei_path.name

        # Check for version marker (.v1., .v2., etc.)
        has_version_marker = bool(re.search(r'\.v\d+\.', filename))

        # If gold_pattern is provided, use it (for backward compatibility)
        # Otherwise, use version marker logic: no version = gold
        if self.gold_pattern:
            full_path_str = str(tei_path.as_posix())
            is_gold = bool(self.gold_pattern.search(full_path_str))

            # If pattern matches filename, strip it for doc_id determination
            # This allows patterns like '.gold.' to mark files and be stripped
            # e.g., 'xyz.gold.tei.xml' -> 'xyz.tei.xml' for doc_id parsing
            if self.gold_pattern.search(filename):
                # Strip pattern from filename for doc_id resolution
                cleaned_filename = self.gold_pattern.sub('', filename)
                logger.debug(f"Stripped gold pattern from filename: {filename} -> {cleaned_filename}")
        else:
            # Default behavior: files without version marker are gold
            is_gold = not has_version_marker
            logger.debug(f"Gold determination for {filename}: has_version_marker={has_version_marker}, is_gold={is_gold}")

        # Determine version number by counting existing files with same doc_id + variant
        # Version numbering is sequential: 0, 1, 2, 3...
        # The version number increments for each new file with the same (doc_id, variant),
        # regardless of gold status. Gold status is independent of version number.
        existing_files = self.repo.get_files_by_doc_id(doc_id)
        same_variant_files = [
            f for f in existing_files
            if f.file_type == 'tei'
            and f.variant == variant  # Match exact variant (including None)
        ]

        # Assign next version number (0 for first, 1 for second, etc.)
        version = len(same_variant_files)

        # Save to storage (deduplication happens at storage level)
        # Note: increment_ref=False because insert_file handles reference counting
        if not content_exists:
            saved_hash, storage_path = self.storage.save_file(content, 'tei', increment_ref=False)
            assert saved_hash == file_hash
        else:
            logger.debug(f"Content already in storage, creating new database entry: {file_hash[:8]}")

        # Create metadata
        # Prefer edition_title over label for display, with fallbacks
        label = metadata.get('edition_title') or metadata.get('label')

        # If no label or label is generic, fall back to doc_id or filename
        if not label or label.lower() in ['unknown title', 'untitled']:
            label = doc_id or tei_path.name

        file_create = FileCreate(
            id=file_hash,
            filename=tei_path.name,  # Preserve original filename
            doc_id=doc_id,
            doc_id_type=doc_id_type,
            file_type='tei',
            file_size=len(content),
            label=label,
            variant=variant,
            version=version,
            is_gold_standard=is_gold,
            doc_collections=[collection] if collection else [],
            file_metadata={
                'original_path': str(tei_path),
                'imported_at': datetime.now().isoformat(),
                **metadata.get('file_metadata', {})
            }
        )

        # Insert into database
        self.repo.insert_file(file_create)
        self.stats['files_imported'] += 1

        # Update PDF metadata if this is the first TEI file
        if pdf_file_id and metadata.get('doc_metadata'):
            self._update_pdf_metadata(pdf_file_id, doc_id, metadata['doc_metadata'])

        logger.info(f"Imported TEI: {tei_path.name} -> {file_hash[:8]}")

    def _format_pdf_label(self, doc_metadata: Dict, doc_id: str = None, filename: str = None) -> str:
        """
        Format PDF label as "Author (Year) Title..." with fallbacks.

        Priority:
        1. "Author (Year) Title..." if metadata available
        2. doc_id if no metadata
        3. filename if no doc_id

        Args:
            doc_metadata: Document metadata dict with title, authors, date
            doc_id: Document ID (DOI, etc.)
            filename: Filename as last resort

        Returns:
            Formatted label string
        """
        # Extract first author's family name
        authors = doc_metadata.get('authors', [])
        author_str = ""
        if authors and len(authors) > 0:
            first_author = authors[0]
            family = first_author.get('family', '')
            if family:
                author_str = family

        # Extract year from date
        date_str = doc_metadata.get('date', '')
        year_str = ""
        if date_str:
            # Try to extract 4-digit year
            import re
            year_match = re.search(r'\d{4}', str(date_str))
            if year_match:
                year_str = year_match.group(0)

        # Extract and truncate title
        title = doc_metadata.get('title', '')
        # Skip generic/placeholder titles
        if title and title.lower() not in ['unknown title', 'untitled', '']:
            max_title_len = 40
            if len(title) > max_title_len:
                title_str = title[:max_title_len] + "..."
            else:
                title_str = title
        else:
            title_str = None

        # Build label from metadata
        parts = []
        if author_str:
            parts.append(author_str)
        if year_str:
            parts.append(f"({year_str})")
        if title_str:
            parts.append(title_str)

        if parts:
            return " ".join(parts)

        # Fallback to doc_id or filename
        if doc_id:
            return doc_id
        if filename:
            # Remove extension for cleaner display
            import os
            return os.path.splitext(filename)[0]

        return "Untitled"

    def _update_pdf_metadata(
        self,
        pdf_file_id: str,
        doc_id: str,
        doc_metadata: Dict
    ) -> None:
        """Update PDF file's doc_metadata, doc_id, and label from TEI file"""

        # Get PDF file
        pdf_file = self.repo.get_file_by_id(pdf_file_id)
        if not pdf_file:
            return

        # Merge metadata (don't overwrite existing)
        current_metadata = pdf_file.doc_metadata or {}
        updated_metadata = {**doc_metadata, **current_metadata}

        # Generate formatted label for PDF (with fallbacks to doc_id or filename)
        pdf_label = self._format_pdf_label(updated_metadata, doc_id, pdf_file.filename)

        # Update metadata and label
        self.repo.update_file(pdf_file.id, FileUpdate(
            doc_metadata=updated_metadata,
            label=pdf_label
        ))

        logger.debug(f"Updated PDF metadata and label for {doc_id}: {pdf_label}")

    def _ensure_file_in_collection(self, file_meta, collection: Optional[str]) -> None:
        """Add collection to a file's doc_collections if not already present."""
        if not collection:
            return
        current = file_meta.doc_collections or []
        if collection not in current:
            updated = current + [collection]
            self.repo.update_file(file_meta.id, FileUpdate(doc_collections=updated))
            logger.info(
                f"Added collection '{collection}' to existing file {file_meta.id[:8]}"
            )
