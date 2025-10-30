"""
File importer for SQLite database population.

Imports files from various directory structures into the hash-sharded
storage system with SQLite metadata tracking.
"""

from pathlib import Path
from typing import Optional, List, Dict, TypedDict
from datetime import datetime
import logging
from lxml import etree

from .file_storage import FileStorage
from .file_repository import FileRepository
from .database import DatabaseManager
from .models import FileCreate, FileUpdate
from .tei_utils import extract_tei_metadata
from .hash_utils import generate_file_hash
from .doc_id_resolver import DocIdResolver

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
        gold_dir_name: str = 'tei'
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
            gold_dir_name: Name of directory containing gold standard files (default: 'tei')
        """
        self.db = db
        self.storage = storage
        self.repo = repo
        self.dry_run = dry_run
        self.resolver = DocIdResolver()
        self.gold_dir_name = gold_dir_name.lower()
        self.skip_collection_dirs = set(
            (name.lower() for name in skip_collection_dirs)
            if skip_collection_dirs else []
        )

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

        if recursive_collections and collection:
            logger.warning(
                f"Both --collection and --recursive-collections specified. "
                f"Ignoring --collection, using subdirectory names instead."
            )
            collection = None

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
                else:
                    # Use provided collection
                    file_collection = collection

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

                files.append(path)
                self.stats['files_scanned'] += 1

        logger.info(f"Scanned {len(files)} files in {directory}")
        return files

    def _group_by_document(
        self,
        files: List[Path],
        base_path: Path
    ) -> Dict[str, DocumentFiles]:
        """
        Group files by document ID using intelligent matching.

        Uses DocIdResolver to match PDFs and TEIs even with different encodings.

        Returns:
            {doc_id: {'pdf': [path], 'tei': [path1, path2], 'metadata': {...}}}
        """
        # Separate PDFs and TEIs
        pdf_files = [f for f in files if f.suffix == '.pdf']
        tei_files = [f for f in files if f.suffix == '.xml']

        # First pass: Extract metadata from all TEI files
        tei_metadata: Dict[Path, Dict] = {}
        for tei_path in tei_files:
            try:
                tree = etree.parse(str(tei_path))
                metadata = extract_tei_metadata(tree.getroot())
                tei_metadata[tei_path] = metadata
            except Exception as e:
                logger.error(f"Failed to parse TEI {tei_path}: {e}")
                tei_metadata[tei_path] = {}

        # Second pass: Match PDFs to TEIs and resolve doc_ids
        documents: Dict[str, DocumentFiles] = {}

        for pdf_path in pdf_files:
            # Find matching TEI files for this PDF
            matching_teis = self.resolver.find_matching_teis(
                pdf_path, tei_files, tei_metadata
            )

            # Resolve doc_id using all available information
            doc_id, doc_id_type = self.resolver.resolve_doc_id_for_pdf(
                pdf_path, matching_teis, tei_metadata
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

            # Add all matching TEIs to this document group
            for tei_path, metadata in matching_teis:
                if tei_path not in documents[doc_id]['tei']:
                    documents[doc_id]['tei'].append(tei_path)

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
                    # No doc_id - use filename
                    doc_id = tei_path.stem.replace('.tei', '')
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

        # Import PDF first (contains document metadata)
        pdf_paths = doc_files.get('pdf', [])
        pdf_file_id = None
        if pdf_paths:
            pdf_file_id = self._import_pdf(pdf_paths[0], doc_id, default_collection)
        else:
            logger.warning(f"No PDF found for document {doc_id}")

        # Import TEI files
        for tei_path in doc_files.get('tei', []):
            self._import_tei(tei_path, doc_id, pdf_file_id)

    def _import_pdf(
        self,
        pdf_path: Path,
        doc_id: str,
        collection: Optional[str]
    ) -> Optional[str]:
        """Import a PDF file, returns file hash"""

        # Read file content
        content = pdf_path.read_bytes()
        file_hash = generate_file_hash(content)

        # Check if already exists
        existing = self.repo.get_file_by_id(file_hash)
        if existing:
            logger.debug(f"PDF already exists: {file_hash[:8]}")
            self.stats['files_skipped'] += 1
            return file_hash

        if self.dry_run:
            logger.info(f"[DRY RUN] Would import PDF: {pdf_path}")
            return file_hash

        # Save to storage
        saved_hash, storage_path = self.storage.save_file(content, 'pdf')
        assert saved_hash == file_hash

        # Create metadata
        file_create = FileCreate(
            id=file_hash,
            filename=pdf_path.name,  # Preserve original filename
            doc_id=doc_id,
            doc_id_type='custom',  # Can be refined by TEI metadata
            file_type='pdf',
            file_size=len(content),
            doc_collections=[collection] if collection else [],
            doc_metadata={},  # Will be populated from TEI
            file_metadata={
                'original_path': str(pdf_path),
                'imported_at': datetime.now().isoformat()
            }
        )

        # Insert into database
        self.repo.insert_file(file_create)
        self.stats['files_imported'] += 1

        logger.info(f"Imported PDF: {pdf_path.name} -> {file_hash[:8]}")
        return file_hash

    def _import_tei(
        self,
        tei_path: Path,
        doc_id: str,
        pdf_file_id: Optional[str]
    ) -> None:
        """Import a TEI/XML file"""

        # Read file content
        content = tei_path.read_bytes()
        file_hash = generate_file_hash(content)

        # Check if already exists
        existing = self.repo.get_file_by_id(file_hash)
        if existing:
            logger.debug(f"TEI already exists: {file_hash[:8]}")
            self.stats['files_skipped'] += 1
            return

        if self.dry_run:
            logger.info(f"[DRY RUN] Would import TEI: {tei_path}")
            return

        # Parse TEI metadata
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

        # Determine if this is a gold standard file based on directory structure
        # IMPORTANT: This directory-based approach needs replacement before Phase 10
        # because it can lead to inconsistent state (no gold file for a variant).
        # If files are moved/imported from non-standard directories, we may end up
        # with variants that have no gold standard version.
        # TODO (Phase 10): Implement explicit gold marking in TEI metadata or use
        # a database migration to ensure exactly one gold per (doc_id, variant) pair.
        path_parts_lower = [p.lower() for p in tei_path.parts]
        is_in_gold_dir = self.gold_dir_name in path_parts_lower
        is_gold = is_in_gold_dir

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

        # Save to storage
        saved_hash, storage_path = self.storage.save_file(content, 'tei')
        assert saved_hash == file_hash

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
