# Architecture Overview

Comprehensive architecture documentation for the PDF-TEI Editor.

For quick reference, see [../code-assistant/architecture.md](../code-assistant/architecture.md).

## Table of Contents

- [System Overview](#system-overview)
- [Backend Architecture](#backend-architecture)
- [Frontend Architecture](#frontend-architecture)
- [Plugin System](#plugin-system)
- [State Management](#state-management)
- [Data Flow](#data-flow)
- [Build System](#build-system)

## System Overview

The PDF-TEI Editor uses a **plugin-based architecture** with:

- **Backend**: FastAPI (Python 3.13+) serving RESTful API and static files
- **Frontend**: ES6 modules with plugin-based functionality
- **State**: Immutable state management with reactive updates
- **UI**: Shoelace web components with typed hierarchical navigation
- **Data**: SQLite for metadata, filesystem for PDF/TEI files

### Key Technologies

| Layer | Technology | Purpose |
|-------|------------|---------|
| **Backend** | FastAPI | RESTful API, authentication, file management |
| **Database** | SQLite | File metadata, user sessions, locks |
| **Frontend** | ES6 Modules | Plugin system, state management |
| **UI Components** | Shoelace | Web components (dialogs, buttons, menus) |
| **Editor** | CodeMirror 6 | XML/TEI editing with autocomplete |
| **PDF Viewer** | PDF.js | PDF rendering and navigation |
| **Validation** | RelaxNG | TEI schema validation |
| **Build** | Rollup | Production bundling |
| **Dev Mode** | importmap | Source file loading without build |
| **Dependency Mgmt** | uv (Python), npm (JavaScript) | Package management |

## Backend Architecture

The backend is built with FastAPI and follows a modular router-based architecture.

### Directory Structure

```
fastapi_app/
├── main.py                 # FastAPI app, router registration, lifespan
├── config.py               # Settings via pydantic-settings
├── api/                    # Legacy compat routes (minimal)
│   ├── auth.py            # Auth shim
│   └── config.py          # Config shim
├── routers/                # Versioned API routes (/api/v1/*)
│   ├── files_*.py         # File operations (list, save, delete, move, copy)
│   ├── files_locks.py     # File locking system
│   ├── files_heartbeat.py # Lock heartbeat
│   ├── validation.py      # XML/TEI validation
│   ├── extraction.py      # AI extractor integration
│   ├── sync.py            # WebDAV synchronization
│   ├── sse.py             # Server-sent events
│   ├── schema.py          # Schema upload/management
│   ├── collections.py     # Collection CRUD
│   ├── users.py           # User management
│   ├── groups.py          # Group management
│   └── roles.py           # Role management
├── lib/                    # Business logic and utilities
│   ├── auth.py            # Authentication logic
│   ├── access_control.py  # RBAC implementation
│   ├── database.py        # SQLite DatabaseManager
│   ├── file_repository.py # File metadata operations
│   ├── file_storage.py    # Physical file storage
│   ├── locking.py         # File locking system
│   ├── dependencies.py    # FastAPI dependencies (auth, etc.)
│   ├── config_utils.py    # Config management
│   ├── collection_utils.py # Collection operations
│   ├── user_utils.py      # User operations
│   ├── group_utils.py     # Group operations
│   ├── doi_utils.py       # DOI resolution
│   └── models*.py         # Pydantic models
└── extractors/             # AI extraction plugins
    ├── base.py            # Base extractor interface
    ├── grobid.py          # GROBID extractor
    └── ...                # Other extractors
```

### Application Lifecycle

The FastAPI application uses an async context manager for startup/shutdown:

```python
@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup
    # 1. Setup logging
    # 2. Initialize database from config defaults
    # 3. Sync application mode (env vs config)
    # 4. Create data directories
    # 5. Initialize SQLite databases (metadata, locks)

    yield

    # Shutdown
    # Cleanup resources
```

### Router Organization

Routes are organized by versioning and functionality:

**Versioned Routes** (`/api/v1/*`):

- All new endpoints use versioned routes
- Type-safe with Pydantic models
- Auto-generated OpenAPI documentation
- Client generated from OpenAPI schema

**Legacy Compat Routes** (`/api/*`):

- Minimal shims for backward compatibility
- Redirect to versioned routes where possible

### Database Architecture

The application uses SQLite for structured data:

**metadata.db**:

- File metadata (document_id, hash, type, timestamps)
- Document collections (many-to-many)
- Document metadata (title, author, DOI)
- File relationships (PDFs and their TEI variants)

**locks.db**:

- File locks (document_id, locked_by, locked_at)
- Heartbeat tracking for lock staleness detection

**data/db/\*.json**:

- User accounts (username, passwd_hash, roles)
- Groups (name, members)
- Roles (name, permissions)
- Collections (name, description)
- Application config (key-value pairs)

See [database.md](./database.md) for schema details.

### Authentication & Authorization

**Authentication**:

- Session-based (session IDs stored in sessions.json)
- Passwords hashed with SHA-256
- Sessions transmitted via `X-Session-Id` header

**Authorization** (RBAC):

- Role-Based Access Control
- Permissions: read, write, create_doc, delete_doc, manage_users, etc.
- Roles defined in `data/db/roles.json`
- User-role mapping in `data/db/users.json`
- Group-based permissions in `data/db/groups.json`

See [access-control.md](./access-control.md) for RBAC implementation details.

### File Storage

**Physical Storage**:

```
data/files/
├── <hash[:2]>/
│   └── <hash>.pdf         # PDF files by content hash
│   └── <hash>.tei         # TEI files by content hash
│   └── <hash>.rng         # RelaxNG schemas by content hash
```

**Metadata Storage**:

- SQLite `metadata.db` tracks all file metadata
- `document_id` is stable identifier across versions
- `file_hash` is content-addressable storage key
- Multiple TEI variants per PDF (via `variant` field)

**File Repository**:

- `file_repository.py` provides high-level file operations
- Handles metadata updates, collection management, versioning
- Ensures referential integrity between metadata and storage

## Frontend Architecture

The frontend uses a plugin-based architecture with ES6 modules.

### Directory Structure

```
app/src/
├── app.js                  # Application bootstrap, plugin registration
├── endpoints.js            # Plugin endpoint definitions
├── state.js                # State object typedef
├── ui.js                   # UI element management, template system
├── modules/                # Library code (plugin-independent)
│   ├── plugin-base.js     # Plugin base class
│   ├── plugin-manager.js  # Plugin registration and lifecycle
│   ├── state-manager.js   # Immutable state management
│   ├── api-client-v1.js   # Generated FastAPI client
│   ├── file-data-utils.js # File metadata utilities
│   └── ...                # Other utilities
├── plugins/                # Plugin implementations
│   ├── authentication.js  # Login/logout, session management
│   ├── filedata.js        # File metadata, collection selector
│   ├── pdf-viewer.js      # PDF.js integration
│   ├── xml-editor.js      # CodeMirror TEI editor
│   ├── validation.js      # Schema validation
│   ├── extraction.js      # AI extractor UI
│   ├── sync.js            # WebDAV sync
│   └── ...                # Other plugins
└── templates/              # HTML templates for UI components
    ├── dialog.html
    ├── toolbar.html
    └── ...
```

### Application Bootstrap

The application initializes in `app.js`:

1. **Import plugins**: All plugin classes/objects
2. **Create Application**: Instantiate Application class
3. **Register plugins**: Pass plugin list to PluginManager
4. **Install plugins**: Call `install()` on each plugin (respecting dependencies)
5. **Start application**: Call `start()` on all plugins
6. **Export API**: Export singleton instances for cross-plugin communication

### Module vs Plugin Distinction

**Modules** (`app/src/modules/`):

- Pure library code
- No direct dependency on plugins
- Reusable across different plugins
- Use dependency injection if plugin interaction needed

**Plugins** (`app/src/plugins/`):

- Implement specific features
- Can depend on other plugins (via `deps` array)
- Have access to Application context
- React to state changes

## Plugin System

The application uses two independent plugin systems - one for frontend (JavaScript) and one for backend (Python).

**See**: [Plugin System Overview](plugin-system.md) for comparison and architecture details.

### Frontend Plugins

Frontend plugins (`app/src/plugins/`) extend the browser UI with:

- Dependency resolution via topological sorting
- Immutable state management integration
- Lifecycle hooks (install, start, shutdown)
- Plugin classes with automatic state tracking

**See**: [Frontend Plugin System](plugin-system-frontend.md) for detailed architecture.

### Backend Plugins

Backend plugins (`fastapi_app/plugins/`) provide server-side functionality with:

- Runtime plugin discovery
- Role-based access control
- Custom FastAPI routes
- Plugin endpoints for frontend integration

**See**: [Backend Plugin System](plugin-system-backend.md) for detailed architecture.

## State Management

The application uses immutable state management with functional programming principles.

For comprehensive state management details, see [state-management.md](./state-management.md).

### Core Principles

1. **Immutability**: State never mutated in place; new objects created
2. **Single Source of Truth**: Application holds canonical state
3. **Reactive Updates**: Plugins notified of state changes
4. **Change Detection**: Efficient comparison of changed properties
5. **State History**: Last 10 states retained for debugging

### State Object Structure

See `app/src/state.js` for complete typedef:

```javascript
{
  user: null | { username, roles, ... },
  collection: string | null,
  pdf: {
    url: string | null,
    page: number,
    numPages: number,
    ...
  },
  xml: {
    content: string | null,
    dirty: boolean,
    valid: boolean,
    ...
  },
  filedata: {
    documentId: string | null,
    files: FileMetadata[],
    collections: Collection[],
    ...
  },
  ext: {
    // Plugin-specific state stored here
    [pluginName]: { ... }
  },
  previousState: State | null
}
```

### State Update Flow

1. **Event occurs** (user click, API response, etc.)
2. **Plugin dispatches change**: `this.dispatchStateChange({ key: newValue })`
3. **StateManager creates new state**: Merges changes into new object
4. **Application notifies plugins**: Calls `onStateUpdate(changedKeys, newState)` on all plugins
5. **Plugins react**: Update UI, trigger side effects

**Critical Rules**:

- Never mutate state in `onStateUpdate` (creates infinite loops)
- Only dispatch state changes from event handlers or async operations
- Use `this.state` (read-only) to access current state in Plugin classes

## Data Flow

### File Loading Workflow

1. **User selects PDF** from filedata dropdown
2. **filedata plugin** calls API to get file metadata
3. **State updated** with `documentId` and file list
4. **pdf-viewer plugin** reacts to state change, loads PDF
5. **xml-editor plugin** reacts, loads TEI content if available
6. **Other plugins** react (validation, extraction UI, etc.)

### File Saving Workflow

1. **User clicks Save** in xml-editor
2. **xml-editor** validates content (client-side)
3. **API call** to `/api/v1/files/save` with TEI content
4. **Backend** saves file, updates metadata database
5. **Response** includes new file_hash
6. **State updated** with saved content, dirty flag cleared
7. **filedata plugin** reacts, refreshes file list

### Authentication Flow

1. **User enters credentials** in login dialog
2. **Password hashed** client-side with SHA-256
3. **API call** to `/api/v1/auth/login` with username, passwd_hash
4. **Backend** validates credentials, creates session
5. **Session ID** returned and stored
6. **State updated** with user object
7. **All plugins** react to user state change (show/hide UI, enable features)

## Build System

The application supports both development and production modes.

### Development Mode

**Activated by**: `?dev` URL parameter

**Behavior**:

- **importmap** loads source files directly from `app/src/`
- No build step required
- Fast iteration: edit→refresh
- Templates loaded dynamically via fetch
- Full source maps for debugging

**Entry point**: `app/src/app.js`

### Production Mode

**Activated by**: Default (no `?dev` parameter)

**Behavior**:

- Bundled code loaded from `app/web/`
- Minified and optimized
- Templates bundled into `templates.json`
- No runtime template loading

**Build process**:

```bash
npm run build
```

**Build steps** (`bin/build.js`):

1. Generate API client from OpenAPI schema
2. Bundle templates into `app/web/templates.json`
3. Analyze template usage in code
4. Bundle JavaScript with Rollup
5. Copy static assets
6. Copy Shoelace assets
7. Download PDF.js distribution

**Pre-push hook**: Automatically runs build before git push

### Template System

Templates are HTML files in `app/src/templates/`.

**Development**:

- Loaded dynamically via fetch
- Can edit and refresh without rebuild

**Production**:

- Bundled into `templates.json` by `bin/bundle-templates.js`
- Analyzer finds `registerTemplate()` calls in code
- Only used templates included in bundle

**Usage**:

```javascript
// Register at module level
await registerTemplate('dialog', 'dialog.html');

// Create element synchronously
const dialog = createSingleFromTemplate('dialog', parent, { title: 'Save' });
```

### Asset Management

**Shoelace**:

- Icons and themes copied to `app/web/shoelace-assets/`
- Icon analyzer finds icon usage in templates and code
- Only used icons included in production build

**PDF.js**:

- Downloaded from official CDN during build
- Worker and viewer scripts copied to `app/web/pdfjs/`

**Fonts and Images**:

- Static assets in `app/fonts/`, `app/images/`
- Copied to `app/web/` during build

## Related Documentation

- [Plugin System Overview](./plugin-system.md) - Frontend and backend plugin comparison
- [Frontend Plugin System](./plugin-system-frontend.md) - Frontend plugin architecture
- [Backend Plugin System](./plugin-system-backend.md) - Backend plugin architecture
- [State Management](./state-management.md) - State patterns and best practices
- [Database](./database.md) - SQLite schema and migrations
- [Access Control](./access-control.md) - RBAC implementation
- [Collections](./collections.md) - Collection management
- [API Reference](./api-reference.md) - FastAPI endpoint documentation
- [Validation](./validation.md) - XML/TEI validation system
