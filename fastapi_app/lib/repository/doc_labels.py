"""
Display labels of documents for lists such as the messages and the bookmarks.
"""

from fastapi_app.lib.models.models import FileMetadata
from fastapi_app.lib.repository.file_repository import FileRepository


class DocLabels:
    """Labels of documents, cached for one request."""

    def __init__(self, file_repo: FileRepository):
        self.file_repo = file_repo
        self._titles: dict[str, str] = {}

    def label(self, file: FileMetadata | None, doc_id: str) -> str:
        """
        The title of a document, followed by the label of the file if it differs.

        Args:
            file: The file (a version of the document), or None if it is not known
            doc_id: The document id
        """
        if doc_id not in self._titles:
            pdf = self.file_repo.get_pdf_for_document(doc_id)
            title = (pdf.doc_metadata or {}).get("title") if pdf else None
            self._titles[doc_id] = str(title or (pdf.label if pdf else None) or doc_id)
        title = self._titles[doc_id]
        if file is not None and file.label and file.label != title:
            return f"{title}, {file.label}"
        return title
