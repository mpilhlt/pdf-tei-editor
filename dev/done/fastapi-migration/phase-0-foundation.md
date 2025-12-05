# Phase 0: Foundation and Infrastructure

**Goal**: Set up development environment and basic FastAPI application

## Directory Structure

Create the following structure:
```
fastapi_app/      # Named fastapi_app to avoid import conflicts
├── api/          # FastAPI routers
├── lib/          # Framework-agnostic core library
├── db/           # SQLite databases and JSON config
├── data/         # Hash-sharded file storage
├── tests/        # E2E backend tests
│   └── helpers/  # Test utilities
└── prompts/      # Migration documentation
```

**Note**: Directory named `fastapi_app` (not `fastapi`) to avoid Python import shadowing. The `run_fastapi.py` wrapper module launches the application.

## Tasks

### 0.1 Clean Slate Setup
- [x] Remove or archive existing `fastapi/` directory if present
- [x] Create fresh directory structure above
- [x] Document reference to old implementation for guidance

### 0.2 Python Dependencies
- [x] Add to `pyproject.toml`: `uv add fastapi uvicorn[standard] pydantic pydantic-settings python-multipart`
- [x] Verify Flask dependencies remain for existing server

### 0.3 Configuration
- [x] Create `.env.fastapi` with settings (see below)
- [x] Create `fastapi_app/config.py` with Pydantic BaseSettings

### 0.4 Basic FastAPI Application
- [x] Create `fastapi_app/main.py` with health endpoint
- [x] Add CORS middleware for local development
- [x] Add startup/shutdown lifecycle hooks

### 0.5 Logging Infrastructure
- [x] Create `fastapi_app/lib/logging_utils.py`
- [x] Implement `setup_logging()` and `get_logger()`
- [x] Support category-based filtering

### 0.6 Testing Infrastructure
- [x] Create test helpers in `fastapi_app/tests/helpers/`
- [x] Create `health.test.js` as first test
- [x] Validate test passes

### 0.7 API Versioning
- [x] Create versioned APIRouter: `/api/v1`
- [x] Add backward compatibility alias: `/api`
- [x] Configure OpenAPI schema

## Configuration File

`.env.fastapi`:

```ini
# Server
HOST=127.0.0.1
PORT=8000

# Paths
DATA_ROOT=fastapi_app/data
DB_DIR=fastapi_app/db
UPLOAD_DIR=

# Features
WEBDAV_ENABLED=false

# Logging
LOG_LEVEL=INFO
LOG_CATEGORIES=
```

## FastAPI Application

`fastapi_app/main.py`:

```python
from fastapi import FastAPI, APIRouter
from fastapi.middleware.cors import CORSMiddleware
from contextlib import asynccontextmanager

from .config import get_settings
from .lib.logging_utils import setup_logging, get_logger

logger = get_logger(__name__)

@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application startup and shutdown lifecycle"""
    settings = get_settings()
    setup_logging(settings.log_level, settings.log_categories)
    logger.info(f"Starting PDF-TEI Editor API")
    logger.info(f"Data root: {settings.data_root}")
    yield
    logger.info("Shutting down PDF-TEI Editor API")

app = FastAPI(
    title="PDF-TEI Editor API",
    description="API for PDF-TEI Editor application",
    version="1.0.0",
    lifespan=lifespan
)

# CORS for local development
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://localhost:8080"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Versioned router
api_v1 = APIRouter(prefix="/api/v1", tags=["v1"])

@app.get("/health")
async def health_check():
    return {"status": "ok"}

# Mount versioned router
app.include_router(api_v1)
# Backward compatibility: mount at /api
app.include_router(api_v1, prefix="/api", include_in_schema=False)
```

## Testing

`fastapi_app/tests/health.test.js`:

```javascript
/**
 * @testCovers fastapi_app/main.py
 */
import { test, describe } from 'node:test';
import assert from 'node:assert';

const BASE_URL = process.env.E2E_BASE_URL || 'http://localhost:8000';

describe('Health Check', () => {
    test('should return ok status', async () => {
        const response = await fetch(`${BASE_URL}/health`);
        assert.strictEqual(response.status, 200);

        const data = await response.json();
        assert.strictEqual(data.status, 'ok');
    });
});
```

Run test:

```bash
# Terminal 1
npm run dev:fastapi

# Terminal 2
E2E_BASE_URL=http://localhost:8000 node fastapi_app/tests/health.test.js
```

## Completion Criteria

Phase 0 is complete when:
- ✅ FastAPI server starts: `npm run dev:fastapi`
- ✅ Health endpoint responds: `http://localhost:8000/health`
- ✅ OpenAPI docs accessible: `http://localhost:8000/docs`
- ✅ Health test passes
- ✅ Logging outputs category-based messages

## Next Phase

→ [Phase 1: Core Library Migration](phase-1-core-library.md)
