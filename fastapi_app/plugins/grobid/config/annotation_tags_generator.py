"""
Generates the annotation-chip data (AnnotationTagsMap) for a GROBID
training variant from its cached RelaxNG schema, with the variant's scope
from ANNOTATION_TAG_SCOPE (see fastapi_app/lib/utils/annotation_tags.py).
"""

from pathlib import Path

from fastapi_app.lib.utils.annotation_tags import AnnotationTag, AnnotationTagsMap
from fastapi_app.lib.utils.annotation_tags import generate_annotation_tags as generate_tags_from_schema
from fastapi_app.plugins.grobid.config.annotation_tags_scope import ANNOTATION_TAG_SCOPE

__all__ = ["AnnotationTag", "AnnotationTagsMap", "generate_annotation_tags"]


def generate_annotation_tags(variant_id: str, schema_path: Path) -> list[AnnotationTag]:
    """
    Build the chip list for one GROBID training variant from its cached
    RelaxNG schema file. Returns an empty list if the variant has no scope
    configured in ANNOTATION_TAG_SCOPE, or the schema file doesn't exist
    yet — a schema declaration is required to get any chips at all.
    """
    scope = ANNOTATION_TAG_SCOPE.get(variant_id)
    if scope is None:
        return []
    return generate_tags_from_schema(schema_path, scope["root"], scope["exclude"])
