"""
Authorization for using a given LLM model: the admin-configured
include/exclude filter applies to everyone; models that are not free are
usable by admins and, for other users, only when an admin made them the
default model or the provider runs on the user's own API key (usage is
then billed to the user, see LLMProvider.uses_user_key). A model counts as
free when its provider says so (LLMModel["free"]) or when it matches an
admin-configured `llm.free-models` pattern (e.g. models on a provider's
free tier).
"""

from fastapi_app.lib.llm.base import LLMModel, LLMProvider
from fastapi_app.lib.llm.default_model import is_default_model
from fastapi_app.lib.llm.model_filter import PATTERN_SYNTAX, has_model_filter, is_model_allowed, parse_patterns
from fastapi_app.lib.permissions.acl_utils import user_is_admin
from fastapi_app.lib.plugins.plugin_tools import get_plugin_config
from fastapi_app.lib.utils.config_utils import get_config

FREE_MODELS_CONFIG_KEY = "llm.free-models"
FREE_MODELS_ENV_VAR = "LLM_FREE_MODELS"

_registered = False


def _ensure_registered() -> None:
    """Seed the config key once per process (get_plugin_config writes config.json on every call)."""
    global _registered
    if not _registered:
        get_plugin_config(
            FREE_MODELS_CONFIG_KEY,
            FREE_MODELS_ENV_VAR,
            default="",
            description=PATTERN_SYNTAX + "Matching models are treated as free (e.g. models on a provider's free tier), so non-admin users may select and use them; empty means only models the provider reports as free.",
        )
        _registered = True


def reset_registration() -> None:
    """Reset the one-time registration guard. For tests only."""
    global _registered
    _registered = False


class ModelAccessDenied(Exception):
    """The user may not use the requested model; the message is user-presentable."""


def is_free_model(provider: LLMProvider, model: LLMModel) -> bool:
    """True if the provider reports `model` as free or it matches an `llm.free-models` pattern."""
    if model.get("free"):
        return True
    _ensure_registered()
    label = f"{provider.label}/{model['label']}"
    return any(pattern.search(label) for pattern in parse_patterns(get_config().get(FREE_MODELS_CONFIG_KEY, "")))


def user_may_use_model(provider: LLMProvider, model: LLMModel, user: dict[str, object] | None) -> bool:
    """
    The admin/own-key/free/default part of the access rules, without the
    model filter: True if `user` may use `model` of `provider`. `provider`
    must be the instance returned by get_provider_for_user() for that user.
    """
    return (
        user_is_admin(user)
        or provider.uses_user_key
        or is_free_model(provider, model)
        or is_default_model(provider.id, model["id"])
    )


def check_model_access(provider: LLMProvider, model_id: str, user: dict[str, object] | None) -> None:
    """
    Raise ModelAccessDenied unless `user` may use `model_id` of `provider`.
    Only consults provider.list_models() (a live round-trip for some
    providers) when the answer depends on it: a filter is configured or the
    user neither is an admin nor uses their own API key.
    """
    is_admin = user_is_admin(user)
    filtered = has_model_filter()
    if (is_admin or provider.uses_user_key) and not filtered:
        return

    model = next((m for m in provider.list_models() if m["id"] == model_id), None)
    if filtered and (model is None or not is_model_allowed(f"{provider.label}/{model['label']}")):
        raise ModelAccessDenied(f"Model '{provider.label}/{model_id}' is not permitted by the configured model filter")
    if not is_admin and not (model and user_may_use_model(provider, model, user)) and not is_default_model(provider.id, model_id):
        raise ModelAccessDenied(
            f"Model '{provider.label}/{model_id}' is not free and may only be used by administrators "
            f"unless it is the configured default model or you use your own API key for '{provider.label}'"
        )
