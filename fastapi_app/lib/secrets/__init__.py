"""
Encrypted per-user, per-service secrets (e.g. API keys billed to the user).

Library:
    from fastapi_app.lib.secrets import get_secret_store, require_user_secret

CLI: ``uv run python bin/secrets.py --help``
"""

from .services import MissingSecretError, SecretService, SecretServiceRegistry, register_secret_service, secret_required_detail
from .store import (
    ENCRYPTION_KEY_ENV_VAR,
    SecretStore,
    SecretsError,
    get_secret_store,
    require_user_secret,
)

__all__ = [
    "ENCRYPTION_KEY_ENV_VAR",
    "MissingSecretError",
    "SecretService",
    "SecretServiceRegistry",
    "SecretStore",
    "SecretsError",
    "get_secret_store",
    "register_secret_service",
    "secret_required_detail",
    "require_user_secret",
]
