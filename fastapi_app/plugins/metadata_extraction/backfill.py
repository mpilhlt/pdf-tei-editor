"""
Backfill missing bibliographic metadata for all documents of a collection.

Only data points that do not exist yet are added; existing values are never overwritten.

Strategies, per document:

1. CrossRef/DataCite lookup if a DOI is known (TEI header, PDF metadata or DOI-encoded doc_id)
2. GROBID header extraction (`processHeaderDocument`) as fallback if no DOI is known or the
   lookup returned nothing, provided the GROBID plugin is active and its server is ready. A DOI
   found by GROBID is looked up in CrossRef/DataCite, GROBID's values fill the remaining gaps.
3. Document language: `predict_document_language_with_source()`, the prediction path used for
   new extractions: detection from the PDF text layer, then from the TEI text; only if the text
   is too short or ambiguous, the registry language, then TEI/@xml:lang or text/@xml:lang.
"""

import asyncio
import logging
import re
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Callable, Optional

from lxml import etree

from fastapi_app.lib.core.locking import check_lock
from fastapi_app.lib.models.models import FileMetadata, FileUpdate
from fastapi_app.lib.repository.file_repository import FileRepository
from fastapi_app.lib.services.language_detection import (
    LANGUAGE_FROM_PDF_TEXT,
    LANGUAGE_FROM_TEI_TEXT,
    UNDETERMINED_LANGUAGE,
    extract_pdf_text,
    predict_document_language_with_source,
)
from fastapi_app.lib.services.metadata_extraction import BibliographicMetadata
from fastapi_app.lib.storage.file_storage import FileStorage
from fastapi_app.lib.utils.doi_utils import decode_filename, fetch_doi_metadata, normalize_doi, validate_doi
from fastapi_app.lib.utils.tei_utils import (
    normalize_language_code,
    serialize_tei_like_source,
    set_document_language,
)

logger = logging.getLogger(__name__)

TEI_NS = "http://www.tei-c.org/ns/1.0"
_T = f"{{{TEI_NS}}}"
_NS = {"tei": TEI_NS}

SOURCE_CROSSREF = "crossref"
SOURCE_GROBID = "grobid"
SOURCE_LANGUAGE_DETECTION = "language-detection"

LANGUAGE_UNDETERMINED = "undetermined"
"""FileResult.language_source if "und" was declared; other values are the LANGUAGE_FROM_* sources."""

BIBLIOGRAPHIC_FIELDS: tuple[str, ...] = (
    "title", "authors", "date", "publisher", "journal", "volume", "issue", "pages", "doi", "issn", "isbn", "url",
)
"""Bibliographic data points that are backfilled into sourceDesc/biblStruct."""

LANGUAGE_FIELD = "language"

PDF_METADATA_FIELDS: tuple[str, ...] = (
    "title", "authors", "date", "journal", "volume", "issue", "pages", "publisher", "doi", "url",
)
"""Keys of the PDF's doc_metadata that are backfilled."""

_BIBL = "tei:fileDesc/tei:sourceDesc/tei:biblStruct"

# Places in the teiHeader where an existing value counts as "data point exists", relative to teiHeader.
# Includes the legacy locations read by extract_tei_metadata(), so that values are never duplicated.
_FIELD_LOCATIONS: dict[str, tuple[str, ...]] = {
    "title": (f"{_BIBL}/tei:analytic/tei:title", "tei:fileDesc/tei:titleStmt/tei:title[@level='a']"),
    "authors": (f"{_BIBL}/tei:analytic/tei:author", f"{_BIBL}/tei:monogr/tei:author"),
    "date": (f"{_BIBL}/tei:monogr/tei:imprint/tei:date", "tei:fileDesc/tei:publicationStmt/tei:date[@type='publication']"),
    "publisher": (f"{_BIBL}/tei:monogr/tei:imprint/tei:publisher", "tei:fileDesc/tei:publicationStmt/tei:publisher"),
    "journal": (f"{_BIBL}/tei:monogr/tei:title[@level='j']",),
    "volume": (f"{_BIBL}/tei:monogr/tei:imprint/tei:biblScope[@unit='volume']",),
    "issue": (f"{_BIBL}/tei:monogr/tei:imprint/tei:biblScope[@unit='issue']",),
    "pages": (f"{_BIBL}/tei:monogr/tei:imprint/tei:biblScope[@unit='page']",),
    "doi": (".//tei:idno[@type='DOI']",),
    "issn": ("tei:fileDesc/tei:sourceDesc//tei:idno[@type='ISSN']",),
    "isbn": ("tei:fileDesc/tei:sourceDesc//tei:idno[@type='ISBN']",),
    "url": (f"{_BIBL}/tei:ptr", "tei:fileDesc/tei:publicationStmt/tei:ptr"),
}


@dataclass
class FileResult:
    """Outcome for one TEI file."""

    stable_id: str
    filled: dict[str, Any] = field(default_factory=dict)
    """Added data points and their values."""
    language_source: Optional[str] = None
    """Where an added language comes from: a LANGUAGE_FROM_* source of language_detection, or "undetermined"."""
    locked: bool = False
    error: Optional[str] = None


@dataclass
class DocumentResult:
    """Outcome for one document."""

    doc_id: str
    pdf_stable_id: Optional[str] = None
    doi: Optional[str] = None
    sources: list[str] = field(default_factory=list)
    files: list[FileResult] = field(default_factory=list)
    pdf_filled: dict[str, Any] = field(default_factory=dict)
    errors: list[str] = field(default_factory=list)

    @property
    def updated(self) -> bool:
        """True if any data point was added to a file of this document."""
        return bool(self.pdf_filled) or any(f.filled and not f.locked for f in self.files)


# ---------------------------------------------------------------------------
# TEI inspection and modification
# ---------------------------------------------------------------------------


def _has_value(element: etree._Element) -> bool:  # type: ignore[name-defined]
    """True if an element carries a value as text content or in a value attribute."""
    if "".join(str(t) for t in element.itertext()).strip():
        return True
    return any(element.get(attr) for attr in ("when", "target", "from"))


def _get_header(tei_root: etree._Element) -> Optional[etree._Element]:  # type: ignore[name-defined]
    return tei_root.find(f"{_T}teiHeader")


def has_language(tei_root: etree._Element) -> bool:  # type: ignore[name-defined]
    """True if the document declares a language other than "und" in profileDesc/langUsage."""
    ident = tei_root.xpath(
        "string(tei:teiHeader/tei:profileDesc/tei:langUsage/tei:language/@ident)", namespaces=_NS
    )
    return bool(ident) and ident != UNDETERMINED_LANGUAGE


def get_missing_fields(tei_root: etree._Element) -> list[str]:  # type: ignore[name-defined]
    """
    List the data points a TEI document does not have yet.

    Args:
        tei_root: TEI root element

    Returns:
        Names from BIBLIOGRAPHIC_FIELDS plus "language"; empty if the document has no teiHeader
    """
    header = _get_header(tei_root)
    if header is None:
        return []
    missing = []
    for name in BIBLIOGRAPHIC_FIELDS:
        found = False
        for xpath in _FIELD_LOCATIONS[name]:
            result = header.xpath(xpath, namespaces=_NS)
            if isinstance(result, list) and any(_has_value(e) for e in result if isinstance(e, etree._Element)):
                found = True
                break
        if not found:
            missing.append(name)
    if not has_language(tei_root):
        missing.append(LANGUAGE_FIELD)
    return missing


def _find_or_add(parent: etree._Element, tag: str, index: Optional[int] = None, **attrs: str) -> etree._Element:  # type: ignore[name-defined]
    """Return the first child with the given tag and attributes, creating it if necessary."""
    for child in parent.findall(f"{_T}{tag}"):
        if all(child.get(k) == v for k, v in attrs.items()):
            return child
    element = etree.Element(f"{_T}{tag}", attrib=dict(attrs))
    if index is None:
        parent.append(element)
    else:
        parent.insert(index, element)
    return element


def _set_text(parent: etree._Element, tag: str, value: str, index: Optional[int] = None, **attrs: str) -> None:  # type: ignore[name-defined]
    """Fill an empty child element with a value, creating the element if necessary."""
    element = _find_or_add(parent, tag, index, **attrs)
    if not _has_value(element):
        element.text = value


def _index_of_first(parent: etree._Element, tags: tuple[str, ...]) -> Optional[int]:  # type: ignore[name-defined]
    """Return the index of the first child with one of the given local names, or None."""
    for i, child in enumerate(parent):
        if isinstance(child.tag, str) and etree.QName(child).localname in tags:
            return i
    return None


def _reindent(element: etree._Element, unit: str) -> None:  # type: ignore[name-defined]
    """Pretty-print an element in place, matching the indentation of a pretty-printed document."""
    depth = sum(1 for _ in element.iterancestors())
    etree.indent(element, space=unit, level=depth)
    parent, previous = element.getparent(), element.getprevious()
    indent = "\n" + unit * depth
    if previous is not None:
        if not (previous.tail or "").strip():
            previous.tail = indent
    elif parent is not None and not (parent.text or "").strip():
        parent.text = indent
    if not (element.tail or "").strip():
        element.tail = indent if element.getnext() is not None else "\n" + unit * (depth - 1)


def _indent_unit(header: etree._Element) -> Optional[str]:  # type: ignore[name-defined]
    """Return the indentation unit of a pretty-printed teiHeader, or None if it is not pretty-printed."""
    ws = header.text or ""
    if "\n" not in ws or ws.strip():
        return None
    # The children of teiHeader are at depth 2
    indent = ws.rsplit("\n", 1)[1]
    return indent[: len(indent) // 2] or None


def _get_analytic(bibl_struct: etree._Element) -> etree._Element:  # type: ignore[name-defined]
    return _find_or_add(bibl_struct, "analytic", 0)


def _get_monogr(bibl_struct: etree._Element) -> etree._Element:  # type: ignore[name-defined]
    existing = bibl_struct.find(f"{_T}monogr")
    if existing is not None:
        return existing
    analytics = bibl_struct.findall(f"{_T}analytic")
    index = bibl_struct.index(analytics[-1]) + 1 if analytics else 0
    return _find_or_add(bibl_struct, "monogr", index)


def _get_imprint(monogr: etree._Element) -> etree._Element:  # type: ignore[name-defined]
    return _find_or_add(monogr, "imprint")


def fill_missing_fields(
    tei_root: etree._Element,  # type: ignore[name-defined]
    metadata: BibliographicMetadata,
    fields: list[str],
) -> list[str]:
    """
    Add bibliographic data points to sourceDesc/biblStruct, creating the structure as needed.

    Only the given fields are written, and only if the metadata has a value for them. The caller
    determines the fields with `get_missing_fields()`, so existing values are never overwritten.

    Args:
        tei_root: TEI root element (modified in place)
        metadata: Metadata from CrossRef/DataCite or GROBID
        fields: Names of the missing data points

    Returns:
        Names of the data points that were added
    """
    header = _get_header(tei_root)
    if header is None:
        return []
    values: dict[str, Any] = {name: metadata.get(name) for name in BIBLIOGRAPHIC_FIELDS}  # type: ignore[misc]
    todo = [name for name in BIBLIOGRAPHIC_FIELDS if name in fields and values.get(name)]
    if not todo:
        return []
    file_desc = header.find(f"{_T}fileDesc")
    if file_desc is None:
        return []
    source_desc = file_desc.find(f"{_T}sourceDesc")
    if source_desc is None:
        source_desc = etree.SubElement(file_desc, f"{_T}sourceDesc")
        changed_root = source_desc
    else:
        changed_root = None
    bibl_struct = source_desc.find(f"{_T}biblStruct")
    created_bibl_struct = bibl_struct is None
    if bibl_struct is None:
        bibl_struct = etree.SubElement(source_desc, f"{_T}biblStruct")
    changed_root = changed_root if changed_root is not None else bibl_struct

    filled: list[str] = []

    if "title" in todo:
        _set_text(_get_analytic(bibl_struct), "title", str(values["title"]), 0, level="a")
        filled.append("title")

    authors = [
        ((a.get("given") or "").strip(), (a.get("family") or "").strip()) for a in values["authors"] or []
    ] if "authors" in todo else []
    authors = [(given, family) for given, family in authors if given or family]
    if authors:
        analytic = _get_analytic(bibl_struct)
        for given, family in authors:
            pers_name = etree.SubElement(etree.SubElement(analytic, f"{_T}author"), f"{_T}persName")
            if given:
                etree.SubElement(pers_name, f"{_T}forename").text = given
            if family:
                etree.SubElement(pers_name, f"{_T}surname").text = family
        filled.append("authors")

    monogr_fields = [name for name in ("journal", "issn", "isbn", "volume", "issue", "pages", "date", "publisher") if name in todo]
    if monogr_fields:
        monogr = _get_monogr(bibl_struct)
        if "journal" in todo:
            _set_text(monogr, "title", str(values["journal"]), 0, level="j")
        for name, id_type in (("issn", "ISSN"), ("isbn", "ISBN")):
            if name in todo:
                _set_text(monogr, "idno", str(values[name]), _index_of_first(monogr, ("imprint",)), type=id_type)
        imprint_fields = [n for n in monogr_fields if n in ("volume", "issue", "pages", "date", "publisher")]
        if imprint_fields:
            imprint = _get_imprint(monogr)
            for name, unit in (("volume", "volume"), ("issue", "issue")):
                if name in todo:
                    _set_text(imprint, "biblScope", str(values[name]), unit=unit)
            if "pages" in todo:
                pages = str(values["pages"])
                element = _find_or_add(imprint, "biblScope", unit="page")
                if not _has_value(element):
                    parts = [p.strip() for p in re.split(r"[-–]", pages)]
                    if len(parts) == 2 and all(parts):
                        element.set("from", parts[0])
                        element.set("to", parts[1])
                    element.text = pages
            if "date" in todo:
                date = str(values["date"])
                element = _find_or_add(imprint, "date")
                if not _has_value(element):
                    if re.fullmatch(r"\d{4}(-\d{2}(-\d{2})?)?", date):
                        element.set("when", date)
                    element.text = date
            if "publisher" in todo:
                _set_text(imprint, "publisher", str(values["publisher"]))
        filled.extend(monogr_fields)

    if "doi" in todo:
        _set_text(bibl_struct, "idno", str(values["doi"]), _index_of_first(bibl_struct, ("ptr",)), type="DOI")
        filled.append("doi")

    if "url" in todo:
        ptr = _find_or_add(bibl_struct, "ptr")
        if not ptr.get("target"):
            ptr.set("target", str(values["url"]))
        filled.append("url")

    if not filled:
        # Remove the structure created for nothing
        if created_bibl_struct and len(bibl_struct) == 0:
            source_desc.remove(bibl_struct)
        if changed_root is source_desc and len(source_desc) == 0:
            file_desc.remove(source_desc)
        return []

    indent_unit = _indent_unit(header)
    if indent_unit:
        _reindent(changed_root, indent_unit)

    return [name for name in BIBLIOGRAPHIC_FIELDS if name in filled]


def fill_missing_pdf_metadata(doc_metadata: dict[str, Any], metadata: BibliographicMetadata) -> tuple[dict[str, Any], list[str]]:
    """
    Add missing keys to a PDF's doc_metadata.

    Args:
        doc_metadata: Existing doc_metadata of the PDF
        metadata: Retrieved metadata

    Returns:
        Tuple of (merged doc_metadata, names of the added keys)
    """
    merged = dict(doc_metadata)
    filled = []
    for name in PDF_METADATA_FIELDS:
        value = metadata.get(name)
        if value and not merged.get(name):
            merged[name] = value
            filled.append(name)
    return merged, filled


def merge_metadata(primary: BibliographicMetadata, secondary: BibliographicMetadata) -> BibliographicMetadata:
    """Return `primary`, with empty values taken from `secondary`."""
    merged = BibliographicMetadata(**primary)  # type: ignore[typeddict-item]
    for key, value in secondary.items():
        if value and not merged.get(key):
            merged[key] = value  # type: ignore[literal-required]
    return merged


def has_useful_metadata(metadata: BibliographicMetadata) -> bool:
    """True if the metadata has a title, journal or authors."""
    return bool(metadata.get("title") or metadata.get("journal") or metadata.get("authors"))


# ---------------------------------------------------------------------------
# Metadata retrieval
# ---------------------------------------------------------------------------


def _valid_doi(value: Optional[str]) -> Optional[str]:
    if not value:
        return None
    try:
        doi = normalize_doi(value)
    except Exception:
        return None
    return doi if validate_doi(doi) else None


def find_doi(
    doc_id: str,
    pdf: Optional[FileMetadata],
    tei_roots: list[etree._Element],  # type: ignore[name-defined]
) -> Optional[str]:
    """
    Find a DOI for a document in its TEI headers, the PDF metadata, or the doc_id.

    Returns:
        Normalized, valid DOI, or None
    """
    for root in tei_roots:
        for value in root.xpath("tei:teiHeader//tei:idno[@type='DOI']/text()", namespaces=_NS):  # type: ignore[union-attr]
            doi = _valid_doi(str(value))
            if doi:
                return doi
    if pdf is not None and pdf.doc_metadata:
        doi = _valid_doi(pdf.doc_metadata.get("doi"))
        if doi:
            return doi
    try:
        return _valid_doi(decode_filename(doc_id))
    except Exception:
        return None


async def lookup_doi(doi: str) -> BibliographicMetadata:
    """
    Fetch metadata for a DOI from CrossRef/DataCite.

    Returns:
        Metadata dict, empty if the lookup failed
    """
    try:
        result = await asyncio.to_thread(fetch_doi_metadata, doi)
    except Exception as e:
        logger.warning(f"DOI lookup failed for {doi}: {e}")
        return BibliographicMetadata()
    return BibliographicMetadata(**{k: v for k, v in result.items() if v})  # type: ignore[typeddict-item]


GrobidFetcher = Callable[[str], BibliographicMetadata]
"""Blocking function extracting header metadata from a PDF path."""


async def retrieve_metadata(
    doi: Optional[str],
    pdf_path: Optional[Path],
    grobid_fetcher: Optional[GrobidFetcher],
    errors: list[str],
) -> tuple[BibliographicMetadata, list[str], Optional[str]]:
    """
    Retrieve metadata for a document, CrossRef first, GROBID as fallback.

    Args:
        doi: Known DOI, if any
        pdf_path: Path to the PDF, required for GROBID
        grobid_fetcher: GROBID header extraction function, or None if GROBID is not available
        errors: List that error messages are appended to

    Returns:
        Tuple of (metadata, sources used, DOI)
    """
    metadata = BibliographicMetadata()
    sources: list[str] = []
    if doi:
        metadata = await lookup_doi(doi)
        if has_useful_metadata(metadata):
            sources.append(SOURCE_CROSSREF)
        else:
            errors.append(f"No CrossRef/DataCite metadata for DOI {doi}")

    if not has_useful_metadata(metadata) and grobid_fetcher is not None and pdf_path is not None:
        try:
            grobid_metadata = await asyncio.to_thread(grobid_fetcher, str(pdf_path))
        except Exception as e:
            errors.append(str(e))
            grobid_metadata = BibliographicMetadata()
        grobid_doi = _valid_doi(grobid_metadata.get("doi"))
        if not doi and grobid_doi:
            doi = grobid_doi
            registry_metadata = await lookup_doi(grobid_doi)
            if has_useful_metadata(registry_metadata):
                metadata = merge_metadata(registry_metadata, metadata)
                sources.append(SOURCE_CROSSREF)
        if has_useful_metadata(grobid_metadata) or grobid_doi:
            metadata = merge_metadata(metadata, grobid_metadata)
            sources.append(SOURCE_GROBID)

    return metadata, sources, doi


# ---------------------------------------------------------------------------
# Collection backfill
# ---------------------------------------------------------------------------


async def backfill_document(
    doc_id: str,
    pdf: Optional[FileMetadata],
    tei_files: list[FileMetadata],
    file_repo: FileRepository,
    file_storage: FileStorage,
    session_id: str,
    db_dir: Path,
    grobid_fetcher: Optional[GrobidFetcher] = None,
    dry_run: bool = False,
) -> DocumentResult:
    """
    Backfill missing metadata in the TEI files and the PDF record of one document.

    Args:
        doc_id: Document ID
        pdf: PDF file record, if any
        tei_files: TEI file records of the document
        file_repo: File repository
        file_storage: File storage
        session_id: Session of the requesting user; files locked by other sessions are skipped
        db_dir: Database directory (for the locks database)
        grobid_fetcher: GROBID header extraction function, or None to skip GROBID
        dry_run: If True, compute the changes without saving them

    Returns:
        The outcome for the document
    """
    result = DocumentResult(doc_id=doc_id, pdf_stable_id=pdf.stable_id if pdf else None)

    # Load TEI files and determine what is missing
    loaded: list[tuple[FileMetadata, str, etree._Element, list[str]]] = []  # type: ignore[name-defined]
    for tei in tei_files:
        content = file_storage.read_file(tei.id, "tei")
        if not content:
            result.files.append(FileResult(stable_id=tei.stable_id, error="content not found in storage"))
            continue
        try:
            root = etree.fromstring(content)
        except etree.XMLSyntaxError as e:
            result.files.append(FileResult(stable_id=tei.stable_id, error=f"not well-formed: {e}"))
            continue
        if etree.QName(root).localname != "TEI" or _get_header(root) is None:
            continue
        loaded.append((tei, content.decode("utf-8"), root, get_missing_fields(root)))

    missing_bibliographic = any(f != LANGUAGE_FIELD for *_, missing in loaded for f in missing)
    pdf_needs_metadata = pdf is not None and any(not (pdf.doc_metadata or {}).get(f) for f in ("title", "authors", "date"))
    pdf_path = file_storage.get_file_path(pdf.id, "pdf") if pdf is not None else None

    result.doi = find_doi(doc_id, pdf, [root for _, _, root, _ in loaded])
    metadata = BibliographicMetadata()
    if missing_bibliographic or pdf_needs_metadata:
        metadata, result.sources, result.doi = await retrieve_metadata(
            result.doi, pdf_path, grobid_fetcher, result.errors
        )

    registry_language = normalize_language_code(metadata.get("language"))
    pdf_text: Optional[str] = None

    for tei, original, root, missing in loaded:
        file_result = FileResult(stable_id=tei.stable_id)
        result.files.append(file_result)
        if not missing:
            continue

        for name in fill_missing_fields(root, metadata, missing):
            file_result.filled[name] = metadata.get(name)

        if LANGUAGE_FIELD in missing:
            if pdf_text is None:
                pdf_text = await asyncio.to_thread(extract_pdf_text, str(pdf_path)) if pdf_path else ""
            language, file_result.language_source = await asyncio.to_thread(
                predict_document_language_with_source, root, None, pdf_text, registry_language
            )
            if file_result.language_source in (LANGUAGE_FROM_PDF_TEXT, LANGUAGE_FROM_TEI_TEXT) and SOURCE_LANGUAGE_DETECTION not in result.sources:
                result.sources.append(SOURCE_LANGUAGE_DETECTION)
            has_declaration = root.find(f"{_T}teiHeader/{_T}profileDesc/{_T}langUsage/{_T}language") is not None
            if not language and not has_declaration:
                language, file_result.language_source = UNDETERMINED_LANGUAGE, LANGUAGE_UNDETERMINED
            if language and set_document_language(root, language):
                file_result.filled[LANGUAGE_FIELD] = language
            else:
                file_result.language_source = None

        if not file_result.filled:
            continue
        if check_lock(tei.stable_id, session_id, db_dir, logger)["is_locked"]:
            file_result.locked = True
            continue
        if dry_run:
            continue
        try:
            xml_bytes = serialize_tei_like_source(root, original).encode("utf-8")
            new_id, _ = file_storage.save_file(xml_bytes, "tei", increment_ref=False)
            if new_id != tei.id:
                file_repo.update_file(tei.id, FileUpdate(id=new_id, file_size=len(xml_bytes)))
            logger.info(f"Backfilled {', '.join(file_result.filled)} in TEI {tei.stable_id}")
        except Exception as e:
            logger.error(f"Could not save TEI {tei.stable_id}: {e}", exc_info=True)
            file_result.error = str(e)
            file_result.filled = {}

    if pdf is not None and metadata:
        doc_metadata, pdf_filled = fill_missing_pdf_metadata(pdf.doc_metadata or {}, metadata)
        result.pdf_filled = {name: doc_metadata[name] for name in pdf_filled}
        if result.pdf_filled and not dry_run:
            try:
                file_repo.update_file(pdf.id, FileUpdate(doc_metadata=doc_metadata))
            except Exception as e:
                logger.error(f"Could not update metadata of PDF {pdf.stable_id}: {e}", exc_info=True)
                result.errors.append(f"PDF metadata update failed: {e}")
                result.pdf_filled = {}

    return result


ProgressCallback = Callable[[int, int, str], None]


async def backfill_collection(
    collection_id: str,
    file_repo: FileRepository,
    file_storage: FileStorage,
    session_id: str,
    db_dir: Path,
    grobid_fetcher: Optional[GrobidFetcher] = None,
    dry_run: bool = False,
    limit: Optional[int] = None,
    progress_callback: Optional[ProgressCallback] = None,
) -> dict[str, Any]:
    """
    Backfill missing metadata for all documents of a collection.

    Args:
        collection_id: Collection ID
        file_repo: File repository
        file_storage: File storage
        session_id: Session of the requesting user; files locked by other sessions are skipped
        db_dir: Database directory (for the locks database)
        grobid_fetcher: GROBID header extraction function, or None to skip GROBID
        dry_run: If True, compute the changes without saving them
        limit: Maximum number of documents to process
        progress_callback: Optional callback(current, total, label)

    Returns:
        Report with a summary and per-document results (documents without changes are omitted)
    """
    doc_ids: list[str] = []
    for file in file_repo.get_files_by_collection(collection_id):
        if file.doc_id and file.doc_id not in doc_ids:
            doc_ids.append(file.doc_id)
    if limit is not None:
        doc_ids = doc_ids[:limit]

    summary: dict[str, int] = {
        "documents": len(doc_ids),
        "documents_updated": 0,
        "tei_files_updated": 0,
        "tei_files_locked": 0,
        "pdfs_updated": 0,
        "errors": 0,
    }
    sources: dict[str, int] = {SOURCE_CROSSREF: 0, SOURCE_GROBID: 0, SOURCE_LANGUAGE_DETECTION: 0}
    documents: list[dict[str, Any]] = []

    for index, doc_id in enumerate(doc_ids, start=1):
        if progress_callback:
            progress_callback(index, len(doc_ids), f"Document {index}/{len(doc_ids)}: {doc_id[:40]}")
            await asyncio.sleep(0)
        files = file_repo.get_files_by_doc_id(doc_id)
        pdf = next((f for f in files if f.file_type == "pdf"), None)
        tei_files = [f for f in files if f.file_type == "tei"]
        try:
            result = await backfill_document(
                doc_id, pdf, tei_files, file_repo, file_storage, session_id, db_dir, grobid_fetcher, dry_run
            )
        except Exception as e:
            logger.error(f"Backfill failed for document {doc_id}: {e}", exc_info=True)
            result = DocumentResult(doc_id=doc_id, errors=[str(e)])

        for source in result.sources:
            sources[source] = sources.get(source, 0) + 1
        summary["tei_files_updated"] += sum(1 for f in result.files if f.filled and not f.locked)
        summary["tei_files_locked"] += sum(1 for f in result.files if f.locked)
        summary["pdfs_updated"] += 1 if result.pdf_filled else 0
        file_errors = [f for f in result.files if f.error]
        summary["errors"] += len(result.errors) + len(file_errors)
        if result.updated:
            summary["documents_updated"] += 1
        if result.updated or result.errors or file_errors:
            entry = asdict(result)
            entry["files"] = [asdict(f) for f in result.files if f.filled or f.locked or f.error]
            documents.append(entry)

    return {
        "collection": collection_id,
        "dry_run": dry_run,
        "summary": summary,
        "sources": sources,
        "documents": documents,
    }
