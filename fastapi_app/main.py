"""
FastAPI main application with versioned API endpoints.
"""

from fastapi import FastAPI, APIRouter
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from contextlib import asynccontextmanager
from pathlib import Path

from .config import get_settings
from .lib.logging_utils import setup_logging, get_logger


logger = get_logger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application startup and shutdown lifecycle"""
    import os
    settings = get_settings()

    # Setup logging
    setup_logging(settings.log_level, settings.log_categories)
    logger.info(f"Starting PDF-TEI Editor API")
    logger.info(f"Data root: {settings.data_root}")
    logger.info(f"DB directory: {settings.db_dir}")

    # Initialize database directory from config defaults FIRST
    # This copies JSON files from config/ to db/ if they don't exist
    # and merges missing config values into db/config.json
    from .lib.db_init import ensure_db_initialized
    try:
        # Use custom config_dir if specified (for tests), otherwise use default
        config_dir = settings.config_dir
        db_dir = settings.db_dir
        if config_dir:
            logger.info(f"Using custom config directory: {config_dir}")
            ensure_db_initialized(config_dir=config_dir, db_dir=db_dir)
        else:
            ensure_db_initialized(db_dir=db_dir)
        logger.info("Database configuration initialized from defaults")
    except Exception as e:
        logger.error(f"Error initializing database from config: {e}")
        raise

    # Now load config and sync settings between environment and config
    # Priority: Environment variables > config.json
    from .lib.config_utils import load_full_config, set_config_value
    config = load_full_config(settings.db_dir)

    if "FASTAPI_APPLICATION_MODE" in os.environ:
        # Environment variable takes precedence
        app_mode = os.environ["FASTAPI_APPLICATION_MODE"]
        set_config_value("application.mode", app_mode, settings.db_dir)
        logger.info(f"Application mode from environment: {app_mode}")
    else:
        # Get from config and set environment variable
        app_mode = config.get("application", {}).get("mode", settings.application_mode)
        os.environ["FASTAPI_APPLICATION_MODE"] = app_mode
        logger.info(f"Application mode from config: {app_mode}")

    # Sync docs.from-github setting from environment
    if "DOCS_FROM_GITHUB" in os.environ:
        docs_from_github = os.environ["DOCS_FROM_GITHUB"].lower() in ("true", "1", "yes")
        set_config_value("docs.from-github", docs_from_github, settings.db_dir)
        logger.info(f"Documentation source from environment: {'GitHub' if docs_from_github else 'local'}")
    else:
        docs_from_github = config.get("docs.from-github", False)
        logger.info(f"Documentation source from config: {'GitHub' if docs_from_github else 'local'}")

    # Ensure directories exist
    settings.data_root.mkdir(parents=True, exist_ok=True)
    settings.db_dir.mkdir(parents=True, exist_ok=True)
    settings.upload_dir.mkdir(parents=True, exist_ok=True)

    # Initialize file storage directory
    file_storage_dir = settings.data_root / "files"
    file_storage_dir.mkdir(parents=True, exist_ok=True)
    logger.info(f"File storage directory: {file_storage_dir}")

    # Initialize file metadata database
    from .lib.database import DatabaseManager
    db_path = settings.db_dir / "metadata.db"
    try:
        db = DatabaseManager(db_path, logger)
        logger.info(f"File metadata database initialized: {db_path}")
    except Exception as e:
        logger.error(f"Error initializing database: {e}")
        raise

    # Initialize locks database
    from .lib.locking import init_locks_db
    try:
        init_locks_db(settings.db_dir, logger)
        logger.info(f"Locks database initialized: {settings.db_dir / 'locks.db'}")
    except Exception as e:
        logger.error(f"Error initializing locks database: {e}")
        raise

    # Initialize plugin system
    from .lib.plugin_manager import PluginManager
    try:
        plugin_manager = PluginManager.get_instance()
        plugin_manager.discover_plugins()
        plugin_manager.register_plugin_routes(app)
        await plugin_manager.initialize_plugins(app)
        logger.info("Plugin system initialized")
    except Exception as e:
        logger.error(f"Error initializing plugin system: {e}")
        # Non-fatal - continue without plugins

    # Log startup complete
    logger.info("=" * 80)
    logger.info(f"FastAPI server ready at http://{settings.HOST}:{settings.PORT}")
    logger.info(f"API docs available at: http://{settings.HOST}:{settings.PORT}/docs")
    logger.info("=" * 80)

    yield

    # Shutdown
    logger.info("Shutting down PDF-TEI Editor API")

    # Cleanup plugins
    try:
        plugin_manager = PluginManager.get_instance()
        await plugin_manager.shutdown_plugins()
    except Exception as e:
        logger.error(f"Error shutting down plugins: {e}")


# Create FastAPI application
app = FastAPI(
    title="PDF-TEI Editor API",
    description="API for PDF-TEI Editor application",
    version="1.0.0",
    lifespan=lifespan
)

# CORS middleware for local development
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://localhost:8080"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Import API routers
from .api import auth, config
from .routes import plugins
from .routers import (
    files_list,
    files_serve,
    files_upload,
    files_save,
    files_delete,
    files_gc,
    files_move,
    files_copy,
    files_locks,
    files_heartbeat,
    files_export,
    files_import,
    validation,
    extraction,
    sync,
    sse,
    schema,
    collections,
    users,
    groups,
    roles
)

# Versioned API router (v1)
# Note: No unversioned compatibility routes - frontend uses client shim (app/src/plugins/client.js)
api_v1 = APIRouter(prefix="/api/v1", tags=["v1"])
api_v1.include_router(auth.router)
api_v1.include_router(config.router)
api_v1.include_router(collections.router)
api_v1.include_router(users.router)
api_v1.include_router(groups.router)
api_v1.include_router(roles.router)
api_v1.include_router(validation.router)
api_v1.include_router(extraction.router)
api_v1.include_router(files_list.router)
api_v1.include_router(files_upload.router)
api_v1.include_router(files_save.router)
api_v1.include_router(files_delete.router)
api_v1.include_router(files_gc.router)
api_v1.include_router(files_move.router)
api_v1.include_router(files_copy.router)
api_v1.include_router(files_locks.router)  # Before files_serve (catch-all)
api_v1.include_router(files_heartbeat.router)  # Before files_serve (catch-all)
api_v1.include_router(files_export.router)  # Export endpoint
api_v1.include_router(files_import.router)  # Import endpoint
api_v1.include_router(sync.router)  # Phase 6: Sync endpoints
api_v1.include_router(sse.router)  # Phase 6: SSE stream
api_v1.include_router(schema.router)  # Schema serving (before files_serve)
api_v1.include_router(plugins.router)  # Plugin system endpoints
api_v1.include_router(files_serve.router)  # MUST be last - has catch-all /{document_id}

# Health check endpoint (unversioned)
@app.get("/health")
async def health_check():
    """Health check endpoint"""
    return {"status": "ok"}

# Mount versioned router
app.include_router(api_v1)

# Backwards compatibility: Mount files_serve at /api/files for legacy frontend code
# This allows /api/files/{hash} to work alongside /api/v1/files/{hash}
# TODO: Remove this once all frontend code is updated to use /api/v1/files
api_compat = APIRouter(prefix="/api")
api_compat.include_router(files_serve.router)
app.include_router(api_compat)

# Static file serving
# These must be mounted AFTER API routes to avoid conflicts
project_root = Path(__file__).parent.parent
web_root = project_root / 'app' / 'web'

# Development mode routes (conditionally mounted)
# In development, serve source files, node_modules, and tests
settings = get_settings()
from .lib.config_utils import load_full_config
config = load_full_config(settings.db_dir)
is_dev_mode = config.get("application", {}).get("mode", "development") == "development"

if is_dev_mode:
    # Mount node_modules for importmap
    node_modules_root = project_root / 'node_modules'
    if node_modules_root.exists():
        app.mount("/node_modules", StaticFiles(directory=str(node_modules_root)), name="node_modules")

    # Mount source files
    src_root = project_root / 'app' / 'src'
    if src_root.exists():
        app.mount("/src", StaticFiles(directory=str(src_root)), name="src")

    # Mount tests (for test utilities)
    tests_root = project_root / 'tests'
    if tests_root.exists():
        app.mount("/tests", StaticFiles(directory=str(tests_root)), name="tests")

# Mount docs
docs_root = project_root / 'docs'
if docs_root.exists():
    app.mount("/docs", StaticFiles(directory=str(docs_root)), name="docs")

# Mount web root for all other static files (must be last - catch-all)
# html=True enables serving index.html for directory requests
app.mount("/", StaticFiles(directory=str(web_root), html=True), name="static")
