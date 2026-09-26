"""Serializable plugin information for the admin API."""

from typing import Any

from fastapi_app.config import GITHUB_REPO_URL
from fastapi_app.lib.plugins.plugin_registry import PluginRecord, PluginRegistry


def readme_url_for(record: PluginRecord) -> str | None:
    """
    README link for a plugin.

    Uses the `readme_url` metadata override if present; otherwise a GitHub URL for
    built-in plugins that ship a README.md; otherwise None.

    Args:
        record: Plugin record

    Returns:
        URL or None
    """
    override = record.metadata.get("readme_url")
    if override:
        return str(override)
    if record.external or record.directory is None:
        return None
    if not (record.directory / "README.md").is_file():
        return None
    return f"{GITHUB_REPO_URL}/blob/main/fastapi_app/plugins/{record.directory.name}/README.md"


def build_plugin_info(registry: PluginRegistry, record: PluginRecord) -> dict[str, Any]:
    """
    Assemble the admin info dict for one plugin.

    Args:
        registry: Plugin registry (provides derived status and dependents)
        record: Plugin record

    Returns:
        Dict matching the PluginAdminInfo response model
    """
    status, reason = registry.status(record.id)
    meta = record.metadata
    directory = record.directory
    ext_dir = directory / "extensions" if directory else None
    return {
        "id": record.id,
        "name": str(meta.get("name", record.id)),
        "version": str(meta.get("version", "")),
        "description": str(meta.get("description", "")),
        "category": str(meta.get("category", "")),
        "required_roles": list(meta.get("required_roles", [])),
        "status": status,
        "status_reason": reason,
        "enabled": record.id not in registry.disabled,
        "protected": bool(meta.get("protected", False)),
        "dependencies": record.dependencies,
        "dependents": registry.dependents(record.id, transitive=True),
        "source": "external" if record.external else "builtin",
        "readme_url": readme_url_for(record),
        "has_routes": bool(directory and (directory / "routes.py").is_file()),
        "has_frontend_extension": bool(ext_dir and ext_dir.is_dir() and any(ext_dir.glob("*.js"))),
        "menu_endpoints": len(meta["endpoints"]) if "endpoints" in meta else 1,
    }
