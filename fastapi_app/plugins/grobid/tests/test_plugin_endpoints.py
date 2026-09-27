"""
Unit tests for fastapi_app/plugins/grobid/plugin.py endpoint metadata.

Run manually:
    uv run python tests/unit-test-runner.py fastapi_app/plugins/grobid/tests/test_plugin_endpoints.py -v

@testCovers fastapi_app/plugins/grobid/plugin.py
"""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent.parent.parent.parent))


class PluginEndpointMetadataTestCase(unittest.TestCase):
    def test_reload_feature_file_endpoint_is_grouped_under_grobid_category(self):
        from fastapi_app.plugins.grobid.plugin import GrobidPlugin

        plugin = GrobidPlugin.__new__(GrobidPlugin)  # skip __init__ (config bootstrap)
        endpoints = {e["name"]: e for e in plugin.metadata["endpoints"]}
        self.assertEqual(endpoints["reload_feature_file"]["category"], "grobid")
        self.assertEqual(endpoints["reload_feature_file"]["label"], "Reload Feature File")


if __name__ == "__main__":
    unittest.main()
