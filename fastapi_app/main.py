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

    # Ensure directories exist
    settings.data_root.mkdir(parents=True, exist_ok=True)
    settings.db_dir.mkdir(parents=True, exist_ok=True)
    settings.upload_dir.mkdir(parents=True, exist_ok=True)

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

# Versioned API router
api_v1 = APIRouter(prefix="/api/v1", tags=["v1"])

# Health check endpoint (unversioned)
@app.get("/health")
async def health_check():
    """Health check endpoint"""
    return {"status": "ok"}

# Mount versioned router
app.include_router(api_v1)

# Backward compatibility: mount same router at /api (without version)
app.include_router(api_v1, prefix="/api", include_in_schema=False)
