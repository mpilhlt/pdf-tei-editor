"""
Lifecycle tests of the tei-wizard plugin: cleanup() undoes initialize().

@testCovers fastapi_app/plugins/tei_wizard/plugin.py
"""

import unittest
from pathlib import Path

from fastapi_app.lib.plugins.frontend_extension_registry import FrontendExtensionRegistry


class TestTeiWizardLifecycle(unittest.IsolatedAsyncioTestCase):
    def tearDown(self):
        FrontendExtensionRegistry.reset_instance()

    async def test_cleanup_then_initialize_is_symmetric(self):
        from fastapi_app.plugins.tei_wizard.plugin import TeiWizardPlugin
        p = TeiWizardPlugin()
        await p.initialize(None)
        first = list(p._enhancement_files)
        self.assertTrue(first)
        await p.cleanup()
        self.assertEqual(p._enhancement_files, [])
        await p.initialize(None)
        self.assertEqual(p._enhancement_files, first)

    async def test_unregister_enhancements_by_plugin(self):
        from fastapi_app.plugins.tei_wizard.plugin import TeiWizardPlugin
        p = TeiWizardPlugin()
        p.register_enhancement(Path(__file__), "meta")
        p.unregister_enhancements("meta")
        self.assertEqual([pid for _, pid in p._enhancement_files], [])


if __name__ == "__main__":
    unittest.main()
