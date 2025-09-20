from pydantic_settings import BaseSettings, SettingsConfigDict

class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file='.env.fastapi', env_file_encoding='utf-8', extra='ignore')

    DATA_DIR: str = "backend/data"
    DB_DIR: str = "backend/db"

settings = Settings()