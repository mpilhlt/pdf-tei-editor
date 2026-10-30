"""
Unit tests for the templates and stylesheets of backend plugin frontend extensions.

@testCovers fastapi_app/lib/plugins/extension_templates.py
@testCovers fastapi_app/routers/plugins.py
@testCovers tests/fixtures/plugins/reference_plugin/templates/dialog.html
"""

import json
import re
import shutil
import tempfile
import unittest
from pathlib import Path

from fastapi_app.lib.plugins.extension_templates import (
    PluginAssets,
    collect_plugin_assets,
    name_prefix,
    render_plugin_assets,
    templates_dir_for,
    top_level_names,
    validate_stylesheet,
    validate_template_html,
)

REFERENCE_PLUGIN = Path(__file__).parents[2] / "fixtures" / "plugins" / "reference_plugin"


class TestValidation(unittest.TestCase):
    def test_accepts_plain_markup(self):
        self.assertEqual(validate_template_html('<sl-dialog name="x" label="${title}"><p>On top</p></sl-dialog>'), [])

    def test_rejects_script(self):
        self.assertTrue(validate_template_html('<div><SCRIPT>alert(1)</SCRIPT></div>'))

    def test_rejects_inline_handlers(self):
        self.assertTrue(validate_template_html('<img src="x" onerror="alert(1)">'))
        self.assertTrue(validate_template_html('<sl-button\n  onclick = "x()">'))

    def test_rejects_javascript_urls(self):
        self.assertTrue(validate_template_html('<a href="JavaScript:alert(1)">x</a>'))

    def test_stylesheet(self):
        self.assertEqual(validate_stylesheet('a { background: url("data:image/png;base64,AA") } b { background: url(img/x.png) } c { background: url(/api/plugins/x/static/y.png) }'), [])
        self.assertTrue(validate_stylesheet('@import url("x.css");'))
        self.assertTrue(validate_stylesheet('a { width: expression(alert(1)) }'))
        self.assertTrue(validate_stylesheet('a { background: url(javascript:alert(1)) }'))
        self.assertTrue(validate_stylesheet('a { background: url("https://evil.example/x.png") }'))


class TestNames(unittest.TestCase):
    def test_name_prefix(self):
        self.assertEqual(name_prefix("reference-plugin"), "referencePlugin")
        self.assertEqual(name_prefix("my_plugin"), "myPlugin")
        self.assertEqual(name_prefix("grobid"), "grobid")

    def test_top_level_names(self):
        html = '<sl-dialog name="a"><br><div name="inner"></div></sl-dialog><input name="b"><span name="c"/>'
        self.assertEqual(top_level_names(html), ["a", "b", "c"])


class TestCollect(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp())
        self.extensions = self.root / "extensions"
        self.templates = self.root / "templates"
        self.extensions.mkdir()
        self.templates.mkdir()

    def tearDown(self):
        shutil.rmtree(self.root)

    def test_templates_dir_from_extension_path(self):
        self.assertEqual(templates_dir_for(self.extensions / "x.js"), self.templates)

    def test_missing_directory(self):
        shutil.rmtree(self.templates)
        assets = collect_plugin_assets(self.templates, "p")
        self.assertEqual((assets.templates, assets.stylesheet, assets.errors), ({}, "", []))

    def test_collects_html_by_stem_and_css(self):
        (self.templates / "my-dialog.html").write_text('  <sl-dialog name="pDialog"></sl-dialog>\n')
        (self.templates / "b.css").write_text("b { color: red }")
        (self.templates / "a.css").write_text("a { color: blue }")
        (self.templates / "notes.txt").write_text("ignored")
        (self.templates / "sub").mkdir()
        (self.templates / "sub" / "nested.html").write_text("<div></div>")
        assets = collect_plugin_assets(self.templates, "p")
        self.assertEqual(assets.templates, {"my-dialog": '<sl-dialog name="pDialog"></sl-dialog>'})
        self.assertEqual(assets.stylesheet, "/* a.css */\na { color: blue }\n\n/* b.css */\nb { color: red }")
        self.assertEqual(assets.errors, [])

    def test_rejected_files_are_skipped(self):
        (self.templates / "ok.html").write_text("<div></div>")
        (self.templates / "bad.html").write_text('<img onerror="x">')
        (self.templates / "bad.css").write_text("@import 'x';")
        assets = collect_plugin_assets(self.templates, "p")
        self.assertEqual(list(assets.templates), ["ok"])
        self.assertEqual(assets.stylesheet, "")
        self.assertEqual(len(assets.errors), 2)

    def test_warns_about_unprefixed_names(self):
        (self.templates / "d.html").write_text('<sl-dialog name="dialog"></sl-dialog>')
        with self.assertLogs("fastapi_app.lib.plugins.extension_templates", level="WARNING") as logs:
            assets = collect_plugin_assets(self.templates, "my-plugin")
        self.assertIn("myPlugin", logs.output[0])
        self.assertEqual(list(assets.templates), ["d"])


class TestRender(unittest.TestCase):
    def test_empty(self):
        self.assertEqual(render_plugin_assets("p", PluginAssets()), "")

    def test_calls_are_json_literals(self):
        assets = PluginAssets(templates={"d": '<p title="${x}">`</script>`</p>'}, stylesheet="p { }", errors=["bad.html: rejected"])
        js = render_plugin_assets("my-plugin", assets)
        self.assertIn("// Skipped template file from my-plugin: bad.html: rejected", js)
        self.assertLess(js.index("registerFrontendExtensionStyles"), js.index("registerFrontendExtensionTemplates"))
        match = re.search(r'window\.registerFrontendExtensionTemplates\("my-plugin", (.*)\);$', js, flags=re.MULTILINE)
        assert match is not None
        self.assertEqual(json.loads(match.group(1)), assets.templates)


class TestReferencePlugin(unittest.TestCase):
    def test_reference_plugin_assets_are_valid(self):
        assets = collect_plugin_assets(REFERENCE_PLUGIN / "templates", "reference-plugin")
        self.assertEqual(assets.errors, [])
        self.assertEqual(sorted(assets.templates), ["dialog", "toolbar-button"])
        self.assertIn("reference-plugin-dialog", assets.stylesheet)
        for html in assets.templates.values():
            for name in top_level_names(html):
                self.assertTrue(name.startswith("referencePlugin"), name)


if __name__ == "__main__":
    unittest.main()
