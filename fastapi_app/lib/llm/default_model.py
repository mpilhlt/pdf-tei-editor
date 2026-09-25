"""
The installation-wide default LLM model, chosen by an admin and stored in
the config (`llm.default-model.provider` / `llm.default-model.model`).

Non-admin users may use free models (LLMModel["free"]) and this default;
everything else is admin-only.
"""

from fastapi_app.lib.plugins.plugin_tools import get_plugin_config
from fastapi_app.lib.utils.config_utils import get_config

PROVIDER_CONFIG_KEY = "llm.default-model.provider"
MODEL_CONFIG_KEY = "llm.default-model.model"

_registered = False


def _ensure_registered() -> None:
    """Seed the config keys once per process (get_plugin_config writes config.json on every call)."""
    global _registered
    if not _registered:
        get_plugin_config(
            PROVIDER_CONFIG_KEY,
            "LLM_DEFAULT_PROVIDER",
            default="",
            description="Id of the LLM provider of the default model (see llm.default-model.model).",
        )
        get_plugin_config(
            MODEL_CONFIG_KEY,
            "LLM_DEFAULT_MODEL",
            default="",
            description="Id of the default LLM model, used by all users unless they pick another one for their session.",
        )
        _registered = True


def reset_registration() -> None:
    """Reset the one-time registration guard. For tests only."""
    global _registered
    _registered = False


def get_default_model() -> tuple[str, str] | None:
    """The configured (provider_id, model_id), or None if no default is set."""
    _ensure_registered()
    config = get_config()
    provider_id = config.get(PROVIDER_CONFIG_KEY, "")
    model_id = config.get(MODEL_CONFIG_KEY, "")
    return (provider_id, model_id) if provider_id and model_id else None


def set_default_model(provider_id: str, model_id: str) -> None:
    """Persist the default model. Raises RuntimeError if the config cannot be written."""
    _ensure_registered()
    config = get_config()
    for key, value in ((PROVIDER_CONFIG_KEY, provider_id), (MODEL_CONFIG_KEY, model_id)):
        success, message = config.set(key, value)
        if not success:
            raise RuntimeError(f"Could not save {key}: {message}")


def is_default_model(provider_id: str, model_id: str) -> bool:
    """True if the given pair is the configured default."""
    return get_default_model() == (provider_id, model_id)
