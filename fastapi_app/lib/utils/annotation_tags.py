"""
Annotation tags (the chips of the XML editor's visual annotation mode),
generated from a RelaxNG schema.

An extractor declares the chips for a variant in its info under
`annotationTags[variant_id]`; the editor offers its visual mode only for
variants that have some. Call `generate_annotation_tags()` with the
variant's schema file and the scope of its chips: the element whose
content-model children become chips, the children to leave out (e.g. empty
milestones such as `lb`), and the chips whose own children become chips
too (e.g. the alternatives grouped in `choice`).

See docs/superpowers/specs/2026-09-05-annotation-chip-schema-redesign-design.md.
"""

import copy
import hashlib
from collections.abc import Iterable
from pathlib import Path
from typing import TypedDict

from fastapi_app.lib.utils.relaxng_to_codemirror import RelaxNGParser


class AnnotationTagAttribute(TypedDict):
    name: str
    values: list[str] | None
    required: bool


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
    empty: bool


AnnotationTagsMap = dict[str, list[AnnotationTag]]


# Catppuccin Mocha accents plus two light neutrals (Subtext0/Subtext1) and one
# extra warm tint. Every entry is light enough to carry the dark badge label
# text (`.ann-badge { color: #1e1e2e }`); the surface/overlay greys that used to
# sit in slots 10/14/16 rendered near-black badges and were unreadable (#444).
PALETTE: list[str] = [
    "#89dceb", "#f38ba8", "#89b4fa", "#cba6f7", "#94e2d5", "#f9e2af",
    "#a6e3a1", "#f5c2e7", "#74c7ec", "#a6adc8", "#f2cdcd", "#eba0ac",
    "#b4befe", "#bac2de", "#fab387", "#f5e0dc", "#d18455",
]

_CacheKey = tuple[Path, float, str, frozenset[str], tuple[str, ...]]
_CACHE: dict[_CacheKey, list[AnnotationTag]] = {}


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


def generate_annotation_tags(
    schema_path: Path,
    root: str,
    exclude: Iterable[str] = (),
    expand: Iterable[str] = (),
) -> list[AnnotationTag]:
    """
    Build a chip list from the RelaxNG schema at `schema_path`: `root` and
    every element allowed as its child, plus the children of each chip
    named in `expand`, minus `exclude` (which is also removed from every
    chip's `childTags`). A chip whose element allows neither text nor any
    of its `childTags` is marked `empty` (e.g. `gap`, `pb`): the editor shows
    a badge for it, but does not offer it for wrapping selected text.
    Chips are sorted by tag name. Returns an empty
    list if the schema file doesn't exist. The result is cached until the
    file's mtime changes; callers get a copy they may modify.
    """
    if not schema_path.is_file():
        return []
    excluded = frozenset(exclude)
    expanded = tuple(expand)
    key: _CacheKey = (schema_path.resolve(), schema_path.stat().st_mtime, root, excluded, expanded)
    cached = _CACHE.get(key)
    if cached is not None:
        return copy.deepcopy(cached)

    parser = RelaxNGParser(include_global_attrs=False, sort_alphabetically=True)
    parser.parse_file(str(schema_path))
    definitions = parser.extract_tag_definitions(root, set(excluded))
    for parent in expanded:
        for child in definitions[parent]["children"] if parent in definitions else []:
            if child in definitions or child in excluded:
                continue
            child_definition = parser.extract_tag_definitions(child, set(excluded)).get(child)
            if child_definition is not None:
                definitions[child] = child_definition

    tags: list[AnnotationTag] = []
    taken_colors: set[str] = set()
    for tag_name in sorted(definitions):
        data = definitions[tag_name]
        child_tags = [c for c in data["children"] if c not in excluded]
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
            "childTags": child_tags,
            "empty": not data["textAllowed"] and not child_tags,
        })
    _CACHE[key] = tags
    return copy.deepcopy(tags)


def clear_annotation_tags_cache() -> None:
    """Drop all cached chip lists (for tests that regenerate against changed fixtures)."""
    _CACHE.clear()
