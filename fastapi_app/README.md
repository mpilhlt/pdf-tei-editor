# FastAPI Migration

This directory contains the FastAPI migration of the PDF-TEI Editor backend.

## Directory Structure

```
fastapi_app/
├── api/          # FastAPI routers (by feature)
├── lib/          # Framework-agnostic core library
├── db/           # SQLite databases and JSON config
├── data/         # Hash-sharded file storage
├── tests/        # E2E backend tests
│   └── helpers/  # Test utilities
└── prompts/      # Migration documentation
```

## Quick Start

### Running the Development Server

```bash
npm run dev:fastapi
```

Server will be available at:
- API: http://localhost:8000
- OpenAPI docs: http://localhost:8000/docs
- Health check: http://localhost:8000/health

### Running Tests

```bash
# Start server (Terminal 1)
npm run dev:fastapi

# Run tests (Terminal 2)
E2E_BASE_URL=http://localhost:8000 node fastapi_app/tests/health.test.js
```

## Important Notes

### Directory Naming

The directory is named `fastapi_app` (not `fastapi`) to avoid Python import conflicts with the FastAPI library. The project uses a wrapper module (`run_fastapi.py` in the project root) to launch the application.

### Configuration

Settings are loaded from `.env.fastapi` in the project root. See [config.py](config.py) for all available settings.

## Migration Progress

See [prompts/migration-plan.md](prompts/migration-plan.md) for the complete migration plan and current progress.

### Phases

- ✅ **Phase 0**: Foundation and Infrastructure
- ⬜ **Phase 1**: Core Library Migration
- ⬜ **Phase 2**: SQLite File Metadata System
- ⬜ **Phase 3**: Authentication and Configuration APIs
- ⬜ **Phase 4**: File Management APIs
- ⬜ **Phase 5**: Validation and Extraction APIs
- ⬜ **Phase 6**: Sync and SSE APIs
- ⬜ **Phase 7**: Client Generation and Frontend Integration
- ⬜ **Phase 8**: Testing and Validation
- ⬜ **Phase 9**: Deployment and Switchover
- ⬜ **Phase 10**: Documentation and Cleanup

## Architecture

- **FastAPI**: Modern async web framework
- **Pydantic**: Data validation and settings management
- **SQLite**: File metadata storage with hash-sharded files
- **OpenAPI**: Auto-generated API specification
- **Dependency Injection**: Framework-agnostic core library

See [prompts/schema-design.md](prompts/schema-design.md) for database schema details.
