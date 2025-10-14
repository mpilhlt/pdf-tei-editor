from pydantic_settings import BaseSettings, SettingsConfigDict
from pathlib import Path
from functools import lru_cache
import tempfile

class Settings(BaseSettings):
    """Application settings loaded from .env.fastapi"""

    # Pydantic v2 configuration - Pylance may show false positive warning
    model_config = SettingsConfigDict(  # type: ignore[misc]
        env_file='.env.fastapi',
        env_file_encoding='utf-8',
        extra='ignore'
    )

    # Server
    HOST: str = "127.0.0.1"
    PORT: int = 8000

    # Paths
    DATA_ROOT: str = "fastapi_app/data"
    DB_DIR: str = "fastapi_app/db"
    UPLOAD_DIR: str = ""

    # Features
    WEBDAV_ENABLED: bool = False

    # WebDAV Configuration (Phase 6)
    WEBDAV_BASE_URL: str = ""
    WEBDAV_USERNAME: str = ""
    WEBDAV_PASSWORD: str = ""
    WEBDAV_REMOTE_ROOT: str = "/pdf-tei-editor"

    # Session
    SESSION_TIMEOUT: int = 3600  # Session timeout in seconds (default: 1 hour)

    # Logging
    LOG_LEVEL: str = "INFO"
    LOG_CATEGORIES: str = ""

    @property
    def data_root(self) -> Path:
        return Path(self.DATA_ROOT)

    @property
    def db_dir(self) -> Path:
        return Path(self.DB_DIR)

    @property
    def webdav_enabled(self) -> bool:
        return self.WEBDAV_ENABLED

    @property
    def upload_dir(self) -> Path:
        if not self.UPLOAD_DIR:
            return Path(tempfile.gettempdir()) / "pdf-tei-editor-uploads"
        return Path(self.UPLOAD_DIR)

    @property
    def log_level(self) -> str:
        return self.LOG_LEVEL.upper()

    @property
    def log_categories(self) -> list[str]:
        if not self.LOG_CATEGORIES:
            return []
        return [cat.strip() for cat in self.LOG_CATEGORIES.split(',')]

    @property
    def session_timeout(self) -> int:
        return self.SESSION_TIMEOUT

    @property
    def webdav_base_url(self) -> str:
        return self.WEBDAV_BASE_URL

    @property
    def webdav_username(self) -> str:
        return self.WEBDAV_USERNAME

    @property
    def webdav_password(self) -> str:
        return self.WEBDAV_PASSWORD

    @property
    def webdav_remote_root(self) -> str:
        return self.WEBDAV_REMOTE_ROOT

@lru_cache
def get_settings() -> Settings:
    """Get cached settings instance"""
    return Settings()
