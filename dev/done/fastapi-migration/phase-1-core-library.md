# Phase 1: Core Library Migration

**Goal**: Build framework-agnostic foundation using dependency injection

**Pattern**: Remove all Flask context dependencies (`current_app`, `g`, `request`) by passing configuration and resources as function parameters.

**Previous Implementation**: Archived in `old-fastapi/` directory - probably alot can be reused, but check carefully

## Dependency Injection Pattern

**Before (Flask-dependent)**:
```python
def load_hash_lookup():
    db_dir = current_app.config["DB_DIR"]
    current_app.logger.debug("Loading...")
```

**After (framework-agnostic)**:
```python
def load_hash_lookup(db_dir: Path, logger=None):
    if logger:
        logger.debug("Loading...")
```

## Tasks

### 1.1 Pure Utility Libraries

These have no Flask dependencies - direct port:

- [ ] Port `server/lib/xml_utils.py` → `fastapi/lib/xml_utils.py`
  - Functions: `encode_xml_entities()`
  - No changes needed

- [ ] Port `server/lib/tei_utils.py` → `fastapi/lib/tei_utils.py`
  - Functions: `create_tei_document()`, `create_tei_header()`, `serialize_tei_xml()`
  - No changes needed

### 1.2 Configuration Management

- [ ] Create `fastapi/lib/config_utils.py` from `server/lib/config_utils.py`
  - Add `db_dir: Path` parameter to all functions
  - Support flat string keys: `"session.timeout"`
  - Use file locking for thread safety

Functions:
```python
def load_full_config(db_dir: Path) -> dict
def get_config_value(key: str, db_dir: Path, default=None)
def set_config_value(key: str, value: Any, db_dir: Path)
def delete_config_value(key: str, db_dir: Path)
```

### 1.3 Authentication Core

- [ ] Create `fastapi/lib/auth.py` from `server/lib/auth.py`
  - Create `AuthManager` class
  - Keep SHA-256 password hashing for compatibility

```python
class AuthManager:
    def __init__(self, db_dir: Path, logger=None):
        self.db_dir = db_dir
        self.logger = logger

    def verify_password(self, username: str, passwd_hash: str) -> Optional[dict]:
        """Verify credentials and return user dict or None"""

    def get_user(self, username: str) -> Optional[dict]:
        """Get user by username"""

    def get_user_by_session_id(self, session_id: str) -> Optional[dict]:
        """Get user by session ID"""

    def cleanup_expired_sessions(self):
        """Remove expired sessions"""
```

### 1.4 Session Management - SQLite Based

**Important Change**: Migrate from JSON file storage to SQLite for better concurrency and performance.

- [ ] Create `fastapi/lib/db_utils.py` for database utilities
  - Database initialization
  - Connection management with context manager
  - Thread-safe connection pooling

- [ ] Create `fastapi/lib/sessions.py` with SQLite backend
  - Create `SessionManager` class
  - SQLite-based session storage (not JSON files)
  - Automatic session table creation
  - Indexed queries for performance

**Schema:**
```sql
CREATE TABLE IF NOT EXISTS sessions (
    session_id TEXT PRIMARY KEY,
    username TEXT NOT NULL,
    created_at REAL NOT NULL,
    last_access REAL NOT NULL,
    INDEX idx_username ON sessions(username),
    INDEX idx_last_access ON sessions(last_access)
);
```

**Implementation:**
```python
class SessionManager:
    def __init__(self, db_dir: Path, logger=None):
        self.db_dir = db_dir
        self.logger = logger
        self.db_path = db_dir / 'sessions.db'
        self._init_db()

    def _init_db(self):
        """Initialize sessions table"""

    def create_session(self, username: str) -> str:
        """Create new session, return UUID session ID"""

    def delete_session(self, session_id: str) -> bool:
        """Remove session"""

    def get_session(self, session_id: str) -> Optional[dict]:
        """Get session data"""

    def is_session_valid(self, session_id: str, timeout_seconds: int) -> bool:
        """Check if session exists and hasn't expired"""

    def cleanup_expired_sessions(self, timeout_seconds: int) -> int:
        """Remove expired sessions, return count"""

    def get_user_session_count(self, username: str) -> int:
        """Count active sessions for user"""

    def delete_all_user_sessions(self, username: str) -> int:
        """Delete all sessions for user"""
```

**Benefits over JSON:**
- Thread-safe concurrent access
- Atomic operations
- Indexed queries (fast lookups)
- No file locking needed
- Scales to millions of sessions

### 1.5 Server Utilities

- [ ] Create `fastapi/lib/server_utils.py` from `server/lib/server_utils.py`
  - Add parameter injection to all functions
  - Add FastAPI-specific request helper

Pure functions (no changes):
```python
def make_timestamp() -> str
def safe_file_path(path: str) -> str
```

With injection:
```python
def get_data_file_path(document_id: str, data_root: Path, file_type: str, version: str = None) -> Path
def get_version_path(data_root: Path, file_hash: str, version: str) -> Path
def resolve_document_identifier(doc_id: str, db_dir: Path, logger=None) -> str
```

FastAPI-specific:
```python
from fastapi import Request

def get_session_id_from_request(request: Request) -> Optional[str]:
    """Extract session ID from cookies, headers, or query params"""
    # Check cookie
    session_id = request.cookies.get('sessionId')
    if session_id:
        return session_id

    # Check header
    session_id = request.headers.get('X-Session-Id')
    if session_id:
        return session_id

    # Check query param
    return request.query_params.get('sessionId')
```

### 1.6 Hashing Utilities

- [ ] Create `fastapi/lib/hash_utils.py` from `server/lib/hash_utils.py`
  - Add `db_dir: Path` and `logger=None` parameters
  - Add file extension mapping helper

```python
def generate_file_hash(content: bytes) -> str:
    """Generate SHA-256 hash of file content"""
    import hashlib
    return hashlib.sha256(content).hexdigest()

def get_file_extension(file_type: str) -> str:
    """Get file extension for file_type ('pdf' -> '.pdf', 'tei' -> '.tei.xml')"""
    extensions = {
        'pdf': '.pdf',
        'tei': '.tei.xml',
        'rng': '.rng'
    }
    if file_type not in extensions:
        raise ValueError(f"Unknown file_type: {file_type}")
    return extensions[file_type]

def get_storage_path(data_root: Path, file_hash: str, file_type: str) -> Path:
    """Get storage path using git-style hash sharding"""
    shard_dir = data_root / file_hash[:2]
    shard_dir.mkdir(parents=True, exist_ok=True)
    extension = get_file_extension(file_type)
    return shard_dir / f"{file_hash}{extension}"

def load_hash_lookup(db_dir: Path, logger=None) -> dict
def save_hash_lookup(lookup: dict, db_dir: Path, logger=None)
def add_hash_entry(file_hash: str, file_path: str, db_dir: Path, logger=None)
def resolve_hash_to_path(file_hash: str, db_dir: Path, logger=None) -> Optional[str]
```

## Completion Criteria

Phase 1 is complete when:
- ✅ All `fastapi/lib/*.py` files have no Flask imports
- ✅ All functions use explicit parameter injection
- ✅ No references to `current_app`, `g`, or Flask's `request`
- ✅ Code is testable without web framework
- ✅ File extension mapping working correctly
- ✅ SQLite session management working with proper indexing

## Testing

While unit tests aren't required, verify libraries work by:
1. Import in Python REPL
2. Call functions with test parameters
3. Verify no import errors

Example:
```python
from pathlib import Path
from fastapi.lib.hash_utils import get_storage_path

path = get_storage_path(Path('data'), 'abc123', 'tei')
print(path)  # data/ab/abc123.tei.xml
```

## Next Phase

→ [Phase 2: SQLite File Metadata System](phase-2-sqlite-metadata.md)
