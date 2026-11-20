"""
Unit tests for the manual pages that plugins contribute: the `manual` field of the manifest, the listing of the
contributions and the file route.

@testCovers fastapi_app/lib/plugins/plugin_manifest.py
@testCovers fastapi_app/lib/plugins/plugin_manual.py
@testCovers fastapi_app/routers/manual.py
"""

import json
import shutil
import tempfile
import unittest
from pathlib import Path
from typing import Any

from fastapi import FastAPI
from fastapi.testclient import TestClient

from fastapi_app.lib.core.dependencies import get_current_user
from fastapi_app.lib.plugins.plugin_manifest import ManifestError, parse_manifest, is_safe_relative_path
from fastapi_app.lib.plugins import plugin_manual
from fastapi_app.lib.plugins.plugin_manual import ManualFileNotFound, list_contributions, resolve_manual_file
from fastapi_app.lib.plugins.plugin_registry import PluginRecord, PluginRegistry
from fastapi_app.routers import manual as manual_router

TUTORIAL = {
    "id": "llm-review",
    "slot": "tutorials",
    "title": "LLM Reviewer with GROBID",
    "description": "Review by page.",
    "file": "docs/llm-review.md",
    "requires": ["review"],
}


def manifest_text(manual: list[dict[str, Any]]) -> str:
    return json.dumps({"version": "1.0.0", "manual": manual})


class TestManifest(unittest.TestCase):
    def test_parse(self) -> None:
        manifest = parse_manifest(manifest_text([TUTORIAL, {"id": "b", "slot": "review", "title": "B", "file": {"en": "docs/b.md", "de": "docs/de/b.md"}, "roles": ["reviewer"], "order": 10}]))
        first, second = manifest.manual
        self.assertEqual(first.files, {"en": "docs/llm-review.md"})
        self.assertEqual(first.requires, ("review",))
        self.assertEqual(first.order, 500)
        self.assertEqual(second.files["de"], "docs/de/b.md")
        self.assertEqual(second.roles, ("reviewer",))

    def test_no_manual(self) -> None:
        self.assertEqual(parse_manifest("{}").manual, ())

    def test_invalid(self) -> None:
        cases: list[Any] = [
            {},
            [{**TUTORIAL, "id": "Bad Id"}],
            [TUTORIAL, TUTORIAL],
            [{**TUTORIAL, "title": ""}],
            [{**TUTORIAL, "file": "../x.md"}],
            [{**TUTORIAL, "file": "/abs/x.md"}],
            [{**TUTORIAL, "file": "docs/x.html"}],
            [{**TUTORIAL, "file": {"english": "docs/x.md"}}],
            [{**TUTORIAL, "requires": "review"}],
            [{**TUTORIAL, "order": "1"}],
        ]
        for manual in cases:
            with self.subTest(manual=manual), self.assertRaises(ManifestError):
                parse_manifest(json.dumps({"manual": manual}))

    def test_safe_relative_path(self) -> None:
        for path in ["docs/a.md", "a.md", "docs/images/x.png"]:
            self.assertTrue(is_safe_relative_path(path), path)
        for path in ["", "/a.md", "../a.md", "docs/../a.md", "docs//a.md", "./a.md", "docs\\a.md", "docs/"]:
            self.assertFalse(is_safe_relative_path(path), path)


class RegistryTestCase(unittest.TestCase):
    """A registry with the plugins `grobid` (contributes pages), `review` and `other`."""

    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp())
        self.plugin_dir = self.tmp / "grobid"
        (self.plugin_dir / "docs" / "images").mkdir(parents=True)
        (self.plugin_dir / "docs" / "llm-review.md").write_text("# Tutorial\n", encoding="utf-8")
        (self.plugin_dir / "docs" / "images" / "a.png").write_bytes(b"\x89PNG")
        (self.plugin_dir / "docs" / "images" / "a.svg").write_text("<svg/>", encoding="utf-8")
        (self.plugin_dir / "plugin.py").write_text("", encoding="utf-8")
        (self.tmp / "secret.md").write_text("no", encoding="utf-8")
        manifest = parse_manifest(manifest_text([
            TUTORIAL,
            {"id": "admin", "slot": "admin", "title": "Configure", "file": "docs/llm-review.md", "roles": ["admin"]},
            {"id": "unknown", "slot": "nowhere", "title": "X", "file": "docs/llm-review.md"},
        ]))
        self.registry = PluginRegistry()
        # the warning about the unknown slot is tested in TestContributions.test_unknown_slot_warning
        plugin_manual._warned_slots.add(("grobid", "nowhere"))
        for plugin_id, directory, mf in [("grobid", self.plugin_dir, manifest), ("review", None, None), ("other", None, None)]:
            self.registry._records[plugin_id] = PluginRecord(
                id=plugin_id, metadata={"name": plugin_id.title(), "version": "0.1"}, plugin=None, directory=directory, manifest=mf,
            )
            self.registry._order.append(plugin_id)

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp)


class TestContributions(RegistryTestCase):
    def ids(self, user: dict[str, Any] | None) -> list[tuple[str, bool]]:
        return [(c.page.id, c.active) for c in list_contributions(self.registry, user)]

    def test_annotator(self) -> None:
        self.assertEqual(self.ids({"roles": ["annotator"]}), [("llm-review", True)])

    def test_anonymous(self) -> None:
        self.assertEqual(self.ids(None), [("llm-review", True)])

    def test_admin_sees_admin_slot_after_tutorials(self) -> None:
        self.assertEqual(self.ids({"roles": ["admin"]}), [("llm-review", True), ("admin", True)])

    def test_required_plugin_disabled(self) -> None:
        self.registry.set_disabled({"review"})
        self.assertEqual(self.ids({"roles": ["annotator"]}), [])
        self.assertEqual(self.ids({"roles": ["admin"]}), [("llm-review", False), ("admin", True)])

    def test_plugin_disabled(self) -> None:
        self.registry.set_disabled({"grobid"})
        self.assertEqual(self.ids({"roles": ["annotator"]}), [])
        self.assertEqual(self.ids({"roles": ["admin"]}), [("llm-review", False), ("admin", False)])

    def test_unknown_slot_warning(self) -> None:
        plugin_manual._warned_slots.clear()
        with self.assertLogs("fastapi_app.lib.plugins.plugin_manual", "WARNING") as logs:
            self.ids(None)
        self.assertIn("unknown slot 'nowhere'", logs.output[0])

    def test_failed_plugin_not_listed(self) -> None:
        self.registry._records["grobid"].load_status = "failed"
        self.assertEqual(self.ids({"roles": ["admin"]}), [])


class TestFiles(RegistryTestCase):
    def test_resolve(self) -> None:
        path, media_type = resolve_manual_file(self.registry, "grobid", "docs/llm-review.md")
        self.assertEqual(path.name, "llm-review.md")
        self.assertTrue(media_type.startswith("text/markdown"))
        self.assertEqual(resolve_manual_file(self.registry, "grobid", "docs/images/a.png")[1], "image/png")

    def test_rejected(self) -> None:
        for plugin_id, path in [
            ("grobid", "plugin.py"),
            ("grobid", "docs/images/a.svg"),
            ("grobid", "docs/../../secret.md"),
            ("grobid", "docs/missing.md"),
            ("review", "docs/llm-review.md"),
            ("nope", "docs/llm-review.md"),
        ]:
            with self.subTest(path=path), self.assertRaises(ManualFileNotFound):
                resolve_manual_file(self.registry, plugin_id, path)

    def test_symlink_out_of_directory(self) -> None:
        (self.plugin_dir / "docs" / "link.md").symlink_to(self.tmp / "secret.md")
        with self.assertRaises(ManualFileNotFound):
            resolve_manual_file(self.registry, "grobid", "docs/link.md")


class TestRouter(RegistryTestCase):
    def setUp(self) -> None:
        super().setUp()
        app = FastAPI()
        app.include_router(manual_router.router, prefix="/api/v1")
        app.dependency_overrides[manual_router.get_plugin_registry] = lambda: self.registry
        self.user: dict[str, Any] | None = {"username": "a", "roles": ["annotator"]}
        app.dependency_overrides[get_current_user] = lambda: self.user
        self.client = TestClient(app)

    def test_contributions(self) -> None:
        response = self.client.get("/api/v1/manual/contributions")
        self.assertEqual(response.status_code, 200)
        [item] = response.json()["contributions"]
        self.assertEqual(item["plugin_id"], "grobid")
        self.assertEqual(item["plugin_name"], "Grobid")
        self.assertEqual(item["files"], {"en": "docs/llm-review.md"})
        self.assertTrue(item["active"])

    def test_file(self) -> None:
        response = self.client.get("/api/v1/manual/plugins/grobid/docs/llm-review.md")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.text, "# Tutorial\n")
        self.assertEqual(response.headers["x-content-type-options"], "nosniff")
        self.assertEqual(self.client.get("/api/v1/manual/plugins/grobid/plugin.py").status_code, 404)


if __name__ == "__main__":
    unittest.main()
