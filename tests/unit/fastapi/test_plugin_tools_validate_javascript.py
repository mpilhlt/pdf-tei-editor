"""
Unit tests for the extension convention check (validate_javascript_content() in plugin_tools)
and for serving extensions that break a convention.

@testCovers fastapi_app/lib/plugins/plugin_tools.py
@testCovers fastapi_app/routers/plugins.py
"""

import asyncio
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

from fastapi_app.lib.plugins.plugin_tools import validate_javascript_content
from fastapi_app.routers.plugins import get_extensions_bundle


class TestValidateJavascriptStorage(unittest.TestCase):
    """Storage access is flagged; storage names as object literal keys are not."""

    def _warnings(self, code: str) -> list[str]:
        return validate_javascript_content(code, "ext.js")[1]

    def test_object_literal_key_is_not_storage_access(self) -> None:
        code = "const display = new FindingsDisplay({\n  source: SOURCE,\n  sessionStorage: new SessionStorage(SOURCE),\n  localStorage : x, indexedDB: y\n});"
        self.assertEqual(self._warnings(code), [])

    def test_global_access_is_flagged(self) -> None:
        for code, expected in [
            ("sessionStorage.setItem('a', 'b');", "sessionStorage access"),
            ("const v = window.localStorage.getItem('a');", "localStorage access"),
            ("const req = indexedDB.open('db');", "IndexedDB access"),
            ("const s = { store: sessionStorage };", "sessionStorage access"),
            ("const s = flag ? sessionStorage : null;", "sessionStorage access"),
        ]:
            with self.subTest(code=code):
                warnings = self._warnings(code)
                self.assertEqual(len(warnings), 1, warnings)
                self.assertIn(expected, warnings[0])

    def test_names_in_comments_are_ignored(self) -> None:
        self.assertEqual(self._warnings("/** reads sessionStorage */\n// localStorage\nconst a = 1;"), [])


class TestExtensionsBundle(unittest.TestCase):
    """An extension that breaks a convention is served with a console warning."""

    def test_flagged_extension_is_served(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            js_file = Path(tmp) / "extensions" / "ext.js"
            js_file.parent.mkdir()
            js_file.write_text("export default class Ext extends FrontendExtensionPlugin {\n  start() { localStorage.getItem('a'); }\n}\n", encoding="utf-8")
            registry = MagicMock()
            registry.get_extension_files.return_value = [(js_file, "my-plugin")]
            with patch("fastapi_app.routers.plugins.FrontendExtensionRegistry.get_instance", return_value=registry):
                bundle = bytes(asyncio.run(get_extensions_bundle()).body).decode()
        self.assertIn('console.warn("Frontend extension ext.js from my-plugin breaks the extension conventions: ext.js: localStorage access detected")', bundle)
        self.assertIn('window.registerFrontendExtension(Ext, "my-plugin")', bundle)


if __name__ == "__main__":
    unittest.main()
