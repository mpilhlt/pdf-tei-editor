"""
Unit tests for validate_javascript_content() in plugin_tools.

@testCovers fastapi_app/lib/plugins/plugin_tools.py
"""

import unittest

from fastapi_app.lib.plugins.plugin_tools import validate_javascript_content


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


if __name__ == "__main__":
    unittest.main()
