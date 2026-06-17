"""
Unit tests for AnnotationTagDef models in models_extraction.py

@testCovers fastapi_app/lib/models/models_extraction.py
"""

import unittest
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).parent.parent.parent.parent))

from fastapi_app.lib.models.models_extraction import (
    AnnotationTagAttribute,
    AnnotationTagDef,
    ExtractorInfo,
)


class TestAnnotationTagAttribute(unittest.TestCase):

    def test_required_fields(self):
        attr = AnnotationTagAttribute(name="level")
        self.assertEqual(attr.name, "level")
        self.assertIsNone(attr.values)

    def test_optional_values(self):
        attr = AnnotationTagAttribute(name="level", values=["m", "a", "j"])
        self.assertEqual(attr.values, ["m", "a", "j"])


class TestAnnotationTagDef(unittest.TestCase):

    def test_minimal(self):
        tag = AnnotationTagDef(tag="bibl", label="BIBL", color="#89dceb")
        self.assertEqual(tag.tag, "bibl")
        self.assertEqual(tag.label, "BIBL")
        self.assertEqual(tag.color, "#89dceb")
        self.assertIsNone(tag.labelMap)
        self.assertEqual(tag.attributes, [])

    def test_with_label_map(self):
        tag = AnnotationTagDef(
            tag="title",
            label="TITLE[{@level}]",
            labelMap={"level=m": "TITLE[M]", "level=a": "TITLE[A]"},
            color="#a6e3a1",
            attributes=[AnnotationTagAttribute(name="level", values=["m", "a"])],
        )
        self.assertEqual(tag.labelMap["level=m"], "TITLE[M]")
        self.assertEqual(len(tag.attributes), 1)

    def test_serialization(self):
        tag = AnnotationTagDef(tag="author", label="AUTHOR", color="#89b4fa")
        data = tag.model_dump()
        self.assertEqual(data["tag"], "author")
        self.assertIsNone(data["labelMap"])

    def test_new_fields_defaults(self):
        tag = AnnotationTagDef(tag="bibl", label="BIBL", color="#89dceb")
        self.assertIsNone(tag.description)
        self.assertEqual(tag.priority, 100)
        self.assertIsNone(tag.defaultAttributes)

    def test_description_field(self):
        tag = AnnotationTagDef(
            tag="bibl", label="BIBL", color="#89dceb",
            description="An individual bibliographic reference"
        )
        self.assertEqual(tag.description, "An individual bibliographic reference")

    def test_priority_field(self):
        tag = AnnotationTagDef(tag="body", label="body", color="#89dceb", priority=1)
        self.assertEqual(tag.priority, 1)

    def test_default_attributes_field(self):
        tag = AnnotationTagDef(
            tag="note", label="note[footnote]", color="#94e2d5",
            defaultAttributes={"place": "footnote"}
        )
        self.assertEqual(tag.defaultAttributes, {"place": "footnote"})

    def test_serialization_with_new_fields(self):
        tag = AnnotationTagDef(
            tag="note", label="note[footnote]", color="#94e2d5",
            priority=5, defaultAttributes={"place": "footnote"},
            description="A footnote"
        )
        data = tag.model_dump()
        self.assertEqual(data["priority"], 5)
        self.assertEqual(data["defaultAttributes"], {"place": "footnote"})
        self.assertEqual(data["description"], "A footnote")


class TestExtractorInfoAnnotationTags(unittest.TestCase):

    def test_default_empty(self):
        info = ExtractorInfo(
            id="grobid",
            name="Grobid",
            description="Grobid extractor",
            input=["pdf"],
            output=["xml"],
            available=True,
        )
        self.assertEqual(info.annotationTags, [])

    def test_with_annotation_tags(self):
        info = ExtractorInfo(
            id="grobid",
            name="Grobid",
            description="Grobid extractor",
            input=["pdf"],
            output=["xml"],
            available=True,
            annotationTags=[
                AnnotationTagDef(tag="bibl", label="BIBL", color="#89dceb")
            ],
        )
        self.assertEqual(len(info.annotationTags), 1)
        self.assertEqual(info.annotationTags[0].tag, "bibl")


if __name__ == "__main__":
    unittest.main()
