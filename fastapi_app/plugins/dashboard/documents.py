"""
Helpers for dashboard contributions that list documents.

Used by the backend routes of plugins that depend on the dashboard plugin
(recent documents, review queue).
"""

from typing import Any

from fastapi_app.lib.models import FileMetadata
from fastapi_app.lib.repository.file_repository import FileRepository

_PLACEHOLDER_TITLES = ("", "untitled", "unknown title")


def project_specificity(project: dict[str, Any]) -> tuple[bool, int]:
    """Sort key putting projects with fewer collections first and wildcard (`*`) projects last."""
    collections = project.get("collections", [])
    return ("*" in collections, len(collections))


def project_includes(project: dict[str, Any], collections: list[str]) -> bool:
    """Return True if any of the given collections belongs to the project."""
    project_collections = project.get("collections", [])
    return "*" in project_collections or any(c in project_collections for c in collections)


def _usable_label(value: object) -> str | None:
    """Return the value as a string unless it is empty or a placeholder such as "Untitled"."""
    if value and str(value).strip().lower() not in _PLACEHOLDER_TITLES:
        return str(value)
    return None


class DocumentInfoResolver:
    """Builds JSON entries for TEI files, caching the PDF lookup per document.

    Collections that belong only to archived projects (`archived_collections`) are removed from
    the entries; documents in no other collection are reported by `is_archived()`.
    """

    def __init__(self, file_repo: FileRepository, archived_collections: set[str] | None = None):
        self._file_repo = file_repo
        self._archived = archived_collections or set()
        self._pdfs: dict[str, FileMetadata | None] = {}

    def _pdf(self, doc_id: str) -> FileMetadata | None:
        if doc_id not in self._pdfs:
            self._pdfs[doc_id] = self._file_repo.get_pdf_for_document(doc_id)
        return self._pdfs[doc_id]

    def _collections(self, tei_file: FileMetadata) -> list[str]:
        pdf = self._pdf(tei_file.doc_id)
        return tei_file.doc_collections or (pdf.doc_collections if pdf else []) or []

    def is_archived(self, tei_file: FileMetadata) -> bool:
        """Return True if all collections of the document belong only to archived projects."""
        collections = self._collections(tei_file)
        return bool(collections) and all(c in self._archived for c in collections)

    def entry(self, tei_file: FileMetadata) -> dict[str, Any]:
        """Return the fields the dashboard needs to show and open a TEI file.

        `title` is the document (PDF) label, falling back to the document title and the doc_id;
        `label` is the TEI file's own label, or None if it has none.
        """
        pdf = self._pdf(tei_file.doc_id)
        candidates = [
            pdf.label if pdf else None,
            (pdf.doc_metadata or {}).get("title") if pdf else None,
            (tei_file.doc_metadata or {}).get("title"),
        ]
        title = next((label for label in map(_usable_label, candidates) if label), tei_file.doc_id)
        return {
            "stable_id": tei_file.stable_id,
            "pdf_stable_id": pdf.stable_id if pdf else None,
            "doc_id": tei_file.doc_id,
            "title": title,
            "label": _usable_label(tei_file.label),
            "variant": tei_file.variant,
            "status": tei_file.status,
            "is_gold": tei_file.is_gold_standard,
            "version": tei_file.version,
            "collections": [c for c in self._collections(tei_file) if c not in self._archived],
        }
