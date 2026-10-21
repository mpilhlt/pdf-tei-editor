"""
The metadata-extraction plugin registers its enhancement with tei-wizard and removes it on cleanup.

@testCovers fastapi_app/plugins/metadata_extraction/plugin.py
"""

import unittest

from fastapi_app.lib.plugins.frontend_extension_registry import FrontendExtensionRegistry
from fastapi_app.lib.plugins.plugin_base import PluginContext
from fastapi_app.lib.plugins.plugin_registry import PluginRegistry


class TestTeiWizardEnhancement(unittest.IsolatedAsyncioTestCase):
    def tearDown(self):
        FrontendExtensionRegistry.reset_instance()

    async def test_dependent_cleanup_removes_its_enhancements(self):
        from fastapi_app.plugins.metadata_extraction.plugin import MetadataExtractionPlugin
        from fastapi_app.plugins.tei_wizard.plugin import TeiWizardPlugin
        registry = PluginRegistry()
        wizard, meta = TeiWizardPlugin(), MetadataExtractionPlugin()
        registry._register_with_dependencies([meta, wizard])
        await wizard.initialize(None)
        base = len(wizard._enhancement_files)
        await meta.initialize(PluginContext(plugin_id="metadata-extraction", registry=registry))
        self.assertEqual(len(wizard._enhancement_files), base + 1)
        await meta.cleanup()
        self.assertEqual(len(wizard._enhancement_files), base)


if __name__ == "__main__":
    unittest.main()
