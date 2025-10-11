"""
FastAPI main application with versioned API endpoints.
"""

from fastapi import FastAPI, APIRouter
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from contextlib import asynccontextmanager
from pathlib import Path

from .config import get_settings
from .lib.logging_utils import setup_logging, get_logger


logger = get_logger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application startup and shutdown lifecycle"""
    settings = get_settings()

    # Setup logging
    setup_logging(settings.log_level, settings.log_categories)
    logger.info(f"Starting PDF-TEI Editor API")
    logger.info(f"Data root: {settings.data_root}")
    logger.info(f"DB directory: {settings.db_dir}")

    # Initialize database directory from config defaults
    # This copies JSON files from config/ to db/ if they don't exist
    from .lib.db_init import ensure_db_initialized
    try:
        ensure_db_initialized()
        logger.info("Database configuration initialized from defaults")
    except Exception as e:
        logger.error(f"Error initializing database from config: {e}")
        raise

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
    db_path = settings.data_root / "metadata.db"
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

    yield

    # Shutdown
    logger.info("Shutting down PDF-TEI Editor API")


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
    files_list,
    files_serve,
    files_upload,
    files_save,
    files_delete,
    files_move,
    files_locks,
    files_heartbeat
)

# Versioned API router (v1)
api_v1 = APIRouter(prefix="/api/v1", tags=["v1"])
api_v1.include_router(auth.router)
api_v1.include_router(config.router)
api_v1.include_router(files_list.router)
api_v1.include_router(files_serve.router)
api_v1.include_router(files_upload.router)
api_v1.include_router(files_save.router)
api_v1.include_router(files_delete.router)
api_v1.include_router(files_move.router)
api_v1.include_router(files_locks.router)
api_v1.include_router(files_heartbeat.router)

# Unversioned API router (for backward compatibility with Flask)
api_compat = APIRouter(prefix="/api", tags=["compatibility"])
api_compat.include_router(auth.router)
api_compat.include_router(config.router)
api_compat.include_router(files_list.router)
api_compat.include_router(files_serve.router)
api_compat.include_router(files_upload.router)
api_compat.include_router(files_save.router)
api_compat.include_router(files_delete.router)
api_compat.include_router(files_move.router)
api_compat.include_router(files_locks.router)
api_compat.include_router(files_heartbeat.router)

# Health check endpoint (unversioned)
@app.get("/health")
async def health_check():
    """Health check endpoint"""
    return {"status": "ok"}

# Mount versioned router
app.include_router(api_v1)

# Mount compatibility router (exclude from OpenAPI schema to keep it clean)
app.include_router(api_compat, include_in_schema=False)
