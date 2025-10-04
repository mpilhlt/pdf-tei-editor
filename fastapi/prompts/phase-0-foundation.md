# Phase 0: Foundation and Infrastructure

**Goal**: Set up development environment and basic FastAPI application

## Directory Structure

Create the following structure:
```
fastapi/
├── api/          # FastAPI routers
├── lib/          # Framework-agnostic core library
├── db/           # SQLite databases and JSON config
├── data/         # Hash-sharded file storage
├── tests/        # E2E backend tests
│   └── helpers/  # Test utilities
└── prompts/      # Migration documentation
```

## Tasks

### 0.1 Clean Slate Setup
- [ ] Remove or archive existing `fastapi/` directory if present
- [ ] Create fresh directory structure above
- [ ] Document reference to old implementation for guidance

### 0.2 Python Dependencies
- [ ] Add to `pyproject.toml`: `uv add fastapi uvicorn[standard] pydantic pydantic-settings python-multipart`
- [ ] Verify Flask dependencies remain for existing server

### 0.3 Configuration
- [ ] Create `.env.fastapi` with settings (see below)
- [ ] Create `fastapi/config.py` with Pydantic BaseSettings

### 0.4 Basic FastAPI Application
- [ ] Create `fastapi/main.py` with health endpoint
- [ ] Add CORS middleware for local development
- [ ] Add startup/shutdown lifecycle hooks

### 0.5 Logging Infrastructure
- [ ] Create `fastapi/lib/logging_utils.py`
- [ ] Implement `setup_logging()` and `get_logger()`
- [ ] Support category-based filtering

### 0.6 Testing Infrastructure
- [ ] Create test helpers in `fastapi/tests/helpers/`
- [ ] Create `health.test.js` as first test
- [ ] Validate test passes

### 0.7 API Versioning
- [ ] Create versioned APIRouter: `/api/v1`
- [ ] Add backward compatibility alias: `/api`
- [ ] Configure OpenAPI schema

## Configuration File

`.env.fastapi`:
```ini
# Server
HOST=127.0.0.1
PORT=8000

# Paths
DATA_ROOT=fastapi/data
DB_DIR=fastapi/db
UPLOAD_DIR=

# Features
WEBDAV_ENABLED=false

# Logging
LOG_LEVEL=INFO
LOG_CATEGORIES=
```

## FastAPI Application

`fastapi/main.py`:
```python
from fastapi import FastAPI, APIRouter
from fastapi.middleware.cors import CORSMiddleware
from .config import get_settings
from .lib.logging_utils import setup_logging

app = FastAPI(
    title="PDF-TEI Editor API",
    description="API for PDF-TEI Editor application",
    version="1.0.0"
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
# Mount with both /api/v1 and /api (backward compat)
app.include_router(api_v1)
app.include_router(api_v1, prefix="/api", include_in_schema=False)

@app.on_event("startup")
async def startup_event():
    settings = get_settings()
    setup_logging(settings.log_level, settings.log_categories)
    print(f"Starting server with data_root: {settings.data_root}")

@app.get("/health")
async def health_check():
    return {"status": "ok"}
```

## Testing

`fastapi/tests/health.test.js`:
```javascript
/**
 * @testCovers fastapi/main.py
 */
import { test, describe } from 'node:test';
import assert from 'node:assert';

const HOST = process.env.E2E_HOST || 'localhost';
const PORT = process.env.E2E_PORT || '8000';
const BASE_URL = `http://${HOST}:${PORT}`;

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
E2E_BASE_URL=http://localhost:8000 node fastapi/tests/health.test.js
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
