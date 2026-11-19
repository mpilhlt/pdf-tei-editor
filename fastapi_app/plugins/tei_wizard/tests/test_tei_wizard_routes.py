"""
Tests for the TEI Wizard Enhancement Registry Routes.

@testCovers fastapi_app/plugins/tei_wizard/routes.py
"""

import json
import shutil
import subprocess
import unittest

from fastapi_app.plugins.tei_wizard.routes import transform_to_registration


class TestTransformToRegistration(unittest.TestCase):
    """Tests for the transform_to_registration function."""

    def test_transforms_named_exports(self):
        """Transforms ES module with named exports to IIFE."""
        content = '''export const name = "Test Enhancement";
export const description = "A test enhancement";

export function execute(xmlDoc, state, config) {
  return xmlDoc;
}'''

        result = transform_to_registration(content, "test.js", "test-plugin")

        # Should contain the IIFE wrapper
        self.assertIn("(function() {", result)
        self.assertIn("})();", result)

        # Should remove export keywords
        self.assertIn('const name = "Test Enhancement"', result)
        self.assertIn('const description = "A test enhancement"', result)
        self.assertIn("function execute(xmlDoc, state, config)", result)

        # Should not contain export keywords
        self.assertNotIn("export const", result)
        self.assertNotIn("export function", result)

        # Should contain registration call
        self.assertIn("window.registerTeiEnhancement({", result)
        self.assertIn('pluginId: "test-plugin"', result)

    def test_removes_import_statements(self):
        """Removes ES module import statements."""
        content = '''import { something } from '../module.js';
import * as utils from '../utils.js';

export const name = "Test";
export const description = "Desc";
export function execute(doc) { return doc; }'''

        result = transform_to_registration(content, "test.js", "plugin")

        self.assertNotIn("import", result)
        self.assertIn('const name = "Test"', result)

    def test_removes_export_default(self):
        """Removes export default statements."""
        content = '''export const name = "Test";
export const description = "Desc";
export function execute(doc) { return doc; }

export default { name, description, execute };'''

        result = transform_to_registration(content, "test.js", "plugin")

        # export default line should be removed
        self.assertNotIn("export default", result)

    def test_includes_plugin_comment(self):
        """Includes a comment with plugin ID and filename."""
        content = '''export const name = "Test";
export const description = "Desc";
export function execute(doc) { return doc; }'''

        result = transform_to_registration(content, "my-enhancement.js", "my-plugin")

        self.assertIn("// Enhancement from plugin: my-plugin (my-enhancement.js)", result)

    def test_preserves_function_body(self):
        """Preserves the function body content."""
        content = '''export const name = "Complex";
export const description = "Complex enhancement";

export function execute(xmlDoc, state, config) {
  const root = xmlDoc.documentElement;
  if (root) {
    root.setAttribute('processed', 'true');
  }
  return xmlDoc;
}'''

        result = transform_to_registration(content, "test.js", "plugin")

        self.assertIn("const root = xmlDoc.documentElement", result)
        self.assertIn("root.setAttribute('processed', 'true')", result)

    def test_handles_multiline_strings(self):
        """Handles multiline template strings in code."""
        content = '''export const name = "Multiline";
export const description = "Has multiline strings";

export function execute(xmlDoc) {
  const template = `
    <element>
      content
    </element>
  `;
  return xmlDoc;
}'''

        result = transform_to_registration(content, "test.js", "plugin")

        self.assertIn("const template = `", result)
        self.assertIn("<element>", result)


class TestOptionalExports(unittest.TestCase):
    """The optional exports variants and appliesTo are passed into the registration."""

    def _register(self, content: str) -> dict[str, object]:
        """Run the transformed bundle in Node and return what it registered."""
        node = shutil.which("node")
        if not node:
            self.skipTest("node not available")
        bundle = transform_to_registration(content, "test.js", "plugin")
        script = "let r; globalThis.window = { registerTeiEnhancement: e => { r = e; } };\n" + bundle + "\nprocess.stdout.write(JSON.stringify({ name: r.name, variants: r.variants ?? null, appliesTo: r.appliesTo ?? null, execute: typeof r.execute }));"
        result = subprocess.run([node, "-e", script], capture_output=True, text=True, check=True)
        return json.loads(result.stdout)

    def test_without_optional_exports(self):
        """Enhancements without the exports register them as undefined."""
        registered = self._register('export const name = "A";\nexport const description = "D";\nexport function execute(doc) { return doc; }')
        self.assertEqual(registered, {"name": "A", "variants": None, "appliesTo": None, "execute": "function"})

    def test_with_optional_exports(self):
        """Declared exports are passed on."""
        registered = self._register('export const name = "A";\nexport const description = "D";\nexport const variants = ["v1", "v2.*"];\nexport const appliesTo = "//tei:listBibl";\nexport function execute(doc) { return doc; }')
        self.assertEqual(registered["variants"], ["v1", "v2.*"])
        self.assertEqual(registered["appliesTo"], "//tei:listBibl")


class TestEnhancementsEndpoint(unittest.TestCase):
    """Tests for the /enhancements.js endpoint."""

    # Note: Full integration tests would require mocking PluginManager
    # These are covered in the E2E tests

    pass


if __name__ == "__main__":
    unittest.main()
