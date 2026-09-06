"""
Generates the annotation-chip data (AnnotationTagsMap) for a GROBID
training variant from its cached RelaxNG schema, replacing the previous
hand-curated fastapi_app/plugins/grobid/config/annotation_tags.py.

See docs/superpowers/specs/2026-09-05-annotation-chip-schema-redesign-design.md.
"""

import hashlib
from pathlib import Path
from typing import TypedDict

from fastapi_app.lib.utils.relaxng_to_codemirror import RelaxNGParser
from fastapi_app.plugins.grobid.config.annotation_tags_scope import ANNOTATION_TAG_SCOPE


class AnnotationTagAttribute(TypedDict):
    name: str
    values: list[str] | None


class AnnotationTagVariant(TypedDict):
    attrs: dict[str, str]
    description: str | None


class AnnotationTag(TypedDict):
    tag: str
    label: str
    color: str
    description: str | None
    attributes: list[AnnotationTagAttribute]
    variants: list[AnnotationTagVariant]
    bareAllowed: bool
    childTags: list[str]


AnnotationTagsMap = dict[str, list[AnnotationTag]]


# Same palette as the previous hand-curated config (Catppuccin Mocha accents).
PALETTE: list[str] = [
    "#89dceb", "#f38ba8", "#89b4fa", "#cba6f7", "#94e2d5", "#f9e2af",
    "#a6e3a1", "#f5c2e7", "#74c7ec", "#585b70", "#f2cdcd", "#eba0ac",
    "#b4befe", "#45475a", "#fab387", "#9399b2", "#d18455",
]


def _color_for_tag(tag_name: str, taken: set[str]) -> str:
    """
    Deterministic palette color for `tag_name`: hashed on the tag name
    alone (not the variant), so the same tag name gets the same color in
    every variant's toolbar. Uses hashlib rather than Python's built-in
    hash(), which is randomized per-process and would reshuffle colors on
    every server restart. `taken` holds colors already assigned within the
    current variant's chip set; on a collision the next free palette slot
    is used instead, so two tags in one toolbar are never the same color
    even if their hashes coincide.
    """
    digest = hashlib.sha256(tag_name.encode("utf-8")).hexdigest()
    index = int(digest, 16) % len(PALETTE)
    for _ in range(len(PALETTE)):
        color = PALETTE[index]
        if color not in taken:
            return color
        index = (index + 1) % len(PALETTE)
    return PALETTE[int(digest, 16) % len(PALETTE)]  # palette exhausted; accept a collision


def generate_annotation_tags(variant_id: str, schema_path: Path) -> list[AnnotationTag]:
    """
    Build the chip list for one GROBID training variant from its cached
    RelaxNG schema file. Returns an empty list if the variant has no scope
    configured in ANNOTATION_TAG_SCOPE, or the schema file doesn't exist
    yet — a schema declaration is required to get any chips at all.
    """
    scope = ANNOTATION_TAG_SCOPE.get(variant_id)
    if scope is None or not schema_path.is_file():
        return []

    parser = RelaxNGParser(include_global_attrs=False, sort_alphabetically=True)
    parser.parse_file(str(schema_path))
    definitions = parser.extract_tag_definitions(scope["root"], scope["exclude"])

    tags: list[AnnotationTag] = []
    taken_colors: set[str] = set()
    for tag_name in sorted(definitions):
        data = definitions[tag_name]
        color = _color_for_tag(tag_name, taken_colors)
        taken_colors.add(color)
        tags.append({
            "tag": tag_name,
            "label": tag_name,
            "color": color,
            "description": data["description"],
            "attributes": data["attributes"],
            "variants": data["variants"],
            "bareAllowed": data["bareAllowed"],
            "childTags": data["children"],
        })
    return tags
