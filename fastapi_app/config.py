from pydantic_settings import BaseSettings, SettingsConfigDict
from pathlib import Path
from functools import lru_cache
import tempfile
import os

class Settings(BaseSettings):
    """Application settings loaded from .env.fastapi (or custom env file)"""

    # Pydantic v2 configuration - Pylance may show false positive warning
    # Allow overriding env_file via FASTAPI_ENV_FILE environment variable
    model_config = SettingsConfigDict(  # type: ignore[misc]
        env_file=os.environ.get('FASTAPI_ENV_FILE', '.env.fastapi'),
        env_file_encoding='utf-8',
        extra='ignore'
    )

    # Server
    HOST: str = "127.0.0.1"
    PORT: int = 8000

    # Paths
    DATA_ROOT: str = "data"  # Parent directory containing files/ and db/ subdirectories
    CONFIG_DIR: str = ""  # Optional: override default config location (for tests)
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

    # Application Mode - can be overridden by config/config.json
    # Valid values: "development", "production", "testing"
    APPLICATION_MODE: str = "development"

    @property
    def data_root(self) -> Path:
        return Path(self.DATA_ROOT)

    @property
    def db_dir(self) -> Path:
        """Database directory - always data_root/db"""
        return self.data_root / "db"

    @property
    def config_dir(self) -> Path | None:
        """Return config directory if specified, otherwise None (use default)"""
        if not self.CONFIG_DIR:
            return None
        return Path(self.CONFIG_DIR)

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
        """
        Get session timeout in seconds.

        Priority:
        1. SESSION_TIMEOUT environment variable (if explicitly set)
        2. session.timeout from config.json
        3. Default: 3600 seconds (1 hour)
        """
        # Check if SESSION_TIMEOUT was explicitly set in environment (not just the default)
        env_timeout = os.environ.get('SESSION_TIMEOUT')
        if env_timeout is not None:
            return int(env_timeout)

        # Try to load from config.json as fallback
        try:
            from fastapi_app.lib.config_utils import get_config_value
            config_timeout = get_config_value('session.timeout', self.db_dir)
            if config_timeout is not None:
                return int(config_timeout)
        except Exception:
            # Silently fall through to default if config can't be loaded
            pass

        # Use the pydantic default as final fallback
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

    @property
    def application_mode(self) -> str:
        """Return application mode (development, production, testing)"""
        return self.APPLICATION_MODE.lower()

@lru_cache
def get_settings() -> Settings:
    """Get cached settings instance"""
    return Settings()
