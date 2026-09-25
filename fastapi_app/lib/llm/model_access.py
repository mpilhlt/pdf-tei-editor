"""
Authorization for using a given LLM model: the admin-configured
include/exclude filter applies to everyone; models that are not free are
usable by admins and, for other users, only when an admin made them the
default model.
"""

from fastapi_app.lib.llm.base import LLMProvider
from fastapi_app.lib.llm.default_model import is_default_model
from fastapi_app.lib.llm.model_filter import has_model_filter, is_model_allowed
from fastapi_app.lib.permissions.acl_utils import user_is_admin


class ModelAccessDenied(Exception):
    """The user may not use the requested model; the message is user-presentable."""


def check_model_access(provider: LLMProvider, model_id: str, user: dict[str, object] | None) -> None:
    """
    Raise ModelAccessDenied unless `user` may use `model_id` of `provider`.
    Only consults provider.list_models() (a live round-trip for some
    providers) when the answer depends on it: a filter is configured or the
    user is not an admin.
    """
    is_admin = user_is_admin(user)
    filtered = has_model_filter()
    if is_admin and not filtered:
        return

    model = next((m for m in provider.list_models() if m["id"] == model_id), None)
    if filtered and (model is None or not is_model_allowed(f"{provider.label}/{model['label']}")):
        raise ModelAccessDenied(f"Model '{provider.label}/{model_id}' is not permitted by the configured model filter")
    if not is_admin and not (model and model.get("free")) and not is_default_model(provider.id, model_id):
        raise ModelAccessDenied(
            f"Model '{provider.label}/{model_id}' is not free and may only be used by administrators "
            f"unless it is the configured default model"
        )
