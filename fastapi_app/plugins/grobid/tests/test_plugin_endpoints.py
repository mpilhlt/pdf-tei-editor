"""
Unit tests for fastapi_app/plugins/grobid/plugin.py endpoint metadata.

Run manually:
    uv run python tests/unit-test-runner.py fastapi_app/plugins/grobid/tests/test_plugin_endpoints.py -v

@testCovers fastapi_app/plugins/grobid/plugin.py
"""

import asyncio
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).parent.parent.parent.parent.parent))


class PluginEndpointMetadataTestCase(unittest.TestCase):
    def test_reload_feature_file_endpoint_is_grouped_under_grobid_category(self):
        from fastapi_app.plugins.grobid.plugin import GrobidPlugin

        plugin = GrobidPlugin.__new__(GrobidPlugin)  # skip __init__ (config bootstrap)
        endpoints = {e["name"]: e for e in plugin.metadata["endpoints"]}
        self.assertEqual(endpoints["reload_feature_file"]["category"], "grobid")
        self.assertEqual(endpoints["reload_feature_file"]["label"], "Reload Feature File")

    def test_refresh_annotation_rules_endpoint_is_registered(self):
        from fastapi_app.plugins.grobid.plugin import GrobidPlugin

        plugin = GrobidPlugin.__new__(GrobidPlugin)  # skip __init__ (config bootstrap)
        endpoints = {e["name"]: e for e in plugin.metadata["endpoints"]}
        self.assertIn("refresh_annotation_rules", endpoints)
        self.assertEqual(endpoints["refresh_annotation_rules"]["category"], "grobid")
        self.assertEqual(endpoints["refresh_annotation_rules"]["state_params"], ["xml"])
        self.assertIn("refresh_annotation_rules", plugin.get_endpoints())


class RefreshAnnotationRulesTriggerTestCase(unittest.TestCase):
    """Tests for GrobidPlugin.refresh_annotation_rules(), the preview/execute trigger."""

    def setUp(self):
        from fastapi_app.plugins.grobid.plugin import GrobidPlugin

        self.plugin = GrobidPlugin.__new__(GrobidPlugin)  # skip __init__ (config bootstrap)
        self.context = mock.Mock()
        self.context.user = {"roles": ["reviewer"]}

    def run_async(self, coro):
        return asyncio.run(coro)

    def test_requires_reviewer_role(self):
        with mock.patch(
            "fastapi_app.lib.permissions.acl_utils.user_has_role", return_value=False
        ):
            result = self.run_async(
                self.plugin.refresh_annotation_rules(self.context, {"xml": "tei-1"})
            )
        self.assertIn("error", result)

    def test_errors_when_no_document_open(self):
        with mock.patch(
            "fastapi_app.lib.permissions.acl_utils.user_has_role", return_value=True
        ):
            result = self.run_async(self.plugin.refresh_annotation_rules(self.context, {}))
        self.assertIn("error", result)

    def test_returns_preview_and_execute_urls_for_stable_id(self):
        with mock.patch(
            "fastapi_app.lib.permissions.acl_utils.user_has_role", return_value=True
        ):
            result = self.run_async(
                self.plugin.refresh_annotation_rules(self.context, {"xml": "tei-1"})
            )

        self.assertNotIn("error", result)
        self.assertEqual(
            result["outputUrl"],
            "/api/plugins/grobid/refresh-annotation-rules/preview?xml=tei-1",
        )
        self.assertEqual(
            result["executeUrl"],
            "/api/plugins/grobid/refresh-annotation-rules/execute?xml=tei-1",
        )


if __name__ == "__main__":
    unittest.main()
