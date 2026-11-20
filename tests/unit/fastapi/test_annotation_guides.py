"""
Unit tests for the listing of the annotation guide files for the annotation guide window.

@testCovers fastapi_app/lib/utils/annotation_guides.py
@testCovers fastapi_app/routers/annotation_guides.py
"""

import unittest
from typing import Any

from fastapi import FastAPI
from fastapi.testclient import TestClient

from fastapi_app.lib.utils.annotation_guides import list_annotation_guides
from fastapi_app.routers import annotation_guides as guides_router

GUIDE = "https://github.com/mpilhlt/fossil/blob/main/docs/guidelines.md"
LLM_GUIDE = "https://github.com/mpilhlt/fossil/blob/main/docs/guidelines-llm.md"

EXTRACTORS: list[dict[str, Any]] = [
    {
        "id": "grobid",
        "annotationGuides": [
            {"variant_ids": ["seg"], "category": "primary", "type": "markdown", "url": f"{GUIDE}#document-segmentation-model", "machine_url": f"{LLM_GUIDE}#document-segmentation-model", "label": "Segmentation"},
            {"variant_ids": ["refs"], "category": "primary", "type": "markdown", "url": f"{GUIDE}#citation-model", "label": "Citation"},
            {"variant_ids": ["refs"], "category": "data", "type": "markdown", "url": f"{GUIDE}#L10-L20", "label": "Lines"},
            {"variant_ids": ["refs"], "category": "primary", "type": "html", "url": "https://example.org/guide.html", "label": "HTML"},
        ],
    },
    {
        "id": "other",
        "annotationGuides": [
            {"variant_ids": ["*"], "category": "primary", "type": "markdown", "url": "https://gitlab.com/group/proj/-/blob/main/guidelines.md#intro", "label": "Other"},
            {"variant_ids": ["x"], "category": "primary", "type": "markdown", "url": "https://pad.example.org/abc/download", "label": "Pad"},
        ],
    },
    {"id": "none"},
]


class TestListAnnotationGuides(unittest.TestCase):

    def test_groups_by_file_and_skips_machine_html_and_line_anchors(self):
        guides = list_annotation_guides(EXTRACTORS)
        self.assertEqual([g.url for g in guides], [GUIDE, "https://gitlab.com/group/proj/-/blob/main/guidelines.md", "https://pad.example.org/abc/download"])
        fossil = guides[0]
        self.assertEqual([s.anchor for s in fossil.sections], ["document-segmentation-model", "citation-model"])
        self.assertEqual(fossil.sections[1].variant_ids, ["refs"])

    def test_ids_are_readable_and_unique(self):
        guides = list_annotation_guides(EXTRACTORS)
        self.assertEqual([g.id for g in guides], ["fossil-guidelines", "proj-guidelines", "download"])
        twice = list_annotation_guides([{"annotationGuides": [
            {"type": "markdown", "url": GUIDE},
            {"type": "markdown", "url": "https://github.com/other/fossil/blob/main/guidelines.md"},
        ]}])
        self.assertEqual([g.id for g in twice], ["fossil-guidelines", "fossil-guidelines-2"])

    def test_url_template_for_forge_urls(self):
        guides = list_annotation_guides(EXTRACTORS)
        self.assertEqual(guides[0].url_template, "https://github.com/mpilhlt/fossil/blob/{ref}/docs/guidelines.md")
        self.assertEqual(guides[1].url_template, "https://gitlab.com/group/proj/-/blob/{ref}/guidelines.md")
        self.assertIsNone(guides[2].url_template)


class TestAnnotationGuidesRoute(unittest.TestCase):

    def test_served_without_authentication(self):
        app = FastAPI()
        app.include_router(guides_router.router)
        app.dependency_overrides[guides_router.get_extractors] = lambda: EXTRACTORS
        response = TestClient(app).get("/annotation-guides")
        self.assertEqual(response.status_code, 200)
        guides = response.json()["guides"]
        self.assertEqual(guides[0]["id"], "fossil-guidelines")
        self.assertEqual(guides[0]["sections"][0], {"anchor": "document-segmentation-model", "label": "Segmentation", "category": "primary", "variant_ids": ["seg"]})


if __name__ == "__main__":
    unittest.main()
