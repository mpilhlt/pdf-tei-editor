"""
The annotation guides that the extractors declare (`annotationGuides` of the extractor info), grouped by guide file,
for the annotation guide window (`/guide/<id>`, app/src/guide.js). Only the Markdown guides for human readers are
listed (`url`, not `machine_url`); the window renders no other files. See issue #879.
"""

import re
from dataclasses import dataclass, field
from typing import Any

from fastapi_app.lib.core.git_forge_adapters import GitForgeAdapterRegistry

REF_PLACEHOLDER = "{ref}"


@dataclass
class GuideSection:
    """A section of a guide file that a configured guide entry points to."""

    anchor: str
    label: str
    category: str
    variant_ids: list[str]


@dataclass
class AnnotationGuideFile:
    """A Markdown guide file, with the sections the extractors point to."""

    id: str
    url: str
    url_template: str | None
    sections: list[GuideSection] = field(default_factory=list)


def _slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")


def _guide_id(url: str, repo_path: tuple[str, str] | None) -> str:
    """A readable id: repository name and file name without extension, e.g. 'fossil-guidelines'."""
    if repo_path:
        repo, path = repo_path
        stem = path.rsplit("/", 1)[-1].rsplit(".", 1)[0]
        return _slug(f"{repo.rsplit('/', 1)[-1]}-{stem}") or "guide"
    stem = url.split("?", 1)[0].rstrip("/").rsplit("/", 1)[-1].rsplit(".", 1)[0]
    return _slug(stem) or "guide"


def _url_template(url: str, registry: GitForgeAdapterRegistry) -> str | None:
    """The URL with `{ref}` in place of the ref, if a forge adapter recognizes it."""
    adapter = registry.get_adapter_for(url)
    if adapter is None:
        return None
    try:
        return adapter.url_at_commit(url, REF_PLACEHOLDER)
    except ValueError:
        return None


def _repo_path(url: str, registry: GitForgeAdapterRegistry) -> tuple[str, str] | None:
    adapter = registry.get_adapter_for(url)
    if adapter is None:
        return None
    try:
        return adapter.parse_repo_path(url)
    except ValueError:
        return None


def list_annotation_guides(extractors: list[dict[str, Any]], registry: GitForgeAdapterRegistry | None = None) -> list[AnnotationGuideFile]:
    """
    Groups the Markdown guide entries of the extractors by file (URL without anchor), in the order they are declared.

    Args:
        extractors: Extractor info dicts as returned by `list_extractors()`
        registry: Forge adapters; the global registry if omitted

    Returns:
        One entry per guide file, with a unique id
    """
    registry = registry or GitForgeAdapterRegistry.get_instance()
    guides: dict[str, AnnotationGuideFile] = {}
    used_ids: set[str] = set()
    for extractor in extractors:
        for entry in extractor.get("annotationGuides") or []:
            if entry.get("type") != "markdown" or not entry.get("url"):
                continue
            base_url, _, anchor = str(entry["url"]).partition("#")
            guide = guides.get(base_url)
            if guide is None:
                guide_id = _guide_id(base_url, _repo_path(base_url, registry))
                candidate, n = guide_id, 2
                while candidate in used_ids:
                    candidate, n = f"{guide_id}-{n}", n + 1
                used_ids.add(candidate)
                guide = AnnotationGuideFile(id=candidate, url=base_url, url_template=_url_template(base_url, registry))
                guides[base_url] = guide
            if anchor and not re.fullmatch(r"L\d+(-L?\d+)?", anchor) and all(s.anchor != anchor for s in guide.sections):
                guide.sections.append(GuideSection(
                    anchor=anchor,
                    label=str(entry.get("label") or anchor),
                    category=str(entry.get("category") or ""),
                    variant_ids=[str(v) for v in entry.get("variant_ids") or []],
                ))
    return list(guides.values())
