from pydantic_settings import BaseSettings, SettingsConfigDict
from pathlib import Path
import tempfile

class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file='.env.fastapi', env_file_encoding='utf-8', extra='ignore')

    DATA_DIR: str = "backend/data"
    DB_DIR: str = "backend/db"
    WEBDAV_ENABLED: bool = False
    UPLOAD_DIR: str = ""  # Will be set to tempdir if empty

    @property
    def data_root(self) -> Path:
        return Path(self.DATA_DIR)

    @property
    def db_dir(self) -> Path:
        return Path(self.DB_DIR)

    @property
    def webdav_enabled(self) -> bool:
        return self.WEBDAV_ENABLED

    @property
    def upload_dir(self) -> Path:
        if not self.UPLOAD_DIR:
            # Create a temporary directory like Flask does
            self._temp_upload_dir = tempfile.mkdtemp()
            return Path(self._temp_upload_dir)
        return Path(self.UPLOAD_DIR)

def get_settings() -> Settings:
    return Settings()

# For backward compatibility
settings = get_settings()