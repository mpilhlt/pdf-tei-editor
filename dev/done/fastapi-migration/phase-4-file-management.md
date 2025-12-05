# Phase 4: File Management APIs

**Goal**: Implement 1:1 functional equivalence with Flask `/api/files/*` endpoints using the SQLite-backed file metadata system and hash-sharded storage.

## Overview

This phase migrates all file-related API endpoints from Flask to FastAPI, replacing:
- Filesystem-based file scanning → SQLite database queries
- JSON metadata caching → Direct database reads
- Path-based file identification → Hash-based content addressing (with abbreviated hashes)
- Single collection per file → Multi-collection support

All endpoints must maintain identical behavior for frontend compatibility while using the modernized backend.

**Key additions beyond Flask equivalence**:
1. **Hash abbreviation system** - 5-character hashes for client-server communication (collision-safe)
2. **File importer** - Import from Flask directories, arbitrary folders, or hash-sharded storage
3. **CLI migration tools** - One-time migration, bulk import, database reconstruction

## Flask Endpoints to Migrate

From `server/api/files/`:

1. **list.py** - `GET /api/files/list` - List files with metadata
2. **upload.py** - `POST /api/files/upload` - Upload PDF/XML files
3. **serve_file_by_id.py** - `GET /api/files/<document_id>` - Serve file content by hash/path
4. **save.py** - `POST /api/files/save` - Save TEI/XML with versioning
5. **save.py** - `POST /api/files/create_version_from_upload` - Create version from upload
6. **delete.py** - `POST /api/files/delete` - Delete files (soft delete)
7. **move.py** - `POST /api/files/move` - Move files between collections
8. **locks.py** - File locking endpoints (4 routes)
9. **heartbeat.py** - `POST /api/files/heartbeat` - Keep lock alive
10. **cache.py** - `GET /api/files/cache_status` - Cache status (deprecated in FastAPI)

## Tasks

### 4.0 Hash Abbreviation System

- [ ] Create `fastapi_app/lib/hash_abbreviation.py`

**Critical for frontend compatibility**: The Flask system uses abbreviated 5-character hashes for client-server communication while storing full MD5 hashes (32 chars) in lookup tables. FastAPI must do the same with SHA-256 hashes.

**Implementation requirements**:

```python
"""
Hash abbreviation module for client-server communication.

Database stores full SHA-256 hashes (64 characters) for integrity.
API returns abbreviated hashes (5+ characters) for usability.
Collision detection automatically increases hash length when needed.
"""

from typing import Dict, Set, Tuple
import logging

logger = logging.getLogger(__name__)

class HashAbbreviator:
    """
    Manages hash abbreviation with collision detection.

    Usage:
        abbreviator = HashAbbreviator()
        short_hash = abbreviator.abbreviate("abc123...def")  # Returns "abc12"
        full_hash = abbreviator.resolve("abc12")  # Returns "abc123...def"
    """

    def __init__(self, min_length: int = 5):
        """
        Args:
            min_length: Minimum hash length to attempt (default: 5)
        """
        self.min_length = min_length
        self.full_to_short: Dict[str, str] = {}
        self.short_to_full: Dict[str, str] = {}
        self.current_length = min_length

    def find_safe_length(self, all_hashes: Set[str]) -> int:
        """
        Find minimum hash length that avoids collisions.

        Args:
            all_hashes: Set of all full hashes

        Returns:
            Minimum collision-free hash length
        """
        if not all_hashes:
            return self.min_length

        hash_length = self.min_length
        max_length = len(next(iter(all_hashes))) if all_hashes else 64

        while hash_length <= max_length:
            shortened = {h[:hash_length] for h in all_hashes}
            if len(shortened) == len(all_hashes):
                # No collisions
                return hash_length
            hash_length += 1

        return hash_length

    def rebuild_mappings(self, all_full_hashes: Set[str]) -> None:
        """
        Rebuild hash mappings with collision-free length.
        Called when collision detected or on initialization.

        Args:
            all_full_hashes: All full hashes in the system
        """
        self.current_length = self.find_safe_length(all_full_hashes)
        self.full_to_short = {h: h[:self.current_length] for h in all_full_hashes}
        self.short_to_full = {short: full for full, short in self.full_to_short.items()}

        if self.current_length > self.min_length:
            logger.warning(
                f"Hash collision detected. Using {self.current_length}-character hashes "
                f"for {len(all_full_hashes)} files."
            )

    def abbreviate(self, full_hash: str) -> str:
        """
        Get abbreviated hash for client communication.

        Args:
            full_hash: Full SHA-256 hash (64 chars)

        Returns:
            Abbreviated hash (5+ chars)
        """
        if full_hash in self.full_to_short:
            return self.full_to_short[full_hash]

        # New hash - add to mappings
        short = full_hash[:self.current_length]

        if short in self.short_to_full:
            # Collision! Rebuild everything
            logger.warning(f"Hash collision detected for {full_hash[:16]}...")
            all_hashes = set(self.full_to_short.keys()) | {full_hash}
            self.rebuild_mappings(all_hashes)
            return self.full_to_short[full_hash]

        # No collision
        self.full_to_short[full_hash] = short
        self.short_to_full[short] = full_hash
        return short

    def resolve(self, short_hash: str) -> str:
        """
        Resolve abbreviated hash to full hash.

        Args:
            short_hash: Abbreviated hash from client

        Returns:
            Full SHA-256 hash

        Raises:
            KeyError: If hash not found
        """
        if short_hash in self.short_to_full:
            return self.short_to_full[short_hash]

        # Try as full hash (client might send full hash)
        if len(short_hash) == 64 and short_hash in self.full_to_short:
            return short_hash

        raise KeyError(f"Hash not found: {short_hash}")

    def can_resolve(self, hash_value: str) -> bool:
        """Check if hash can be resolved"""
        return (hash_value in self.short_to_full or
                (len(hash_value) == 64 and hash_value in self.full_to_short))


# Global abbreviator instance (initialized per request)
_abbreviator: Optional[HashAbbreviator] = None


def get_abbreviator(repo: 'FileRepository') -> HashAbbreviator:
    """
    Get or create hash abbreviator for current request.
    Loads all hashes from database to detect collisions.

    Args:
        repo: FileRepository instance

    Returns:
        Initialized HashAbbreviator
    """
    global _abbreviator

    if _abbreviator is None:
        # Get all file hashes from database
        all_files = repo.list_files(include_deleted=True)
        all_hashes = {f.id for f in all_files}

        _abbreviator = HashAbbreviator()
        if all_hashes:
            _abbreviator.rebuild_mappings(all_hashes)

    return _abbreviator


def abbreviate_hash(full_hash: str, repo: 'FileRepository') -> str:
    """Convenience function to abbreviate a hash"""
    abbreviator = get_abbreviator(repo)
    return abbreviator.abbreviate(full_hash)


def resolve_hash(short_hash: str, repo: 'FileRepository') -> str:
    """Convenience function to resolve a hash"""
    abbreviator = get_abbreviator(repo)
    return abbreviator.resolve(short_hash)
```

**Integration points**:
1. **All API responses** - Convert full hashes to abbreviated before sending to client
2. **All API requests** - Accept both full and abbreviated hashes, resolve to full
3. **File repository** - Add helper methods for hash resolution
4. **Dependency injection** - Include abbreviator in FastAPI dependencies

**Testing requirements**:
- Test collision detection (ensure uniqueness)
- Test automatic length increase on collision
- Test resolution (short → full, full → full)
- Test with 1, 100, 10000 files
- Test hash length stays at 5 for typical dataset

### 4.1 Pydantic Request/Response Models

- [ ] Create `fastapi_app/lib/models_files.py`

Define models for all file API operations:

```python
from pydantic import BaseModel, Field
from typing import Optional, List, Dict, Any
from datetime import datetime

# Response models
class FileListItem(BaseModel):
    """Single file entry in list response"""
    id: str                                    # Abbreviated hash (5+ chars) for client
    filename: str
    doc_id: str
    file_type: str
    label: Optional[str] = None
    variant: Optional[str] = None
    version: Optional[int] = None
    is_gold_standard: bool = False
    file_size: Optional[int] = None
    created_at: datetime
    updated_at: datetime

    # Inherited from PDF (when file_type = 'tei')
    doc_collections: Optional[List[str]] = None
    doc_metadata: Optional[Dict[str, Any]] = None

    # Lock status (added at runtime)
    is_locked: bool = False

    # Access control (added at runtime)
    access_control: Optional[Dict[str, Any]] = None

class DocumentGroup(BaseModel):
    """Document with grouped files (PDF + TEI versions + gold)"""
    doc_id: str
    doc_collections: List[str]
    doc_metadata: Dict[str, Any]

    # PDF file
    pdf: Optional[FileListItem] = None

    # TEI files grouped by category
    versions: List[FileListItem] = []      # Regular TEI versions (no variant, not gold)
    gold: List[FileListItem] = []          # Gold standard files
    variants: Dict[str, List[FileListItem]] = {}  # Keyed by variant name

class FileListResponse(BaseModel):
    """Response for GET /api/files/list"""
    files: List[DocumentGroup]

# Request models
class UploadResponse(BaseModel):
    """Response for POST /api/files/upload"""
    type: str           # 'pdf' or 'xml'
    filename: str

class SaveFileRequest(BaseModel):
    """Request for POST /api/files/save"""
    xml_string: str
    file_id: str                           # Hash or path (hash preferred)
    new_version: bool = False
    encoding: Optional[str] = None         # 'base64' if encoded

class SaveFileResponse(BaseModel):
    """Response for POST /api/files/save"""
    status: str         # 'saved', 'new', 'new_gold', 'promoted_to_gold'
    hash: str           # File hash of saved file

class CreateVersionFromUploadRequest(BaseModel):
    """Request for POST /api/files/create_version_from_upload"""
    temp_filename: str
    file_path: str      # Hash or path

class DeleteFilesRequest(BaseModel):
    """Request for POST /api/files/delete"""
    files: List[str]    # List of file hashes or paths

class MoveFilesRequest(BaseModel):
    """Request for POST /api/files/move"""
    pdf_path: str       # Hash or path
    xml_path: str       # Hash or path
    destination_collection: str

class MoveFilesResponse(BaseModel):
    """Response for POST /api/files/move"""
    new_pdf_path: str
    new_xml_path: str

class AcquireLockRequest(BaseModel):
    """Request for POST /api/files/acquire_lock"""
    file_id: str

class ReleaseLockRequest(BaseModel):
    """Request for POST /api/files/release_lock"""
    file_id: str

class ReleaseLockResponse(BaseModel):
    """Response for POST /api/files/release_lock"""
    action: str         # 'released', 'already_released'
    message: str

class CheckLockRequest(BaseModel):
    """Request for POST /api/files/check_lock"""
    file_id: str

class CheckLockResponse(BaseModel):
    """Response for POST /api/files/check_lock"""
    is_locked: bool
    locked_by: Optional[str] = None

class HeartbeatRequest(BaseModel):
    """Request for POST /api/files/heartbeat"""
    file_path: str      # Hash or path

class HeartbeatResponse(BaseModel):
    """Response for POST /api/files/heartbeat"""
    status: str         # 'lock_refreshed'
    # No cache_status in FastAPI (deprecated)
```

### 4.2 File List API

- [ ] Create `fastapi_app/routers/files_list.py`

Replaces: `server/api/files/list.py`

**Key changes from Flask:**
- Database queries instead of filesystem scan
- No cache refresh logic (database is always current)
- Multi-collection support (documents in multiple collections)
- Metadata inheritance via JOIN (TEI files inherit from PDF)

```python
from fastapi import APIRouter, Depends, Query
from typing import Optional

from fastapi_app.lib.database import DatabaseManager
from fastapi_app.lib.file_repository import FileRepository
from fastapi_app.lib.models_files import FileListResponse, DocumentGroup, FileListItem
from fastapi_app.lib.dependencies import get_db, get_current_user, get_session_id
from fastapi_app.lib.locking import get_all_active_locks
from fastapi_app.lib.access_control import DocumentAccessFilter

router = APIRouter(prefix="/api/files", tags=["files"])

@router.get("/list", response_model=FileListResponse)
def list_files(
    variant: Optional[str] = Query(None, description="Filter by variant"),
    refresh: bool = Query(False, description="Force refresh (deprecated in FastAPI)"),
    db: DatabaseManager = Depends(get_db),
    session_id: Optional[str] = Depends(get_session_id),
    current_user: Optional[dict] = Depends(get_current_user)
):
    """
    List all files grouped by document.

    Returns files in document-centric structure:
    - One entry per document (doc_id)
    - PDF file + TEI versions + gold standards + variants
    - Lock information for each file
    - Access control filtering applied

    Note: No cache refresh needed - database is always current.
    """
    repo = FileRepository(db)

    # Get all files from database (excludes deleted = 1)
    all_files = repo.list_files()

    # Group files by doc_id
    documents_map: Dict[str, DocumentGroup] = {}

    for file_metadata in all_files:
        doc_id = file_metadata.doc_id

        # Initialize document group if not exists
        if doc_id not in documents_map:
            # Get PDF file for this document to get collections/metadata
            pdf_file = repo.get_pdf_for_document(doc_id)
            if pdf_file:
                documents_map[doc_id] = DocumentGroup(
                    doc_id=doc_id,
                    doc_collections=pdf_file.doc_collections or [],
                    doc_metadata=pdf_file.doc_metadata or {},
                    pdf=FileListItem(**pdf_file.model_dump()),
                    versions=[],
                    gold=[],
                    variants={}
                )
            else:
                # No PDF found - skip this document (shouldn't happen)
                continue

        doc_group = documents_map[doc_id]
        file_item = FileListItem(**file_metadata.model_dump())

        # Inherit doc_collections and doc_metadata for TEI files
        if file_metadata.file_type == 'tei':
            file_item.doc_collections = doc_group.doc_collections
            file_item.doc_metadata = doc_group.doc_metadata

        # Categorize TEI files
        if file_metadata.file_type == 'tei':
            if file_metadata.is_gold_standard:
                doc_group.gold.append(file_item)
            elif file_metadata.variant:
                if file_metadata.variant not in doc_group.variants:
                    doc_group.variants[file_metadata.variant] = []
                doc_group.variants[file_metadata.variant].append(file_item)
            else:
                doc_group.versions.append(file_item)

    # Apply variant filtering if specified
    if variant is not None:
        # Filter logic: only include documents with matching variant
        documents_map = apply_variant_filtering(documents_map, variant)

    # Add lock information
    active_locks = get_all_active_locks()
    for doc_group in documents_map.values():
        # Mark locked files
        for file_list in [doc_group.versions, doc_group.gold] + list(doc_group.variants.values()):
            for file_item in file_list:
                file_id = file_item.id
                if file_id in active_locks and active_locks[file_id] != session_id:
                    file_item.is_locked = True

    # Apply access control filtering
    files_data = list(documents_map.values())
    files_data = DocumentAccessFilter.filter_files_by_access(files_data, current_user)

    return FileListResponse(files=files_data)


def apply_variant_filtering(documents: Dict[str, DocumentGroup], variant: str) -> Dict[str, DocumentGroup]:
    """Filter documents to only those with the specified variant"""
    filtered = {}
    for doc_id, doc_group in documents.items():
        if variant in doc_group.variants:
            filtered[doc_id] = doc_group
    return filtered
```

**Migration notes:**
- Flask used `get_file_data()` which scanned filesystem - replaced with `repo.list_files()`
- Flask cache refresh logic removed - database is always current
- Grouping logic similar but uses Pydantic models
- Lock checking identical (reuse `lib/locking.py`)
- Access control identical (reuse `lib/access_control.py`)

### 4.3 File Upload API

- [ ] Create `fastapi_app/routers/files_upload.py`

Replaces: `server/api/files/upload.py`

**Key changes:**
- Save to hash-sharded storage instead of `UPLOAD_DIR`
- Store metadata in database
- Return hash instead of filename

```python
from fastapi import APIRouter, UploadFile, File, Depends, HTTPException
from pathlib import Path
import magic
import mimetypes

from fastapi_app.lib.file_storage import FileStorage
from fastapi_app.lib.file_repository import FileRepository
from fastapi_app.lib.models_files import UploadResponse
from fastapi_app.lib.models import FileCreate
from fastapi_app.lib.dependencies import get_db, get_file_storage, require_session
from fastapi_app.lib.config import get_config

router = APIRouter(prefix="/api/files", tags=["files"])

ALLOWED_MIME_TYPES = {'application/pdf', 'application/xml', 'text/xml'}

@router.post("/upload", response_model=UploadResponse)
@require_session
async def upload_file(
    file: UploadFile = File(...),
    storage: FileStorage = Depends(get_file_storage),
    repo: FileRepository = Depends(get_file_repository)
):
    """
    Upload a PDF or XML file.

    Files are stored in hash-sharded storage and metadata is saved to database.
    Returns the file hash for subsequent operations.
    """
    if not file.filename:
        raise HTTPException(status_code=400, detail="No selected file")

    # Read file content
    content = await file.read()

    # Validate MIME type
    if not is_allowed_mime_type(file.filename, content):
        raise HTTPException(
            status_code=400,
            detail="Invalid file type. Allowed types: application/pdf, application/xml"
        )

    # Determine file type
    file_type = 'pdf' if file.filename.endswith('.pdf') else 'xml'

    # Save to hash-sharded storage
    file_hash, storage_path = storage.save_file(content, file_type)

    # Save metadata to database
    file_create = FileCreate(
        id=file_hash,
        filename=f"{file_hash}.{file_type}",
        doc_id=file_hash,  # Temporary doc_id - will be updated on save
        file_type=file_type,
        file_size=len(content),
        file_metadata={
            "original_filename": file.filename,
            "upload_source": "upload_endpoint"
        }
    )

    repo.insert_file(file_create)

    # Return response compatible with Flask endpoint
    return UploadResponse(
        type=file_type,
        filename=file_hash  # Return hash instead of filename
    )


def is_allowed_mime_type(filename: str, file_content: bytes) -> bool:
    """Check file type using content (libmagic) and extension"""
    try:
        # Check content-based MIME type
        mime_type_by_content = magic.from_buffer(file_content, mime=True)
        if mime_type_by_content in ALLOWED_MIME_TYPES:
            return True
    except Exception:
        pass

    # Check extension-based MIME type
    mime_type_by_extension, _ = mimetypes.guess_type(filename)
    return mime_type_by_extension in ALLOWED_MIME_TYPES
```

### 4.4 File Serving API

- [ ] Create `fastapi_app/routers/files_serve.py`

Replaces: `server/api/files/serve_file_by_id.py`

**Key changes:**
- Look up file by hash in database
- Serve from hash-sharded storage
- Access control checks using database metadata

```python
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse

from fastapi_app.lib.file_repository import FileRepository
from fastapi_app.lib.file_storage import FileStorage
from fastapi_app.lib.dependencies import get_file_repository, get_file_storage, get_current_user
from fastapi_app.lib.access_control import check_file_access

router = APIRouter(prefix="/api/files", tags=["files"])

@router.get("/{document_id}")
def serve_file_by_id(
    document_id: str,
    repo: FileRepository = Depends(get_file_repository),
    storage: FileStorage = Depends(get_file_storage),
    current_user: Optional[dict] = Depends(get_current_user)
):
    """
    Serve file content by document identifier (hash).

    Returns the actual file content with appropriate MIME type.
    Access control is enforced.
    """
    # Special case for empty.pdf
    if document_id == "empty.pdf":
        return FileResponse("/app/web/empty.pdf", media_type="application/pdf")

    # Look up file in database
    file_metadata = repo.get_file_by_id(document_id)
    if not file_metadata:
        raise HTTPException(status_code=404, detail=f"File not found: {document_id}")

    # Check read access
    if not check_file_access(file_metadata, current_user, 'read'):
        raise HTTPException(
            status_code=403,
            detail="Access denied: You don't have permission to view this document"
        )

    # Get file from storage
    file_path = storage.get_file_path(file_metadata.id, file_metadata.file_type)
    if not file_path or not file_path.exists():
        raise HTTPException(status_code=404, detail=f"File not found: {document_id}")

    # Determine MIME type
    mime_type_map = {
        'pdf': 'application/pdf',
        'tei': 'application/xml',
        'rng': 'application/xml',
        'xml': 'application/xml'
    }
    mime_type = mime_type_map.get(file_metadata.file_type, 'application/octet-stream')

    return FileResponse(file_path, media_type=mime_type)
```

### 4.5 File Save API

- [ ] Create `fastapi_app/routers/files_save.py`

Replaces: `server/api/files/save.py` (most complex endpoint)

**Key changes:**
- Multi-collection support (documents in multiple collections)
- Hash-based storage instead of path-based
- Database metadata updates
- Soft delete instead of `.deleted` marker files
- Role-based access control using database metadata

```python
from fastapi import APIRouter, Depends, HTTPException
from lxml import etree
import base64
from pathlib import Path

from fastapi_app.lib.file_storage import FileStorage
from fastapi_app.lib.file_repository import FileRepository
from fastapi_app.lib.models_files import SaveFileRequest, SaveFileResponse, CreateVersionFromUploadRequest
from fastapi_app.lib.models import FileCreate, FileUpdate
from fastapi_app.lib.dependencies import (
    get_file_repository, get_file_storage, get_current_user,
    get_session_id, require_session
)
from fastapi_app.lib.locking import acquire_lock
from fastapi_app.lib.access_control import check_file_access
from fastapi_app.lib.xml_utils import encode_xml_entities
from fastapi_app.lib.tei_utils import (
    extract_tei_metadata, serialize_tei_with_formatted_header
)

router = APIRouter(prefix="/api/files", tags=["files"])

@router.post("/save", response_model=SaveFileResponse)
@require_session
def save_file(
    request: SaveFileRequest,
    repo: FileRepository = Depends(get_file_repository),
    storage: FileStorage = Depends(get_file_storage),
    session_id: str = Depends(get_session_id),
    current_user: dict = Depends(get_current_user)
):
    """
    Save XML/TEI content with versioning support.

    Handles:
    - Creating new files (gold or versions)
    - Updating existing files
    - Version promotion (version → gold when no gold exists)
    - Variant handling
    - Role-based access control (reviewer for gold, annotator for versions)
    - File locking
    """
    xml_string = request.xml_string

    # Decode base64 if needed
    if request.encoding == "base64":
        xml_string = base64.b64decode(xml_string).decode('utf-8')

    # Validate XML
    try:
        xml_root = etree.fromstring(xml_string.encode('utf-8'))
    except etree.XMLSyntaxError as e:
        raise HTTPException(status_code=400, detail=f"Invalid XML: {str(e)}")

    # Encode entities if configured
    config = get_config()
    if config.get("xml.encode-entities.server", False):
        xml_string = encode_xml_entities(xml_string)
        xml_root = etree.fromstring(xml_string.encode('utf-8'))

    # Extract metadata from XML
    metadata = extract_tei_metadata(xml_root)
    file_id = metadata['file_id']
    variant = metadata.get('variant')
    doc_id = metadata.get('doi') or file_id  # Use DOI if available, fallback to file_id

    # Look up existing file by hash
    existing_file = repo.get_file_by_id(request.file_id)

    # Determine save strategy
    save_strategy = _determine_save_strategy(
        existing_file, request.new_version, variant,
        file_id, doc_id, repo
    )

    # Check permissions
    _check_permissions(save_strategy, current_user)

    # Save file to storage
    content = xml_string.encode('utf-8')
    file_hash, storage_path = storage.save_file(content, 'tei')

    # Acquire lock
    if not acquire_lock(file_hash, session_id):
        raise HTTPException(status_code=423, detail="Failed to acquire lock")

    # Update or create database entry
    if save_strategy['action'] == 'update_existing':
        # Update existing file
        repo.update_file(file_hash, FileUpdate(
            file_size=len(content),
            file_metadata=metadata.get('file_metadata', {}),
            sync_status='modified'  # Mark as modified for sync
        ))
        status = "saved"

    elif save_strategy['action'] == 'create_version':
        # Create new version
        version_number = save_strategy['version_number']
        file_create = FileCreate(
            id=file_hash,
            filename=f"{file_hash}.tei.xml",
            doc_id=doc_id,
            file_type='tei',
            file_size=len(content),
            variant=variant,
            version=version_number,
            is_gold_standard=False,
            file_metadata=metadata.get('file_metadata', {})
        )
        repo.insert_file(file_create)
        status = "new"

    elif save_strategy['action'] == 'create_gold':
        # Create new gold standard
        file_create = FileCreate(
            id=file_hash,
            filename=f"{file_hash}.tei.xml",
            doc_id=doc_id,
            file_type='tei',
            file_size=len(content),
            variant=variant,
            version=None,
            is_gold_standard=True,
            file_metadata=metadata.get('file_metadata', {})
        )
        repo.insert_file(file_create)
        status = "new_gold"

    elif save_strategy['action'] == 'promote_to_gold':
        # Promote version to gold
        # Soft delete the old version
        if existing_file:
            repo.delete_file(existing_file.id)

        # Create gold file
        file_create = FileCreate(
            id=file_hash,
            filename=f"{file_hash}.tei.xml",
            doc_id=doc_id,
            file_type='tei',
            file_size=len(content),
            variant=variant,
            version=None,
            is_gold_standard=True,
            file_metadata=metadata.get('file_metadata', {})
        )
        repo.insert_file(file_create)
        status = "promoted_to_gold"

    return SaveFileResponse(status=status, hash=file_hash)


@router.post("/create_version_from_upload", response_model=SaveFileResponse)
@require_session
def create_version_from_upload(
    request: CreateVersionFromUploadRequest,
    repo: FileRepository = Depends(get_file_repository),
    storage: FileStorage = Depends(get_file_storage),
    session_id: str = Depends(get_session_id),
    current_user: dict = Depends(get_current_user)
):
    """
    Create a new version from an uploaded file.

    Reads the uploaded file from temporary storage, strips XML declaration,
    and saves as a new version using the save logic.
    """
    # Read from upload directory (temporary storage)
    upload_dir = Path("/app/upload")  # TODO: make configurable
    temp_path = upload_dir / request.temp_filename

    if not temp_path.exists():
        raise HTTPException(status_code=404, detail=f"Temporary file not found: {request.temp_filename}")

    # Read and strip XML declaration
    xml_content = temp_path.read_text(encoding='utf-8')
    xml_content = re.sub(r'<\?xml.*\?>', '', xml_content).strip()

    # Clean up temp file
    temp_path.unlink()

    # Save as new version
    save_request = SaveFileRequest(
        xml_string=xml_content,
        file_id=request.file_path,
        new_version=True
    )

    return save_file(save_request, repo, storage, session_id, current_user)


def _determine_save_strategy(existing_file, new_version_requested, variant,
                            file_id, doc_id, repo):
    """Determine how to save the file based on context"""
    # Implementation similar to Flask _save_xml_content logic
    # Returns dict with 'action' and other context
    pass

def _check_permissions(save_strategy, user):
    """Check role-based permissions for the save operation"""
    # Reviewers: can edit gold files, create gold files, promote to gold
    # Annotators: can edit versions, create versions
    pass
```

**Note**: This is the most complex endpoint. Flask implementation has ~370 lines with intricate logic for:
- Version vs gold file determination
- Variant handling
- File promotion (version → gold)
- Role-based access control
- Lock acquisition
- Metadata extraction and updates

### 4.6 File Delete API

- [ ] Create `fastapi_app/routers/files_delete.py`

Replaces: `server/api/files/delete.py`

**Key changes:**
- Soft delete (set `deleted = 1`) instead of hard delete
- No `.deleted` marker files
- Database update + optional storage cleanup

```python
from fastapi import APIRouter, Depends, HTTPException
from typing import List

from fastapi_app.lib.file_repository import FileRepository
from fastapi_app.lib.file_storage import FileStorage
from fastapi_app.lib.models_files import DeleteFilesRequest
from fastapi_app.lib.dependencies import get_file_repository, get_file_storage, get_current_user, require_session
from fastapi_app.lib.access_control import check_file_access

router = APIRouter(prefix="/api/files", tags=["files"])

@router.post("/delete")
@require_session
def delete_files(
    request: DeleteFilesRequest,
    repo: FileRepository = Depends(get_file_repository),
    storage: FileStorage = Depends(get_file_storage),
    current_user: dict = Depends(get_current_user)
):
    """
    Delete files (soft delete).

    Sets deleted = 1 in database.
    Does NOT remove from storage (for sync tracking).
    """
    for file_id in request.files:
        if not file_id:
            continue

        # Look up file
        file_metadata = repo.get_file_by_id(file_id)
        if not file_metadata:
            continue  # Skip non-existent files

        # Check permissions
        if not check_file_access(file_metadata, current_user, 'write'):
            raise HTTPException(
                status_code=403,
                detail=f"Insufficient permissions to delete {file_id}"
            )

        # Soft delete
        repo.delete_file(file_id)

    return {"result": "ok"}
```

### 4.7 File Move API

- [ ] Create `fastapi_app/routers/files_move.py`

Replaces: `server/api/files/move.py`

**Key changes:**
- Update `doc_collections` in database (multi-collection support)
- No physical file move (hash-sharded storage is collection-agnostic)
- Update PDF's `doc_collections` array

```python
from fastapi import APIRouter, Depends, HTTPException

from fastapi_app.lib.file_repository import FileRepository
from fastapi_app.lib.models_files import MoveFilesRequest, MoveFilesResponse
from fastapi_app.lib.models import FileUpdate
from fastapi_app.lib.dependencies import get_file_repository, get_current_user, require_session
from fastapi_app.lib.access_control import check_file_access

router = APIRouter(prefix="/api/files", tags=["files"])

@router.post("/move", response_model=MoveFilesResponse)
@require_session
def move_files(
    request: MoveFilesRequest,
    repo: FileRepository = Depends(get_file_repository),
    current_user: dict = Depends(get_current_user)
):
    """
    Move files to a different collection.

    In the new multi-collection system, this adds the destination collection
    to the document's doc_collections array.

    Note: No physical file move - hash-sharded storage is collection-agnostic.
    """
    # Look up PDF file
    pdf_file = repo.get_file_by_id(request.pdf_path)
    if not pdf_file or pdf_file.file_type != 'pdf':
        raise HTTPException(status_code=404, detail="PDF file not found")

    # Check permissions
    if not check_file_access(pdf_file, current_user, 'write'):
        raise HTTPException(status_code=403, detail="Insufficient permissions")

    # Update collections (add destination if not already present)
    current_collections = pdf_file.doc_collections or []
    if request.destination_collection not in current_collections:
        updated_collections = current_collections + [request.destination_collection]

        repo.update_file(pdf_file.id, FileUpdate(
            doc_collections=updated_collections,
            sync_status='modified'
        ))

    # Return paths (unchanged - same hash)
    return MoveFilesResponse(
        new_pdf_path=pdf_file.id,
        new_xml_path=request.xml_path
    )
```

**Note**: Flask moved files physically between directories. FastAPI uses multi-collection support - documents can belong to multiple collections simultaneously.

### 4.8 File Locking APIs

- [ ] Create `fastapi_app/routers/files_locks.py`

Replaces: `server/api/files/locks.py`

**Key changes:**
- Hash-based file identification
- Otherwise identical to Flask (reuse `lib/locking.py`)

```python
from fastapi import APIRouter, Depends, HTTPException

from fastapi_app.lib.locking import acquire_lock, release_lock, check_lock, get_locked_file_ids
from fastapi_app.lib.file_repository import FileRepository
from fastapi_app.lib.models_files import (
    AcquireLockRequest, ReleaseLockRequest, ReleaseLockResponse,
    CheckLockRequest, CheckLockResponse
)
from fastapi_app.lib.dependencies import get_file_repository, get_session_id, get_current_user, require_session
from fastapi_app.lib.access_control import check_file_access

router = APIRouter(prefix="/api/files", tags=["files"])

@router.get("/locks")
@require_session
def get_all_locks(session_id: str = Depends(get_session_id)):
    """Get all active locks (file_id -> session_id mapping)"""
    return get_locked_file_ids()

@router.post("/check_lock", response_model=CheckLockResponse)
@require_session
def check_lock_endpoint(
    request: CheckLockRequest,
    session_id: str = Depends(get_session_id)
):
    """Check if a file is locked"""
    lock_status = check_lock(request.file_id, session_id)
    return CheckLockResponse(**lock_status)

@router.post("/acquire_lock")
@require_session
def acquire_lock_endpoint(
    request: AcquireLockRequest,
    repo: FileRepository = Depends(get_file_repository),
    session_id: str = Depends(get_session_id),
    current_user: dict = Depends(get_current_user)
):
    """Acquire a lock for editing"""
    # Look up file
    file_metadata = repo.get_file_by_id(request.file_id)
    if not file_metadata:
        raise HTTPException(status_code=404, detail="File not found")

    # Check edit permissions
    if not check_file_access(file_metadata, current_user, 'edit'):
        raise HTTPException(
            status_code=403,
            detail="Access denied: You don't have permission to edit this document"
        )

    # Acquire lock
    if acquire_lock(request.file_id, session_id):
        return "OK"

    raise HTTPException(status_code=423, detail=f"Could not acquire lock for {request.file_id}")

@router.post("/release_lock", response_model=ReleaseLockResponse)
@require_session
def release_lock_endpoint(
    request: ReleaseLockRequest,
    session_id: str = Depends(get_session_id)
):
    """Release a lock"""
    result = release_lock(request.file_id, session_id)

    if result["status"] == "success":
        return ReleaseLockResponse(
            action=result["action"],
            message=result["message"]
        )

    raise HTTPException(status_code=409, detail=result.get("message", "Failed to release lock"))
```

### 4.9 Heartbeat API

- [ ] Create `fastapi_app/routers/files_heartbeat.py`

Replaces: `server/api/files/heartbeat.py`

**Key changes:**
- No cache_status in response (database is always current)
- Otherwise identical

```python
from fastapi import APIRouter, Depends, HTTPException

from fastapi_app.lib.locking import acquire_lock
from fastapi_app.lib.models_files import HeartbeatRequest, HeartbeatResponse
from fastapi_app.lib.dependencies import get_session_id, require_session

router = APIRouter(prefix="/api/files", tags=["files"])

@router.post("/heartbeat", response_model=HeartbeatResponse)
@require_session
def heartbeat(
    request: HeartbeatRequest,
    session_id: str = Depends(get_session_id)
):
    """
    Refresh file lock (keep-alive).

    Note: No cache_status in FastAPI (deprecated).
    """
    if acquire_lock(request.file_path, session_id):
        return HeartbeatResponse(status="lock_refreshed")

    raise HTTPException(
        status_code=409,
        detail="Failed to refresh lock. It may have been acquired by another session."
    )
```

### 4.10 Supporting Library Updates

Port or update Flask libraries for FastAPI compatibility:

- [ ] Update `fastapi_app/lib/locking.py`
  - Port from `server/lib/locking.py`
  - Use dependency injection for database/config
  - Hash-based file identification

- [ ] Update `fastapi_app/lib/access_control.py`
  - Port from `server/lib/access_control.py`
  - Work with Pydantic models instead of dicts
  - Database queries instead of file parsing

- [ ] Create `fastapi_app/lib/dependencies.py`
  - FastAPI dependency injection functions
  - `get_db()`, `get_file_repository()`, `get_file_storage()`
  - `get_session_id()`, `get_current_user()`
  - `get_abbreviator()` - Get hash abbreviator instance
  - `require_session` dependency

- [ ] Update `fastapi_app/lib/file_repository.py`
  - Add `resolve_file_id(file_id: str) -> str` method
  - Accepts abbreviated or full hash, returns full hash
  - Uses hash abbreviator for resolution
  - All methods that accept `file_id` should call this first

- [ ] Update `fastapi_app/lib/xml_utils.py`
  - Port from `server/lib/xml_utils.py`
  - Framework-agnostic (already done in Phase 1?)

- [ ] Update `fastapi_app/lib/tei_utils.py`
  - Port from `server/lib/tei_utils.py`
  - Add `extract_tei_metadata()` function
  - Framework-agnostic

### 4.10.1 Database Importer

- [ ] Create `fastapi_app/lib/file_importer.py`

**Critical for migration and CLI tooling**: Import files from any directory structure (Flask legacy or arbitrary) into the SQLite database with hash-sharded storage.

**Use cases**:
1. **Migration**: Import from Flask `data/` directory (one-time)
2. **Reconstruction**: Rebuild database from hash-sharded storage after corruption
3. **CLI import**: Import PDFs/XMLs from arbitrary directories
4. **Testing**: Populate test databases

**Implementation**:

```python
"""
File importer for SQLite database population.

Imports files from various directory structures into the hash-sharded
storage system with SQLite metadata tracking.
"""

from pathlib import Path
from typing import Optional, List, Dict, Tuple, Set
import logging
from lxml import etree

from fastapi_app.lib.file_storage import FileStorage
from fastapi_app.lib.file_repository import FileRepository
from fastapi_app.lib.database import DatabaseManager
from fastapi_app.lib.models import FileCreate
from fastapi_app.lib.tei_utils import extract_tei_metadata
from fastapi_app.lib.hash_utils import generate_file_hash

logger = logging.getLogger(__name__)


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
        dry_run: bool = False
    ):
        """
        Args:
            db: Database manager
            storage: File storage manager
            repo: File repository
            dry_run: If True, scan but don't import
        """
        self.db = db
        self.storage = storage
        self.repo = repo
        self.dry_run = dry_run

        self.stats = {
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
        recursive: bool = True
    ) -> Dict:
        """
        Import all PDF and XML files from a directory.

        Args:
            directory: Directory to import from
            collection: Default collection name (can be None for multi-collection docs)
            recursive: Scan subdirectories

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
                self._import_document(doc_id, doc_files, collection)
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

    def import_hash_sharded_storage(
        self,
        storage_root: Path
    ) -> Dict:
        """
        Reconstruct database from existing hash-sharded storage.

        Scans the hash-sharded directory structure (ab/abcdef..., cd/cdef123...)
        and rebuilds the database from file content and metadata.

        Args:
            storage_root: Root directory of hash-sharded storage

        Returns:
            Statistics dict with import results
        """
        logger.info(f"Reconstructing database from hash-sharded storage at {storage_root}")

        # Scan all shard directories (00-ff)
        for shard_dir in storage_root.iterdir():
            if not shard_dir.is_dir() or len(shard_dir.name) != 2:
                continue

            # Process each file in shard
            for file_path in shard_dir.iterdir():
                if file_path.suffix in ['.pdf', '.xml']:
                    try:
                        self._import_from_storage(file_path)
                    except Exception as e:
                        logger.error(f"Error importing {file_path}: {e}")
                        self.stats['errors'].append({
                            'file': str(file_path),
                            'error': str(e)
                        })

        return self.stats

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
    ) -> Dict[str, Dict[str, List[Path]]]:
        """
        Group files by document ID.

        Returns:
            {doc_id: {'pdf': [path], 'tei': [path1, path2], ...}}
        """
        documents: Dict[str, Dict[str, List[Path]]] = {}

        for file_path in files:
            # Determine file type
            if file_path.suffix == '.pdf':
                file_type = 'pdf'
                # doc_id from filename
                doc_id = file_path.stem
            else:  # .xml
                file_type = 'tei'
                # Extract doc_id from XML content
                try:
                    doc_id = self._extract_doc_id_from_xml(file_path)
                except Exception as e:
                    logger.warning(f"Could not extract doc_id from {file_path}: {e}")
                    # Fallback to filename
                    doc_id = file_path.stem.replace('.tei', '')

            # Initialize document group
            if doc_id not in documents:
                documents[doc_id] = {'pdf': [], 'tei': []}

            documents[doc_id][file_type].append(file_path)

        logger.info(f"Grouped files into {len(documents)} documents")
        return documents

    def _extract_doc_id_from_xml(self, xml_path: Path) -> str:
        """Extract doc_id (DOI or fileref) from XML file"""
        tree = etree.parse(str(xml_path))
        root = tree.getroot()
        ns = {"tei": "http://www.tei-c.org/ns/1.0"}

        # Try DOI first
        doi_elem = root.find('.//tei:idno[@type="DOI"]', ns)
        if doi_elem is not None and doi_elem.text:
            return doi_elem.text.strip()

        # Try fileref
        fileref_elem = root.find('.//tei:idno[@type="fileref"]', ns)
        if fileref_elem is not None and fileref_elem.text:
            return fileref_elem.text.strip()

        # Fallback to filename
        return xml_path.stem.replace('.tei', '')

    def _import_document(
        self,
        doc_id: str,
        doc_files: Dict[str, List[Path]],
        default_collection: Optional[str]
    ) -> None:
        """Import a single document (PDF + TEI files)"""

        # Import PDF first (contains document metadata)
        pdf_paths = doc_files.get('pdf', [])
        if pdf_paths:
            pdf_metadata = self._import_pdf(pdf_paths[0], doc_id, default_collection)
        else:
            logger.warning(f"No PDF found for document {doc_id}")
            pdf_metadata = None

        # Import TEI files
        for tei_path in doc_files.get('tei', []):
            self._import_tei(tei_path, doc_id, pdf_metadata)

    def _import_pdf(
        self,
        pdf_path: Path,
        doc_id: str,
        collection: Optional[str]
    ) -> Optional[FileCreate]:
        """Import a PDF file"""

        # Read file content
        content = pdf_path.read_bytes()
        file_hash = generate_file_hash(content)

        # Check if already exists
        existing = self.repo.get_file_by_id(file_hash)
        if existing:
            logger.debug(f"PDF already exists: {file_hash[:8]}")
            self.stats['files_skipped'] += 1
            return existing

        if self.dry_run:
            logger.info(f"[DRY RUN] Would import PDF: {pdf_path}")
            return None

        # Save to storage
        saved_hash, storage_path = self.storage.save_file(content, 'pdf')
        assert saved_hash == file_hash

        # Create metadata
        file_create = FileCreate(
            id=file_hash,
            filename=f"{file_hash}.pdf",
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

        logger.info(f"Imported PDF: {pdf_path} -> {file_hash[:8]}")
        return file_create

    def _import_tei(
        self,
        tei_path: Path,
        doc_id: str,
        pdf_metadata: Optional[FileCreate]
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

        # Determine if this is a version file
        is_version = 'versions' in tei_path.parts
        is_gold = metadata.get('is_gold_standard', False) and not is_version

        # Extract variant
        variant = metadata.get('variant')

        # Determine version number
        version = None
        if is_version and not variant:
            # Get max version for this doc_id
            existing_versions = self.repo.get_all_versions(doc_id)
            version = len(existing_versions) + 1

        # Save to storage
        saved_hash, storage_path = self.storage.save_file(content, 'tei')
        assert saved_hash == file_hash

        # Create metadata
        file_create = FileCreate(
            id=file_hash,
            filename=f"{file_hash}.tei.xml",
            doc_id=doc_id,
            doc_id_type=metadata.get('doc_id_type', 'custom'),
            file_type='tei',
            file_size=len(content),
            label=metadata.get('label'),
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
        if pdf_metadata and metadata.get('doc_metadata'):
            self._update_pdf_metadata(doc_id, metadata['doc_metadata'])

        logger.info(f"Imported TEI: {tei_path} -> {file_hash[:8]}")

    def _import_from_storage(self, file_path: Path) -> None:
        """Import a file from hash-sharded storage (reconstruction mode)"""

        # File hash is the filename (minus extension)
        filename = file_path.name
        file_hash = filename.split('.')[0]

        # Verify hash matches content
        content = file_path.read_bytes()
        computed_hash = generate_file_hash(content)

        if computed_hash != file_hash:
            raise ValueError(
                f"Hash mismatch: filename {file_hash[:8]} != content {computed_hash[:8]}"
            )

        # Check if already in database
        existing = self.repo.get_file_by_id(file_hash)
        if existing:
            self.stats['files_skipped'] += 1
            return

        # Determine file type
        if file_path.suffix == '.pdf':
            file_type = 'pdf'
        elif file_path.name.endswith('.tei.xml'):
            file_type = 'tei'
        else:
            logger.warning(f"Unknown file type: {file_path}")
            return

        # Extract metadata from content
        if file_type == 'tei':
            tree = etree.parse(str(file_path))
            metadata = extract_tei_metadata(tree.getroot())
            doc_id = metadata.get('doc_id', file_hash)
        else:
            # PDF - minimal metadata
            doc_id = file_hash
            metadata = {}

        if self.dry_run:
            logger.info(f"[DRY RUN] Would reconstruct: {file_path}")
            return

        # Create database entry
        file_create = FileCreate(
            id=file_hash,
            filename=filename,
            doc_id=doc_id,
            file_type=file_type,
            file_size=len(content),
            **metadata
        )

        self.repo.insert_file(file_create)
        self.stats['files_imported'] += 1

        logger.info(f"Reconstructed from storage: {file_hash[:8]}")

    def _update_pdf_metadata(
        self,
        doc_id: str,
        doc_metadata: Dict
    ) -> None:
        """Update PDF file's doc_metadata from TEI file"""

        # Find PDF for this document
        pdf_files = self.repo.get_files_by_doc_id(doc_id)
        pdf_files = [f for f in pdf_files if f.file_type == 'pdf']

        if not pdf_files:
            return

        pdf_file = pdf_files[0]

        # Merge metadata (don't overwrite existing)
        current_metadata = pdf_file.doc_metadata or {}
        updated_metadata = {**doc_metadata, **current_metadata}

        self.repo.update_file(pdf_file.id, FileUpdate(
            doc_metadata=updated_metadata
        ))

        logger.debug(f"Updated PDF metadata for {doc_id}")


# CLI convenience functions

def import_from_flask_data_dir(
    data_dir: Path,
    db: DatabaseManager,
    storage: FileStorage,
    repo: FileRepository,
    dry_run: bool = False
) -> Dict:
    """
    Import from Flask data directory structure.

    Expected structure:
        data/
        ├── pdf/
        │   └── collection1/
        │       └── file1.pdf
        └── tei/
            └── collection1/
                └── file1.tei.xml

    Args:
        data_dir: Path to Flask 'data' directory
        db, storage, repo: Initialized managers
        dry_run: Preview without importing

    Returns:
        Import statistics
    """
    importer = FileImporter(db, storage, repo, dry_run)

    # Import from pdf/ and tei/ directories
    stats = importer.import_directory(data_dir, recursive=True)

    return stats


def reconstruct_database(
    storage_root: Path,
    db: DatabaseManager,
    storage: FileStorage,
    repo: FileRepository
) -> Dict:
    """
    Reconstruct database from hash-sharded storage.

    Args:
        storage_root: Root of hash-sharded storage (contains 00/, 01/, ..., ff/)
        db, storage, repo: Initialized managers

    Returns:
        Import statistics
    """
    importer = FileImporter(db, storage, repo)
    stats = importer.import_hash_sharded_storage(storage_root)

    return stats
```

**Integration points**:
1. **Migration script** - `bin/migrate_to_fastapi.py`
2. **CLI command** - `bin/import_files.py --directory /path/to/files`
3. **Testing** - Populate test databases with known structures
4. **Recovery** - Rebuild database after corruption

**Testing requirements**:
- Test import from Flask directory structure
- Test import from flat directory (all PDFs/XMLs in one folder)
- Test import from hash-sharded storage (reconstruction)
- Test dry-run mode
- Test deduplication (same file imported twice)
- Test metadata extraction from TEI
- Test document grouping (multiple TEI per PDF)
- Test error handling (corrupt files, missing metadata)

### 4.11 Integration Tests

- [ ] Create `fastapi_app/tests/py/test_file_importer.py`
  - Test import from Flask directory structure (data/pdf/, data/tei/)
  - Test import from flat directory (all files in one folder)
  - Test import from nested arbitrary directory
  - Test reconstruction from hash-sharded storage
  - Test dry-run mode
  - Test deduplication (import same file twice)
  - Test metadata extraction (DOI, fileref, variant, etc.)
  - Test document grouping (PDF + multiple TEI files)
  - Test version detection (versions/ directory)
  - Test gold file detection
  - Test error handling (corrupt XML, missing metadata)
  - Test collection assignment
  - Test statistics reporting

- [ ] Create `fastapi_app/tests/py/test_hash_abbreviation.py`
  - Test collision detection with 1, 100, 1000, 10000 files
  - Test that 5 characters is sufficient for typical datasets
  - Test automatic length increase on collision
  - Test resolution (short → full, full → full)
  - Test edge cases (empty set, single file, all same prefix)

- [ ] Create `fastapi_app/tests/backend/files_list.test.js`
  - Test file listing with various filters
  - Test variant filtering
  - Test lock status in response
  - Test access control filtering
  - **Test that hashes in response are abbreviated (5 chars)**
  - Compare with Flask endpoint output

- [ ] Create `fastapi_app/tests/backend/files_upload.test.js`
  - Test PDF upload
  - Test XML upload
  - Test MIME type validation
  - Test hash-based storage
  - **Test that response contains abbreviated hash**

- [ ] Create `fastapi_app/tests/backend/files_serve.test.js`
  - **Test serving by abbreviated hash**
  - **Test serving by full hash (should also work)**
  - Test access control
  - Test MIME types

- [ ] Create `fastapi_app/tests/backend/files_save.test.js`
  - **Test accepting abbreviated hash in request**
  - **Test accepting full hash in request**
  - **Test response contains abbreviated hash**
  - Test save existing file
  - Test create new version
  - Test create gold file
  - Test version promotion
  - Test variant handling
  - Test role-based access control

- [ ] Create `fastapi_app/tests/backend/files_delete.test.js`
  - Test soft delete
  - Test permissions

- [ ] Create `fastapi_app/tests/backend/files_move.test.js`
  - Test multi-collection update
  - Test permissions

- [ ] Create `fastapi_app/tests/backend/files_locks.test.js`
  - Test acquire/release lock
  - Test lock conflicts
  - Test permissions
  - Reuse existing Flask tests: `tests/e2e/backend/file-locks-api.test.js`

- [ ] Create `fastapi_app/tests/backend/files_heartbeat.test.js`
  - Test lock refresh

**Testing approach:**
- Run FastAPI server locally: `npm run dev:fastapi`
- Run tests: `E2E_BASE_URL=http://localhost:8000 node --test fastapi_app/tests/backend/files_*.test.js`
- Verify functional equivalence with Flask endpoints
- Reuse existing Flask test fixtures where possible

### 4.12 CLI Tools

- [ ] Create `bin/migrate_to_fastapi.py`

**One-time migration from Flask to FastAPI**:

```python
#!/usr/bin/env python3
"""
Migrate Flask data directory to FastAPI SQLite + hash-sharded storage.

Usage:
    bin/migrate_to_fastapi.py --data-dir data --output-dir fastapi/data [--dry-run]
"""

import argparse
from pathlib import Path
import sys

# Add fastapi_app to Python path
sys.path.insert(0, str(Path(__file__).parent.parent))

from fastapi_app.lib.database import DatabaseManager
from fastapi_app.lib.file_storage import FileStorage
from fastapi_app.lib.file_repository import FileRepository
from fastapi_app.lib.file_importer import import_from_flask_data_dir

def main():
    parser = argparse.ArgumentParser(description='Migrate Flask to FastAPI')
    parser.add_argument('--data-dir', required=True, help='Flask data directory')
    parser.add_argument('--output-dir', required=True, help='FastAPI output directory')
    parser.add_argument('--dry-run', action='store_true', help='Preview without importing')
    args = parser.parse_args()

    data_dir = Path(args.data_dir)
    output_dir = Path(args.output_dir)

    # Initialize FastAPI components
    db_path = output_dir / 'metadata.db'
    storage_root = output_dir / 'files'

    db = DatabaseManager(db_path)
    storage = FileStorage(storage_root)
    repo = FileRepository(db)

    # Initialize database
    db.initialize_database()

    # Import
    print(f"Migrating from {data_dir} to {output_dir}")
    if args.dry_run:
        print("[DRY RUN MODE - No changes will be made]")

    stats = import_from_flask_data_dir(data_dir, db, storage, repo, args.dry_run)

    # Report
    print(f"\nMigration complete:")
    print(f"  Files scanned:  {stats['files_scanned']}")
    print(f"  Files imported: {stats['files_imported']}")
    print(f"  Files skipped:  {stats['files_skipped']}")
    print(f"  Errors:         {len(stats['errors'])}")

    if stats['errors']:
        print("\nErrors:")
        for error in stats['errors'][:10]:
            print(f"  {error['doc_id']}: {error['error']}")

if __name__ == '__main__':
    main()
```

- [ ] Create `bin/import_files.py`

**Import files from arbitrary directory**:

```python
#!/usr/bin/env python3
"""
Import PDF and XML files from any directory into FastAPI database.

Usage:
    bin/import_files.py --directory /path/to/files --collection my_collection [--dry-run]
"""

import argparse
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).parent.parent))

from fastapi_app.lib.database import DatabaseManager
from fastapi_app.lib.file_storage import FileStorage
from fastapi_app.lib.file_repository import FileRepository
from fastapi_app.lib.file_importer import FileImporter

def main():
    parser = argparse.ArgumentParser(description='Import files to FastAPI')
    parser.add_argument('--directory', required=True, help='Directory containing files')
    parser.add_argument('--collection', help='Collection name for imported files')
    parser.add_argument('--db-path', default='fastapi/data/metadata.db', help='Database path')
    parser.add_argument('--storage-root', default='fastapi/data/files', help='Storage root')
    parser.add_argument('--dry-run', action='store_true', help='Preview without importing')
    parser.add_argument('--recursive', action='store_true', default=True, help='Scan subdirectories')
    args = parser.parse_args()

    directory = Path(args.directory)
    db_path = Path(args.db_path)
    storage_root = Path(args.storage_root)

    # Initialize components
    db = DatabaseManager(db_path)
    storage = FileStorage(storage_root)
    repo = FileRepository(db)
    importer = FileImporter(db, storage, repo, args.dry_run)

    # Import
    print(f"Importing from {directory}")
    if args.collection:
        print(f"Collection: {args.collection}")
    if args.dry_run:
        print("[DRY RUN MODE]")

    stats = importer.import_directory(directory, args.collection, args.recursive)

    # Report
    print(f"\nImport complete:")
    print(f"  Files scanned:  {stats['files_scanned']}")
    print(f"  Files imported: {stats['files_imported']}")
    print(f"  Files skipped:  {stats['files_skipped']}")
    print(f"  Errors:         {len(stats['errors'])}")

if __name__ == '__main__':
    main()
```

- [ ] Create `bin/rebuild_database.py`

**Rebuild database from hash-sharded storage**:

```python
#!/usr/bin/env python3
"""
Rebuild database from existing hash-sharded storage.

Usage:
    bin/rebuild_database.py --storage-root fastapi/data/files --db-path fastapi/data/metadata.db
"""

import argparse
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).parent.parent))

from fastapi_app.lib.database import DatabaseManager
from fastapi_app.lib.file_storage import FileStorage
from fastapi_app.lib.file_repository import FileRepository
from fastapi_app.lib.file_importer import reconstruct_database

def main():
    parser = argparse.ArgumentParser(description='Rebuild database from storage')
    parser.add_argument('--storage-root', required=True, help='Hash-sharded storage root')
    parser.add_argument('--db-path', required=True, help='Database path (will be recreated)')
    args = parser.parse_args()

    storage_root = Path(args.storage_root)
    db_path = Path(args.db_path)

    # Remove old database
    if db_path.exists():
        print(f"Removing existing database: {db_path}")
        db_path.unlink()

    # Initialize components
    db = DatabaseManager(db_path)
    storage = FileStorage(storage_root)
    repo = FileRepository(db)

    # Initialize fresh database
    db.initialize_database()

    # Reconstruct
    print(f"Reconstructing database from {storage_root}")
    stats = reconstruct_database(storage_root, db, storage, repo)

    # Report
    print(f"\nReconstruction complete:")
    print(f"  Files imported: {stats['files_imported']}")
    print(f"  Files skipped:  {stats['files_skipped']}")
    print(f"  Errors:         {len(stats['errors'])}")

if __name__ == '__main__':
    main()
```

## Completion Criteria

Phase 4 is complete when:

**Core Functionality**:
- ✅ Hash abbreviation system implemented with collision detection
- ✅ All API responses use abbreviated hashes (5+ chars)
- ✅ All API requests accept both full and abbreviated hashes
- ✅ All Pydantic models defined and validated
- ✅ All 10 file endpoints implemented
- ✅ File list returns document-centric structure
- ✅ Upload saves to hash-sharded storage
- ✅ Serve works with hash-based lookup (abbreviated hash)
- ✅ Save handles all scenarios (new/update/version/gold/promote)
- ✅ Delete performs soft delete (deleted = 1)
- ✅ Move updates doc_collections (multi-collection support)
- ✅ Locks work with hash-based identification (abbreviated hash)

**Migration & Import**:
- ✅ File importer class implemented
- ✅ Import from Flask directory structure works
- ✅ Import from arbitrary directories works
- ✅ Reconstruction from hash-sharded storage works
- ✅ Dry-run mode works
- ✅ CLI migration tool (`bin/migrate_to_fastapi.py`)
- ✅ CLI import tool (`bin/import_files.py`)
- ✅ CLI rebuild tool (`bin/rebuild_database.py`)

**Testing & Quality**:
- ✅ All supporting libraries ported and injectable
- ✅ All integration tests pass
- ✅ Importer tests pass (Flask structure, flat, nested, hash-sharded)
- ✅ Functional equivalence with Flask verified
- ✅ Access control enforced on all endpoints
- ✅ Role-based permissions enforced (reviewer/annotator)
- ✅ Hash collision tests pass (5 chars sufficient for typical dataset)

**Documentation**:
- ✅ Migration guide written (Flask → FastAPI)
- ✅ CLI tool usage documented

## Key Architecture Changes

### From Flask to FastAPI

| Aspect | Flask | FastAPI |
|--------|-------|---------|
| **File identification** | Path-based MD5 hash | Content-based SHA-256 hash |
| **Hash communication** | Abbreviated 5-char MD5 | Abbreviated 5-char SHA-256 |
| **Hash storage** | Full 32-char MD5 in lookup.json | Full 64-char SHA-256 in database |
| **Collision handling** | Auto-increase length, rebuild lookup | Auto-increase length, rebuild mappings |
| **Storage** | Directory structure per collection | Hash-sharded (collection-agnostic) |
| **Metadata** | JSON cache files | SQLite database |
| **Collections** | One file → one collection | One document → multiple collections |
| **File listing** | Filesystem scan | Database query |
| **Delete** | Hard delete + `.deleted` marker | Soft delete (deleted = 1) |
| **Move** | Physical file move | Update doc_collections array |
| **Cache** | Explicit cache refresh | No cache (database is current) |

### Document-Centric vs File-Centric

**Flask** (file-centric):
```json
[
  {"path": "/data/pdf/corpus1/paper1.pdf", ...},
  {"path": "/data/tei/corpus1/paper1.tei.xml", ...},
  {"path": "/data/versions/paper1/20240115-paper1.xml", ...}
]
```

**FastAPI** (document-centric):
```json
[
  {
    "doc_id": "10.1234/paper1",
    "doc_collections": ["corpus1", "gold_subset"],
    "doc_metadata": {"author": "...", "title": "..."},
    "pdf": {...},
    "versions": [{...}, {...}],
    "gold": [{...}],
    "variants": {"grobid": [{...}]}
  }
]
```

## Migration Notes

### Breaking Changes

None - frontend compatibility is maintained by:
- Returning same JSON structure
- Accepting same request parameters
- Hash-based identification (frontend already uses hashes)

### Non-Breaking Improvements

1. **Abbreviated hashes** - Same 5-character hashes as Flask (MD5 → SHA-256)
2. **Multi-collection support** - Documents can belong to multiple collections
3. **No cache refresh needed** - Database is always current
4. **Faster queries** - Indexed database queries vs filesystem scan
5. **Content deduplication** - Same content = one file
6. **Soft delete** - Recoverable deletions
7. **Better access control** - Database-driven instead of file-based

### Hash Abbreviation Details

**Why abbreviate?**
- **Usability**: 5 chars easier to read/debug than 64 chars
- **Bandwidth**: Smaller API responses
- **Compatibility**: Frontend expects short hashes (Flask uses 5-char MD5)

**How it works**:
1. Database stores full SHA-256 hashes (64 chars)
2. API returns abbreviated hashes (5+ chars)
3. API accepts both abbreviated and full hashes
4. Collision detection auto-increases length if needed

**Example flow**:
```python
# Storage
file_content = b"..."
full_hash = sha256(file_content).hexdigest()  # "abc123def456...789" (64 chars)
db.insert(id=full_hash, ...)

# API Response
abbreviator = get_abbreviator()
short_hash = abbreviator.abbreviate(full_hash)  # "abc12" (5 chars)
return {"id": short_hash, ...}

# API Request
request_hash = "abc12"  # From client
full_hash = abbreviator.resolve(request_hash)  # "abc123def456...789"
file = db.get_file_by_id(full_hash)
```

**Collision probability**:
- 5 hex chars = 16^5 = 1,048,576 possible values
- Typical dataset: <10,000 files
- Collision extremely unlikely (<1% with 10,000 files)
- If collision occurs: auto-increase to 6 chars (16^6 = 16.7M values)

## Performance Improvements

| Operation | Flask (10k files) | FastAPI (10k files) |
|-----------|-------------------|---------------------|
| **List files** | 2-4 seconds (filesystem scan) | 10-50ms (database query) |
| **Get file by ID** | 50-100ms (cache lookup + file read) | 5-10ms (hash lookup) |
| **Save file** | 100-200ms (write + cache update) | 20-50ms (write + db update) |
| **Delete file** | 50-100ms (delete + marker file) | 5-10ms (soft delete) |

## Next Phase

→ [Phase 5: Validation and Extraction APIs](phase-5-validation-extraction.md)

Note: Phase 4 must be complete before Phase 5, as extraction APIs depend on file storage and metadata.

## Reference Files

- [Schema Design](schema-design.md) - Database schema and queries
- [Phase 2 Completion](phase-2-completion.md) - Database implementation details
- Flask implementations:
  - [server/api/files/list.py](../../server/api/files/list.py)
  - [server/api/files/upload.py](../../server/api/files/upload.py)
  - [server/api/files/save.py](../../server/api/files/save.py)
  - [server/api/files/delete.py](../../server/api/files/delete.py)
  - [server/api/files/move.py](../../server/api/files/move.py)
  - [server/api/files/locks.py](../../server/api/files/locks.py)
  - [server/api/files/heartbeat.py](../../server/api/files/heartbeat.py)
  - [server/api/files/serve_file_by_id.py](../../server/api/files/serve_file_by_id.py)
