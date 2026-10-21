"""
Supported API surface for backend plugins.

Plugins, in particular those released outside the core repository, should import
core functionality from this module. Its symbols are kept stable within a major
:data:`PLUGIN_API_VERSION`; core bumps the major version only for breaking changes
to them. Imports from other core modules keep working but may break with any
core release.

Plugins declare the API versions they work with in ``pte-plugin.json``::

    { "engines": { "pte-plugin-api": "^1.0" } }

A plugin outside the declared range is not loaded (see plugin_manifest.py).
"""

from fastapi_app.config import get_settings
from fastapi_app.lib.core.dependencies import (
    get_current_user,
    get_db,
    get_file_repository,
    get_file_storage,
    get_session_manager,
    get_sse_service,
    require_admin_user,
    require_authenticated_user,
    require_reviewer_or_admin,
)
from fastapi_app.lib.core.gc_hooks import clear_directory, register_gc_handler, unregister_gc_handler
from fastapi_app.lib.core.schema_validator import (
    register_bundled_schema,
    register_schema_config,
    register_schema_redirect,
    unregister_bundled_schema,
    unregister_schema_config,
    unregister_schema_redirect,
)
from fastapi_app.lib.doc_rules.rules_providers import (
    DocumentRulesProvider,
    register_document_rules_provider,
    unregister_document_rules_provider,
)
from fastapi_app.lib.extraction import (
    BaseExtractor,
    ExtractorRegistry,
    ExtractorUnavailableError,
    LLMBaseExtractor,
)
from fastapi_app.lib.llm import (
    LLMImage,
    LLMModel,
    LLMProvider,
    LLMProviderError,
    LLMProviderRegistry,
    ModelStatus,
    OpenAICompatibleProvider,
)
from fastapi_app.lib.plugins.frontend_extension_registry import FrontendExtensionRegistry
from fastapi_app.lib.plugins.plugin_base import Plugin, PluginContext
from fastapi_app.lib.plugins.plugin_manifest import PLUGIN_API_VERSION
from fastapi_app.lib.plugins.plugin_tools import (
    PluginConfigSpec,
    generate_datatable_page,
    get_plugin_config,
    load_plugin_html,
)
from fastapi_app.lib.repository.file_repository import FileRepository
from fastapi_app.lib.services.service_registry import BaseService, get_service_registry
from fastapi_app.lib.sse.event_bus import EventBus, get_event_bus
from fastapi_app.lib.storage.file_storage import FileStorage
from fastapi_app.lib.utils.config_utils import get_config

__all__ = [
    "PLUGIN_API_VERSION",
    "BaseExtractor",
    "BaseService",
    "DocumentRulesProvider",
    "EventBus",
    "ExtractorRegistry",
    "ExtractorUnavailableError",
    "FileRepository",
    "FileStorage",
    "FrontendExtensionRegistry",
    "LLMBaseExtractor",
    "LLMImage",
    "LLMModel",
    "LLMProvider",
    "LLMProviderError",
    "LLMProviderRegistry",
    "ModelStatus",
    "OpenAICompatibleProvider",
    "Plugin",
    "PluginConfigSpec",
    "PluginContext",
    "clear_directory",
    "generate_datatable_page",
    "get_config",
    "get_current_user",
    "get_db",
    "get_event_bus",
    "get_file_repository",
    "get_file_storage",
    "get_plugin_config",
    "get_service_registry",
    "get_session_manager",
    "get_settings",
    "get_sse_service",
    "load_plugin_html",
    "register_bundled_schema",
    "register_document_rules_provider",
    "register_gc_handler",
    "register_schema_config",
    "register_schema_redirect",
    "require_admin_user",
    "require_authenticated_user",
    "require_reviewer_or_admin",
    "unregister_bundled_schema",
    "unregister_document_rules_provider",
    "unregister_gc_handler",
    "unregister_schema_config",
    "unregister_schema_redirect",
]
