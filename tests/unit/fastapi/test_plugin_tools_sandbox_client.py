"""
Unit tests for the backend plugin sandbox client script generation.

Regression coverage for #478: in production, `app/src` is removed after the
frontend build (see Dockerfile), so `generate_sandbox_client_script()` must not
silently fall back to an empty method list when its usual source file
(`app/src/modules/backend-plugin-sandbox.js`) is missing. Instead it must use
the script pre-generated at build time into `app/web/sandbox-client.js`.
"""

import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi_app.lib.plugins import plugin_tools


class TestGenerateSandboxClientScript(unittest.TestCase):
    def test_uses_cached_script_when_source_missing(self):
        """When app/src is absent (production), the cached app/web/sandbox-client.js
        is used instead of extracting methods from the (missing) source file."""
        real_exists = Path.exists

        def fake_exists(path):
            if path.name == "backend-plugin-sandbox.js":
                return False
            return real_exists(path)

        with patch.object(Path, "exists", fake_exists):
            script = plugin_tools.generate_sandbox_client_script()

        self.assertIn("callPluginApi", script)
        self.assertIn("subscribeSSE", script)

    def test_falls_back_to_live_extraction_when_source_present(self):
        """When app/src is present (development), methods are still extracted
        live from the source file, not from any stale cached copy."""
        script = plugin_tools.generate_sandbox_client_script()

        self.assertIn("callPluginApi", script)
        self.assertIn("subscribeSSE", script)

    def test_warns_when_neither_source_nor_cache_available(self):
        """If both the source file and the pre-generated cache are missing,
        no method should silently disappear without a trace: a warning must
        be logged so the misconfiguration is diagnosable."""
        real_exists = Path.exists

        def fake_exists(path):
            if path.name in ("backend-plugin-sandbox.js", "sandbox-client.js"):
                return False
            return real_exists(path)

        with patch.object(Path, "exists", fake_exists):
            with self.assertLogs("fastapi_app.lib.plugins.plugin_tools", level="WARNING"):
                script = plugin_tools.generate_sandbox_client_script()

        self.assertNotIn("callPluginApi", script)


if __name__ == "__main__":
    unittest.main()
