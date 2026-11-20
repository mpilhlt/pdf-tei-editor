"""
Annotation guides API: the Markdown guide files that the extractors declare, for the annotation guide window
(`/guide/<id>`, app/src/guide.js). See `fastapi_app/lib/utils/annotation_guides.py`.
"""

from typing import Any

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from ..lib.extraction import list_extractors
from ..lib.utils.annotation_guides import list_annotation_guides

router = APIRouter(prefix="/annotation-guides", tags=["annotation-guides"])


class AnnotationGuideSectionItem(BaseModel):
    """A section of a guide file that an extractor points to."""

    anchor: str = Field(description="Heading anchor of the section, e.g. 'citation-model'")
    label: str = Field(description="Label of the guide entry, e.g. 'Citation model guidelines'")
    category: str = Field(description="Rule category of the entry; 'primary' for the main section of a variant")
    variant_ids: list[str] = Field(description="Variants the section applies to; '*' means every variant")


class AnnotationGuideItem(BaseModel):
    """A Markdown guide file."""

    id: str = Field(description="Id of the guide in the guide window URL /guide/<id>, e.g. 'fossil-guidelines'")
    url: str = Field(description="URL of the guide file as configured (a forge blob URL, without anchor)")
    url_template: str | None = Field(description="The URL with '{ref}' in place of the branch or commit, if the URL is a recognized forge blob URL; null otherwise")
    sections: list[AnnotationGuideSectionItem] = Field(description="The sections the extractors point to, in declaration order")


class AnnotationGuidesResponse(BaseModel):
    """The annotation guide files of the available extractors."""

    guides: list[AnnotationGuideItem]


def get_extractors() -> list[dict[str, Any]]:
    """The available extractors (dependency, so tests can replace it)."""
    return list_extractors(available_only=True)


@router.get("", response_model=AnnotationGuidesResponse)
def annotation_guides(extractors: list[dict[str, Any]] = Depends(get_extractors)) -> AnnotationGuidesResponse:
    """The Markdown annotation guides (for human readers) that the available extractors declare, one entry per file. Served without authentication, like the guides themselves; the annotation guide window renders only these files."""
    return AnnotationGuidesResponse(guides=[
        AnnotationGuideItem(
            id=g.id,
            url=g.url,
            url_template=g.url_template,
            sections=[AnnotationGuideSectionItem(anchor=s.anchor, label=s.label, category=s.category, variant_ids=s.variant_ids) for s in g.sections],
        )
        for g in list_annotation_guides(extractors)
    ])
