"""
Unit tests for the manual pages that plugins contribute: the `manual` field of the manifest, the listing of the
contributions and the file route.

@testCovers fastapi_app/lib/plugins/plugin_manifest.py
@testCovers fastapi_app/lib/plugins/plugin_manual.py
@testCovers fastapi_app/routers/manual.py
@testCovers fastapi_app/lib/utils/manual_pages.py
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
from fastapi_app.lib.utils.manual_pages import list_manual_pages
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
        self.assertEqual(first.anchors, {})

    def test_anchor(self) -> None:
        [page] = parse_manifest(manifest_text([{**TUTORIAL, "file": {"en": "docs/a.md#transfer-step_2", "de": "docs/de/a.md"}}])).manual
        self.assertEqual(page.files, {"en": "docs/a.md", "de": "docs/de/a.md"})
        self.assertEqual(page.anchors, {"en": "transfer-step_2"})

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
            [{**TUTORIAL, "file": "docs/x.md#"}],
            [{**TUTORIAL, "file": "docs/x.md#Upper"}],
            [{**TUTORIAL, "file": "docs/x.md#a#b"}],
            [{**TUTORIAL, "file": "docs/x#a.md"}],
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
            {"id": "models", "slot": "inference", "title": "Models", "file": "docs/llm-review.md#tutorial", "roles": ["admin"]},
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

    def test_admin_sees_slots_in_order(self) -> None:
        self.assertEqual(self.ids({"roles": ["admin"]}), [("llm-review", True), ("models", True), ("admin", True)])

    def test_required_plugin_disabled(self) -> None:
        self.registry.set_disabled({"review"})
        self.assertEqual(self.ids({"roles": ["annotator"]}), [])
        self.assertEqual(self.ids({"roles": ["admin"]}), [("llm-review", False), ("models", True), ("admin", True)])

    def test_plugin_disabled(self) -> None:
        self.registry.set_disabled({"grobid"})
        self.assertEqual(self.ids({"roles": ["annotator"]}), [])
        self.assertEqual(self.ids({"roles": ["admin"]}), [("llm-review", False), ("models", False), ("admin", False)])

    def test_unknown_slot_warning(self) -> None:
        plugin_manual._warned_slots.clear()
        with self.assertLogs("fastapi_app.lib.plugins.plugin_manual", "WARNING") as logs:
            self.ids(None)
        self.assertIn("unknown slot 'nowhere'", logs.output[0])

    def test_all_roles(self) -> None:
        all_roles = [(c.page.id, c.active) for c in list_contributions(self.registry, None, all_roles=True)]
        self.assertEqual(all_roles, [("llm-review", True), ("models", True), ("admin", True)])

    def test_all_roles_without_inactive_plugins(self) -> None:
        self.registry.set_disabled({"review"})
        all_roles = [(c.page.id, c.active) for c in list_contributions(self.registry, {"roles": ["admin"]}, all_roles=True)]
        self.assertEqual(all_roles, [("models", True), ("admin", True)])

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
        self.app = app
        self.client = TestClient(app)

    def test_contributions(self) -> None:
        response = self.client.get("/api/v1/manual/contributions")
        self.assertEqual(response.status_code, 200)
        [item] = response.json()["contributions"]
        self.assertEqual(item["plugin_id"], "grobid")
        self.assertEqual(item["plugin_name"], "Grobid")
        self.assertEqual(item["files"], {"en": "docs/llm-review.md"})
        self.assertEqual(item["anchors"], {})
        self.assertTrue(item["active"])

    def test_contributions_all_roles(self) -> None:
        response = self.client.get("/api/v1/manual/contributions", params={"all_roles": "true"})
        self.assertEqual([item["id"] for item in response.json()["contributions"]], ["llm-review", "models", "admin"])

    def test_pages(self) -> None:
        docs = self.tmp / "docs"
        (docs / "user-manual").mkdir(parents=True)
        (docs / "index.md").write_text("# Home\n\n- [B](user-manual/b.md)\n- [A](./user-manual/a.md#x)\n", encoding="utf-8")
        (docs / "user-manual" / "a.md").write_text("# A\n", encoding="utf-8")
        (docs / "user-manual" / "b.md").write_text("# B\n", encoding="utf-8")
        self.app.dependency_overrides[manual_router.get_docs_root] = lambda: docs
        response = self.client.get("/api/v1/manual/pages")
        self.assertEqual(response.json()["pages"], [
            {"path": "index.md", "title": "Home"},
            {"path": "user-manual/b.md", "title": "B"},
            {"path": "user-manual/a.md", "title": "A"},
        ])

    def test_contribution_anchors(self) -> None:
        self.user = {"username": "admin", "roles": ["admin"]}
        items = {item["id"]: item for item in self.client.get("/api/v1/manual/contributions").json()["contributions"]}
        self.assertEqual(items["models"]["files"], {"en": "docs/llm-review.md"})
        self.assertEqual(items["models"]["anchors"], {"en": "tutorial"})

    def test_file(self) -> None:
        response = self.client.get("/api/v1/manual/plugins/grobid/docs/llm-review.md")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.text, "# Tutorial\n")
        self.assertEqual(response.headers["x-content-type-options"], "nosniff")
        self.assertEqual(self.client.get("/api/v1/manual/plugins/grobid/plugin.py").status_code, 404)


class TestManualPages(unittest.TestCase):
    def setUp(self) -> None:
        self.docs = Path(tempfile.mkdtemp())
        (self.docs / "user-manual" / "sub").mkdir(parents=True)
        (self.docs / "development").mkdir()
        files = {
            "index.md": "# Docs\n\n```markdown\n# Not a title\n[x](user-manual/z.md)\n```\n\n[Guide](user-manual/guide.md) [Dev](development/dev.md) [About](about.md)\n",
            "about.md": "About without heading\n",
            "user-manual/guide.md": "Intro\n\n# Guide #\n\nSee [Sub](sub/deep.md \"title\") and [web](https://example.org/x.md)\n",
            "user-manual/sub/deep.md": "# Deep\n\n[Back](../guide.md) [Out](../../../x.md)\n",
            "user-manual/z.md": "# Zed\n",
            "user-manual/y.md": "# Why\n",
            "development/dev.md": "# Dev\n",
        }
        for path, text in files.items():
            (self.docs / path).write_text(text, encoding="utf-8")

    def tearDown(self) -> None:
        shutil.rmtree(self.docs)

    def test_order_and_titles(self) -> None:
        pages = [(p.path, p.title) for p in list_manual_pages(self.docs)]
        self.assertEqual(pages, [
            ("index.md", "Docs"),
            ("user-manual/guide.md", "Guide"),
            ("about.md", "about"),
            ("user-manual/sub/deep.md", "Deep"),
            ("user-manual/y.md", "Why"),
            ("user-manual/z.md", "Zed"),
        ])


if __name__ == "__main__":
    unittest.main()
