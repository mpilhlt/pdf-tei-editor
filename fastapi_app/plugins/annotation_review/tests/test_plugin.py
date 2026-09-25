"""
Unit tests for the annotation-review plugin registration.

@testCovers fastapi_app/plugins/annotation_review/plugin.py
"""

import unittest
from unittest import mock

from fastapi_app.lib.plugins.frontend_extension_registry import (
    FrontendExtensionRegistry,
)
from fastapi_app.lib.plugins.plugin_base import PluginContext
from fastapi_app.plugins.annotation_review.plugin import AnnotationReviewPlugin


class TestAnnotationReviewPlugin(unittest.TestCase):
    def test_metadata(self):
        plugin = AnnotationReviewPlugin()
        metadata = plugin.metadata
        self.assertEqual(metadata["id"], "annotation-review")
        self.assertEqual(metadata["category"], "annotation")
        self.assertIn("user", metadata["required_roles"])

    def test_is_available_defaults_true(self):
        self.assertTrue(AnnotationReviewPlugin.is_available())

    def test_get_endpoints_returns_empty_dict(self):
        plugin = AnnotationReviewPlugin()
        self.assertEqual(plugin.get_endpoints(), {})

    async def _initialize(self, plugin):
        context = PluginContext()
        await plugin.initialize(context)

    def test_initialize_registers_frontend_extension(self):
        import asyncio

        plugin = AnnotationReviewPlugin()
        with mock.patch.object(FrontendExtensionRegistry, "get_instance") as mock_get_instance:
            mock_registry = mock.MagicMock()
            mock_get_instance.return_value = mock_registry
            asyncio.run(self._initialize(plugin))
            mock_registry.register_extension.assert_called_once()
            args, _ = mock_registry.register_extension.call_args
            extension_path, plugin_id = args
            self.assertTrue(str(extension_path).endswith("annotation-review.js"))
            self.assertEqual(plugin_id, "annotation-review")


if __name__ == "__main__":
    unittest.main()
