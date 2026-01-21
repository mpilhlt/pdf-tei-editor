"""
Routes for the TEI Wizard Enhancement Registry.

Provides the /api/plugins/tei-wizard/enhancements.js endpoint that returns
a bundled JavaScript file containing all registered enhancements.
"""

import re

from fastapi import APIRouter
from fastapi.responses import PlainTextResponse

from fastapi_app.lib.plugin_manager import PluginManager

router = APIRouter(prefix="/api/plugins/tei-wizard", tags=["tei-wizard"])


def transform_to_registration(content: str, filename: str, plugin_id: str) -> str:
    """
    Transform ES module enhancement to self-registering IIFE format.

    Input (ES module with named exports):
        export const name = "...";
        export const description = "...";
        export function execute(xmlDoc, currentState, configMap) { ... }

    Output (self-registering IIFE):
        (function() {
          const name = "...";
          const description = "...";
          function execute(xmlDoc, currentState, configMap) { ... }
          window.registerTeiEnhancement({
            name: name,
            description: description,
            pluginId: "...",
            execute: execute
          });
        })();

    Args:
        content: Original JavaScript content
        filename: Name of the enhancement file
        plugin_id: ID of the plugin providing this enhancement

    Returns:
        Transformed JavaScript code
    """
    # Remove import statements
    content = re.sub(r"^import\s+.*?;?\s*$", "", content, flags=re.MULTILINE)

    # Remove 'export' keywords from named exports
    content = re.sub(r"^export\s+const\s+", "const ", content, flags=re.MULTILINE)
    content = re.sub(r"^export\s+function\s+", "function ", content, flags=re.MULTILINE)

    # Remove any 'export default' statements
    content = re.sub(r"^export\s+default\s+.*?;\s*$", "", content, flags=re.MULTILINE)

    # Wrap in IIFE with registration call
    return f"""// Enhancement from plugin: {plugin_id} ({filename})
(function() {{
{content.strip()}
window.registerTeiEnhancement({{
  name: name,
  description: description,
  pluginId: "{plugin_id}",
  execute: execute
}});
}})();"""


@router.get("/enhancements.js", response_class=PlainTextResponse)
async def get_enhancements_bundle():
    """
    Return concatenated JavaScript of all registered enhancements.
    Each enhancement self-registers via window.registerTeiEnhancement().
    """
    bundle_parts = []

    plugin_manager = PluginManager.get_instance()
    tei_wizard = plugin_manager.registry.get_plugin("tei-wizard")

    if not tei_wizard:
        return PlainTextResponse(
            content="// tei-wizard plugin not found\n",
            media_type="application/javascript",
        )

    for js_file, plugin_id in tei_wizard.get_enhancement_files():
        try:
            content = js_file.read_text()
            transformed = transform_to_registration(content, js_file.name, plugin_id)
            bundle_parts.append(transformed)
        except Exception as e:
            bundle_parts.append(
                f"// Error loading {js_file.name} from {plugin_id}: {e}\n"
            )

    bundle = "\n\n".join(bundle_parts)

    return PlainTextResponse(content=bundle, media_type="application/javascript")
