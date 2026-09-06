"""
Unit tests for AnnotationTagDef/AnnotationTagVariant models in models_extraction.py

@testCovers fastapi_app/lib/models/models_extraction.py
"""

import unittest
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).parent.parent.parent.parent))

from fastapi_app.lib.models.models_extraction import (
    AnnotationTagAttribute,
    AnnotationTagDef,
    AnnotationTagVariant,
    ExtractorInfo,
)


class TestAnnotationTagAttribute(unittest.TestCase):

    def test_required_fields(self):
        attr = AnnotationTagAttribute(name="key")
        self.assertEqual(attr.name, "key")
        self.assertIsNone(attr.values)

    def test_optional_values(self):
        attr = AnnotationTagAttribute(name="level", values=["m", "a", "j"])
        self.assertEqual(attr.values, ["m", "a", "j"])


class TestAnnotationTagVariant(unittest.TestCase):

    def test_single_attribute_variant(self):
        variant = AnnotationTagVariant(attrs={"type": "court"})
        self.assertEqual(variant.attrs, {"type": "court"})
        self.assertIsNone(variant.description)

    def test_correlated_multi_attribute_variant(self):
        variant = AnnotationTagVariant(
            attrs={"level": "m", "type": "legislation"},
            description="Title of a statute / legislative act",
        )
        self.assertEqual(variant.attrs["level"], "m")
        self.assertEqual(variant.attrs["type"], "legislation")
        self.assertEqual(variant.description, "Title of a statute / legislative act")


class TestAnnotationTagDef(unittest.TestCase):

    def test_minimal(self):
        tag = AnnotationTagDef(tag="bibl", label="bibl", color="#89dceb")
        self.assertEqual(tag.tag, "bibl")
        self.assertEqual(tag.label, "bibl")
        self.assertEqual(tag.color, "#89dceb")
        self.assertEqual(tag.attributes, [])
        self.assertEqual(tag.variants, [])
        self.assertTrue(tag.bareAllowed)
        self.assertIsNone(tag.description)
        self.assertEqual(tag.childTags, [])

    def test_with_variants(self):
        tag = AnnotationTagDef(
            tag="title",
            label="title",
            color="#a6e3a1",
            bareAllowed=False,
            variants=[
                AnnotationTagVariant(attrs={"level": "a"}, description="Article or chapter title"),
                AnnotationTagVariant(attrs={"level": "m", "type": "legislation"}, description="Statute title"),
            ],
        )
        self.assertFalse(tag.bareAllowed)
        self.assertEqual(len(tag.variants), 2)
        self.assertEqual(tag.variants[1].attrs, {"level": "m", "type": "legislation"})

    def test_serialization(self):
        tag = AnnotationTagDef(
            tag="citedRange", label="citedRange", color="#89b4fa", bareAllowed=False,
            description="Pinpoint into a statute or decision",
            variants=[AnnotationTagVariant(attrs={"unit": "page"}, description="Pinpoint by printed page number")],
        )
        data = tag.model_dump()
        self.assertEqual(data["tag"], "citedRange")
        self.assertFalse(data["bareAllowed"])
        self.assertEqual(data["variants"][0]["attrs"], {"unit": "page"})
        self.assertEqual(data["description"], "Pinpoint into a statute or decision")


class TestExtractorInfoAnnotationTags(unittest.TestCase):

    def test_default_empty_dict(self):
        info = ExtractorInfo(
            id="grobid", name="Grobid", description="Grobid extractor",
            input=["pdf"], output=["xml"], available=True,
        )
        self.assertEqual(info.annotationTags, {})

    def test_with_annotation_tags_dict(self):
        info = ExtractorInfo(
            id="grobid", name="Grobid", description="Grobid extractor",
            input=["pdf"], output=["xml"], available=True,
            annotationTags={
                "grobid.training.references": [
                    AnnotationTagDef(tag="bibl", label="bibl", color="#89dceb")
                ]
            },
        )
        tags = info.annotationTags.get("grobid.training.references", [])
        self.assertEqual(len(tags), 1)
        self.assertEqual(tags[0].tag, "bibl")


if __name__ == "__main__":
    unittest.main()
