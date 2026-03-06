"""
FastAPI main application with versioned API endpoints.
"""

from fastapi import FastAPI, APIRouter, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from contextlib import asynccontextmanager
from pathlib import Path

from .config import get_settings
from .lib.utils.logging_utils import setup_logging, get_logger
from .lib.core.database_init import initialize_all_databases


logger = get_logger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application startup and shutdown lifecycle"""
    import os
    settings = get_settings()

    # Setup logging
    setup_logging(settings.log_level, settings.log_categories)

    # Install SSE log handler for real-time log streaming
    from .lib.core.dependencies import get_sse_service
    from .lib.utils.logging_utils import install_sse_log_handler
    install_sse_log_handler(get_sse_service())

    logger.info(f"Starting PDF-TEI Editor API")
    logger.info(f"Data root: {settings.data_root}")
    logger.info(f"DB directory: {settings.db_dir}")

    # Check for pending data restore (from backup-restore plugin)
    project_root = get_settings().project_root_dir
    data_restore_dir = project_root / "data_restore"
    data_was_restored = False
    if data_restore_dir.exists() and data_restore_dir.is_dir():
        from .lib.core.data_restore import apply_pending_restore
        data_was_restored = apply_pending_restore(
            project_root, settings.data_root, logger
        )

    # Initialize database directory from config defaults FIRST
    # This copies JSON files from config/ to db/ if they don't exist
    # and merges missing config values into db/config.json
    from .lib.core.db_init import ensure_db_initialized
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
    from .lib.utils.config_utils import get_config
    config = get_config()
    config_data = config.load()

    if "FASTAPI_APPLICATION_MODE" in os.environ:
        # Environment variable takes precedence
        app_mode = os.environ["FASTAPI_APPLICATION_MODE"]
        config.set("application.mode", app_mode)
        logger.info(f"Application mode from environment: {app_mode}")
    else:
        # Get from config and set environment variable
        app_mode = config_data.get("application", {}).get("mode", settings.application_mode)
        os.environ["FASTAPI_APPLICATION_MODE"] = app_mode
        logger.info(f"Application mode from config: {app_mode}")

    # Sync docs.from-github setting from environment
    if "DOCS_FROM_GITHUB" in os.environ:
        docs_from_github = os.environ["DOCS_FROM_GITHUB"].lower() in ("true", "1", "yes")
        config.set("docs.from-github", docs_from_github)
        logger.info(f"Documentation source from environment: {'GitHub' if docs_from_github else 'local'}")
    else:
        docs_from_github = config_data.get("docs.from-github", False)
        logger.info(f"Documentation source from config: {'GitHub' if docs_from_github else 'local'}")

    # Ensure directories exist
    settings.data_root.mkdir(parents=True, exist_ok=True)
    settings.db_dir.mkdir(parents=True, exist_ok=True)
    settings.upload_dir.mkdir(parents=True, exist_ok=True)

    # Initialize file storage directory
    file_storage_dir = settings.data_root / "files"
    file_storage_dir.mkdir(parents=True, exist_ok=True)
    logger.info(f"File storage directory: {file_storage_dir}")

    # Initialize ALL databases at startup (application-level initialization)
    # This prevents SQLite WAL concurrency issues by ensuring all databases
    # are ready before any concurrent requests arrive
    try:
        initialize_all_databases(settings.db_dir, settings.data_root)
        logger.info("All databases initialized successfully")
    except Exception as e:
        logger.error(f"Error initializing databases: {e}")
        raise

    # Remove diagnostic users on startup in production mode
    if app_mode == "production":
        from .lib.core.dependencies import get_auth_manager
        auth_manager = get_auth_manager()
        for diagnostic_user in ['reviewer', 'annotator']:
            if auth_manager.get_user_by_username(diagnostic_user):
                auth_manager.delete_user(diagnostic_user)
                logger.info(f"Removed diagnostic user '{diagnostic_user}' on startup")

    # Initialize plugins (discovery and route registration happen at module level)
    from .lib.plugins.plugin_manager import PluginManager
    try:
        plugin_manager = PluginManager.get_instance()
        await plugin_manager.initialize_plugins(app)
        logger.info("Plugin system initialized")
    except Exception as e:
        logger.error(f"Error initializing plugin system: {e}")
        # Non-fatal - continue without plugins

    # Log startup complete
    logger.info(f"FastAPI server ready at http://{settings.HOST}:{settings.PORT}")

    # If data was restored, broadcast maintenance-off and reload to reconnecting clients
    if data_was_restored:
        from .lib.sse.sse_utils import broadcast_to_all_sessions
        from .lib.core.dependencies import get_session_manager
        sse_svc = get_sse_service()
        sess_mgr = get_session_manager()
        broadcast_to_all_sessions(
            sse_service=sse_svc,
            session_manager=sess_mgr,
            event_type="maintenanceOff",
            data={},
            logger=logger,
        )
        broadcast_to_all_sessions(
            sse_service=sse_svc,
            session_manager=sess_mgr,
            event_type="maintenanceReload",
            data={},
            logger=logger,
        )
        logger.info("Broadcast maintenanceOff + maintenanceReload after data restore")

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
from .routers import (
    plugins,
    files_list,
    files_serve,
    files_upload,
    files_save,
    files_delete,
    files_gc,
    files_repopulate,
    files_move,
    files_copy,
    files_locks,
    files_heartbeat,
    files_export,
    files_import,
    files_metadata,
    files_permissions,
    validation,
    extraction,
    sync,
    sse,
    maintenance,
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
api_v1.include_router(files_repopulate.router)
api_v1.include_router(files_move.router)
api_v1.include_router(files_copy.router)
api_v1.include_router(files_locks.router)  # Before files_serve (catch-all)
api_v1.include_router(files_heartbeat.router)  # Before files_serve (catch-all)
api_v1.include_router(files_export.router)  # Export endpoint
api_v1.include_router(files_import.router)  # Import endpoint
api_v1.include_router(files_metadata.router)  # Metadata update endpoint
api_v1.include_router(files_permissions.router)  # Document permissions (granular mode)
api_v1.include_router(sync.router)  # Phase 6: Sync endpoints
api_v1.include_router(sse.router)  # Phase 6: SSE stream
api_v1.include_router(maintenance.router)  # Admin maintenance controls
api_v1.include_router(plugins.router)  # Plugin system endpoints
api_v1.include_router(files_serve.router)  # MUST be last - has catch-all /{document_id}

# Health check endpoint (unversioned)
@app.get("/health")
async def health_check():
    """Health check endpoint"""
    return {"status": "ok"}

# Mount versioned router
app.include_router(api_v1)

# Discover and register plugin routes at module level
# Note: Routes MUST be registered at module level, not in lifespan, as FastAPI builds
# its routing table before lifespan runs. Plugin initialization happens in lifespan.
from .lib.plugins.plugin_manager import PluginManager
plugin_manager = PluginManager.get_instance()
plugin_manager.discover_plugins()
plugin_manager.register_plugin_routes(app)
logger.info("Plugin routes registered")

# Backwards compatibility: Mount files_serve at /api/files for legacy frontend code
# This is mounted AFTER plugin routes to ensure /api/plugins/* routes take precedence
# over the catch-all /{document_id} route
api_compat = APIRouter(prefix="/api")
api_compat.include_router(files_serve.router)
app.include_router(api_compat)

# Static file serving
# These must be mounted AFTER API routes to avoid conflicts
project_root = get_settings().project_root_dir
web_root = project_root / 'app' / 'web'

# Development mode routes (conditionally mounted)
# In development, serve source files, node_modules, and tests
settings = get_settings()
from .lib.utils.config_utils import get_config
config = get_config()
config_data = config.load()
is_dev_mode = config_data.get("application", {}).get("mode", "development") == "development"

if is_dev_mode:
    # Serve node_modules for importmap, stripping sourceMappingURL from JS files
    # to suppress browser source map warnings from packages with broken/missing maps.
    node_modules_root = project_root / 'node_modules'
    if node_modules_root.exists():
        import re
        from starlette.responses import FileResponse
        _sourcemap_re = re.compile(r'\n?//# sourceMappingURL=\S+', re.MULTILINE)
        _node_modules_root_resolved = node_modules_root.resolve()

        @app.get("/node_modules/{path:path}")
        async def serve_node_modules(path: str):
            file_path = (node_modules_root / path).resolve()
            if not str(file_path).startswith(str(_node_modules_root_resolved)):
                return Response(status_code=403)
            if not file_path.exists() or not file_path.is_file():
                return Response(status_code=404)
            if file_path.suffix.lower() in ('.js', '.mjs', '.cjs'):
                content = _sourcemap_re.sub('', file_path.read_text(encoding='utf-8', errors='replace'))
                return Response(content=content, media_type='application/javascript')
            return FileResponse(str(file_path))

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
