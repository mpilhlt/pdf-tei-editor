"""
TEI document creation and manipulation utilities.

This module provides framework-agnostic TEI XML processing utilities.
No Flask or FastAPI dependencies.
"""

import datetime
from typing import Dict, Any, List, Optional
from lxml import etree


def create_tei_document() -> etree._Element:  # type: ignore[name-defined]
    """
    Create a TEI document root element

    Returns:
        TEI root element

    """
    tei = etree.Element("TEI", nsmap={None: "http://www.tei-c.org/ns/1.0"})  # type: ignore[dict-item]

    return tei


def create_tei_header(doi: str = "", metadata: Optional[Dict[str, Any]] = None,
                     applications: Optional[List[Dict[str, str]]] = None) -> etree._Element:  # type: ignore[name-defined]
    """
    Create a TEI header with metadata.

    Args:
        doi: DOI of the document
        metadata: Dictionary with title, authors, date, publisher, journal, volume, issue, pages
        applications: List of application info dicts with keys: ident, version, label

    Returns:
        TEI header element
    """
    if metadata is None:
        metadata = {}

    # Default values
    title = metadata.get("title", "Unknown Title")
    authors = metadata.get("authors", [])
    date = metadata.get("date", "")
    publisher = metadata.get("publisher", "")
    journal = metadata.get("journal", "")
    volume = metadata.get("volume", "")
    issue = metadata.get("issue", "")
    pages = metadata.get("pages", "")

    # Build TEI header
    teiHeader = etree.Element("teiHeader")

    # fileDesc
    fileDesc = etree.SubElement(teiHeader, "fileDesc")
    titleStmt = etree.SubElement(fileDesc, "titleStmt")
    etree.SubElement(titleStmt, "title", level="a").text = title

    for author in authors:
        author_elem = etree.SubElement(titleStmt, "author")
        persName = etree.SubElement(author_elem, "persName")
        etree.SubElement(persName, "forename").text = author.get("given", "")
        etree.SubElement(persName, "surname").text = author.get("family", "")

    # publicationStmt
    publicationStmt = etree.SubElement(fileDesc, "publicationStmt")
    etree.SubElement(publicationStmt, "publisher").text = publisher
    availability = etree.SubElement(publicationStmt, "availability")
    etree.SubElement(availability, "licence",
                    attrib={"target": "https://creativecommons.org/licenses/by/4.0/"})
    etree.SubElement(publicationStmt, "date", type="publication").text = str(date)
    etree.SubElement(publicationStmt, "idno", type="DOI").text = doi

    # sourceDesc with formatted citation
    authors_str = ", ".join([f'{author.get("given", "")} {author.get("family", "")}' for author in authors])
    citation = f"{authors_str}. ({date}). {title}. {journal}, {volume}({issue}), {pages}. DOI: {doi}"
    sourceDesc = etree.SubElement(fileDesc, "sourceDesc")
    etree.SubElement(sourceDesc, "bibl").text = citation

    # encodingDesc
    encodingDesc = etree.SubElement(teiHeader, 'encodingDesc')
    appInfo = etree.SubElement(encodingDesc, 'appInfo')

    # Add application info
    if applications is None:
        applications = [
            {"ident": "pdf-tei-editor", "version": "1.0", "label": "https://github.com/mpilhlt/pdf-tei-editor"}
        ]

    for app in applications:
        application = etree.SubElement(appInfo, 'application',
                                     version=app.get("version", "1.0"),
                                     ident=app.get("ident", "unknown"))
        etree.SubElement(application, 'label').text = app.get("label", "")

    # revisionDesc
    revisionDesc = etree.SubElement(teiHeader, 'revisionDesc')
    timestamp = datetime.datetime.now().isoformat()
    change = etree.SubElement(revisionDesc, 'change', when=timestamp, status="created")
    etree.SubElement(change, 'desc').text = "First version extracted automatically."

    return teiHeader


def create_edition_stmt(date: str, title: str) -> etree._Element:  # type: ignore[name-defined]
    """
    Create an editionStmt element with date and title.

    Args:
        date: ISO timestamp string
        title: Edition title

    Returns:
        editionStmt element
    """
    editionStmt = etree.Element("editionStmt")
    edition = etree.SubElement(editionStmt, "edition")
    date_elem = etree.SubElement(edition, "date", when=date)
    date_elem.text = datetime.datetime.fromisoformat(date.replace("Z", "+00:00")).strftime("%d.%m.%Y %H:%M:%S")
    title_elem = etree.SubElement(edition, "title")
    title_elem.text = title
    return editionStmt


def create_encoding_desc_with_grobid(grobid_version: str, grobid_revision: str, timestamp: str, variant_id: str = "grobid-segmentation") -> etree._Element:  # type: ignore[name-defined]
    """
    Create an encodingDesc element with GROBID application info.

    Args:
        grobid_version: GROBID version string
        grobid_revision: GROBID revision hash
        timestamp: ISO timestamp string
        variant_id: Variant identifier for this GROBID configuration

    Returns:
        encodingDesc element
    """
    encodingDesc = etree.Element("encodingDesc")
    appInfo = etree.SubElement(encodingDesc, "appInfo")

    # PDF-TEI-Editor application
    pdf_tei_app = etree.SubElement(appInfo, "application",
                                  version="1.0",
                                  ident="pdf-tei-editor",
                                  type="editor")
    etree.SubElement(pdf_tei_app, "ref", target="https://github.com/mpilhlt/pdf-tei-editor")

    # GROBID extractor application
    grobid_app = etree.SubElement(appInfo, "application",
                                 version=grobid_version,
                                 ident="GROBID",
                                 when=timestamp,
                                 type="extractor")
    desc = etree.SubElement(grobid_app, "desc")
    desc.text = "GROBID - A machine learning software for extracting information from scholarly documents"

    revision_label = etree.SubElement(grobid_app, "label", type="revision")
    revision_label.text = grobid_revision

    flavor_label = etree.SubElement(grobid_app, "label", type="flavor")
    flavor_label.text = "article/dh-law-footnotes"

    variant_label = etree.SubElement(grobid_app, "label", type="variant-id")
    variant_label.text = variant_id

    ref = etree.SubElement(grobid_app, "ref", target="https://github.com/kermitt2/grobid")

    return encodingDesc


def create_revision_desc_with_status(timestamp: str, status: str, description: str) -> etree._Element:  # type: ignore[name-defined]
    """
    Create a revisionDesc element with change tracking.

    Args:
        timestamp: ISO timestamp string
        status: Status of the change (e.g., "draft")
        description: Description of the change

    Returns:
        revisionDesc element
    """
    revisionDesc = etree.Element("revisionDesc")
    change = etree.SubElement(revisionDesc, "change", when=timestamp, status=status)
    desc = etree.SubElement(change, "desc")
    desc.text = description
    return revisionDesc


def serialize_tei_xml(tei_doc: etree._Element) -> str:  # type: ignore[name-defined]
    """
    Serialize TEI document to XML string with proper formatting and schema processing instructions.

    Args:
        tei_doc: TEI root element

    Returns:
        Formatted XML string
    """
    remove_whitespace(tei_doc)

    # Handle RelaxNG processing instruction
    relaxng_schema = tei_doc.get("_relaxng_schema")
    if relaxng_schema:
        # Remove the temporary attribute
        del tei_doc.attrib["_relaxng_schema"]

        # Create the processing instruction
        pi_content = f'href="{relaxng_schema}" type="application/xml" schematypens="http://relaxng.org/ns/structure/1.0"'

        # Serialize the element with lxml pretty printing
        tei_xml = etree.tostring(tei_doc, pretty_print=True, encoding="unicode", method="xml")

        # Remove xml declaration and add the processing instruction
        lines = tei_xml.split("\n")[1:]  # Remove XML declaration
        # Add RelaxNG processing instruction at the beginning
        lines.insert(0, f'<?xml-model {pi_content}?>')
        tei_xml = "\n".join(lines)
    else:
        # Standard serialization with lxml pretty printing
        tei_xml = etree.tostring(tei_doc, pretty_print=True, encoding="unicode", method="xml")
        # remove xml declaration
        lines = tei_xml.split("\n")
        if lines and lines[0].startswith('<?xml'):
            tei_xml = "\n".join(lines[1:])
        else:
            tei_xml = "\n".join(lines)

    return tei_xml


def remove_whitespace(element):
    """Recursively removes all tails and texts from the tree."""
    if element.text:
        element.text = element.text.strip()
    if element.tail:
        element.tail = element.tail.strip()
    for child in element:
        remove_whitespace(child)


def create_schema_processing_instruction(schema_url: str) -> str:
    """
    Create an xml-model processing instruction for schema validation.

    Args:
        schema_url: Complete URL to the RelaxNG schema file

    Returns:
        Processing instruction string with the schema reference
    """
    return f'<?xml-model href="{schema_url}" type="application/xml" schematypens="http://relaxng.org/ns/structure/1.0"?>'


def serialize_tei_with_formatted_header(tei_doc: etree._Element, processing_instructions: Optional[list] = None) -> str:  # type: ignore[name-defined]
    """
    Serialize TEI document with selective formatting:
    - Pretty-print the teiHeader for readability
    - Preserve exact formatting of all other elements (text, facsimile, etc.)
    - Preserve processing instructions (xml-model, etc.)

    Args:
        tei_doc: The TEI root element
        processing_instructions: List of processing instruction strings to prepend (e.g., ["<?xml-model ...?>"])
    """
    import re

    if processing_instructions is None:
        processing_instructions = []

    # Extract and temporarily remove all non-header elements to preserve their formatting
    non_header_elements = []
    elements_to_remove = []

    for child in tei_doc:
        # Handle both namespaced and non-namespaced teiHeader elements
        is_tei_header = (child.tag == "teiHeader" or child.tag == "{http://www.tei-c.org/ns/1.0}teiHeader")
        if not is_tei_header:
            # Serialize each non-header element separately without formatting changes
            element_xml = etree.tostring(child, encoding='unicode', method='xml')
            non_header_elements.append(element_xml)
            elements_to_remove.append(child)

    # Remove non-header elements temporarily
    for element in elements_to_remove:
        tei_doc.remove(element)

    # Force conversion of self-closing TEI tags to open/close tags
    # Add temporary content to prevent self-closing behavior
    if len(tei_doc) == 0 or (len(tei_doc) == 1 and tei_doc[0].tag.endswith('teiHeader')):
        # Add temporary comment to prevent self-closing
        temp_comment = etree.Comment("TEMPORARY_CONTENT_TO_PREVENT_SELF_CLOSING")
        tei_doc.append(temp_comment)
        added_temp_content = True
    else:
        added_temp_content = False

    # Use lxml's pretty printing which preserves case
    header_xml = etree.tostring(tei_doc, encoding='unicode', method='xml', pretty_print=True)

    # Remove temporary content if we added it
    if added_temp_content:
        header_xml = header_xml.replace('<!--TEMPORARY_CONTENT_TO_PREVENT_SELF_CLOSING-->', '')
        header_xml = header_xml.replace('<!-- TEMPORARY_CONTENT_TO_PREVENT_SELF_CLOSING -->', '')
        # Also remove from the actual tree for consistency
        if len(tei_doc) > 0 and hasattr(tei_doc[-1], 'tag') and tei_doc[-1].tag is etree.Comment:
            tei_doc.remove(tei_doc[-1])

    # Clean up the pretty-printed header (remove ONLY xml declaration, keep other processing instructions, remove empty lines)
    header_lines = [line for line in header_xml.split('\n') if line.strip() and not line.startswith('<?xml version=')]

    # Handle TEI closing tag properly
    if non_header_elements:
        # Find the closing TEI tag (case-insensitive) and insert the elements before it
        closing_tei_idx = None
        for i, line in enumerate(header_lines):
            if '</TEI>' in line or '</tei>' in line:
                closing_tei_idx = i
                break

        if closing_tei_idx is not None:
            # Insert each non-header element before the closing TEI tag
            for element_xml in non_header_elements:
                header_lines.insert(closing_tei_idx, f"  {element_xml}")
                closing_tei_idx += 1  # Update index for next insertion
        else:
            # If no closing TEI tag found, this might be a self-closing tag or malformed XML
            # In this case, we need to reconstruct the document properly
            # Remove any self-closing TEI tags and rebuild
            header_lines = [line for line in header_lines if not line.strip().endswith('/>')]

            # Add the non-header elements
            for element_xml in non_header_elements:
                header_lines.append(f"  {element_xml}")

            # Add the closing TEI tag
            header_lines.append('</TEI>')

    # Prepend processing instructions at the beginning
    if processing_instructions:
        result_lines = processing_instructions + header_lines
    else:
        result_lines = header_lines

    return '\n'.join(result_lines)


def extract_tei_metadata(tei_root: etree._Element) -> Dict[str, Any]:  # type: ignore[name-defined]
    """
    Extract metadata from TEI document for database storage.

    Extracts:
    - DOI or fileref as doc_id
    - Title
    - Authors
    - Date
    - Variant (from application metadata)
    - Gold standard status
    - Labels

    Args:
        tei_root: TEI root element

    Returns:
        Dictionary with extracted metadata
    """
    ns = {"tei": "http://www.tei-c.org/ns/1.0"}
    metadata = {}

    # Extract DOI (preferred doc_id)
    doi_elem = tei_root.find('.//tei:idno[@type="DOI"]', ns)
    if doi_elem is not None and doi_elem.text:
        metadata['doc_id'] = doi_elem.text.strip()
        metadata['doc_id_type'] = 'doi'
    else:
        # Try fileref as fallback
        fileref_elem = tei_root.find('.//tei:idno[@type="fileref"]', ns)
        if fileref_elem is not None and fileref_elem.text:
            metadata['doc_id'] = fileref_elem.text.strip()
            metadata['doc_id_type'] = 'fileref'
        else:
            # No doc_id found - caller must provide fallback
            metadata['doc_id'] = None  # type: ignore[assignment]
            metadata['doc_id_type'] = 'custom'

    # Also extract fileref separately for PDF matching (even if DOI exists)
    fileref_elem = tei_root.find('.//tei:idno[@type="fileref"]', ns)
    if fileref_elem is not None and fileref_elem.text:
        metadata['fileref'] = fileref_elem.text.strip()

    # Extract title
    title_elem = tei_root.find('.//tei:titleStmt/tei:title[@level="a"]', ns)
    if title_elem is not None and title_elem.text:
        metadata['title'] = title_elem.text.strip()

    # Extract authors
    authors = []
    for author_elem in tei_root.findall('.//tei:titleStmt/tei:author', ns):
        persName = author_elem.find('tei:persName', ns)
        if persName is not None:
            given_elem = persName.find('tei:forename', ns)
            family_elem = persName.find('tei:surname', ns)

            author = {}
            if given_elem is not None and given_elem.text:
                author['given'] = given_elem.text.strip()
            if family_elem is not None and family_elem.text:
                author['family'] = family_elem.text.strip()

            if author:
                authors.append(author)

    if authors:
        metadata['authors'] = authors  # type: ignore[assignment]

    # Extract publication date
    date_elem = tei_root.find('.//tei:publicationStmt/tei:date[@type="publication"]', ns)
    if date_elem is not None and date_elem.text:
        metadata['date'] = date_elem.text.strip()

    # Extract journal/publisher info
    journal_elem = tei_root.find('.//tei:sourceDesc//tei:title[@level="j"]', ns)
    if journal_elem is not None and journal_elem.text:
        metadata['journal'] = journal_elem.text.strip()

    publisher_elem = tei_root.find('.//tei:publicationStmt/tei:publisher', ns)
    if publisher_elem is not None and publisher_elem.text:
        metadata['publisher'] = publisher_elem.text.strip()

    # Extract variant from any extractor application metadata (GROBID, llamore, etc.)
    # Search for any application with a variant-id label
    variant_label = tei_root.find('.//tei:application[@type="extractor"]/tei:label[@type="variant-id"]', ns)
    if variant_label is not None and variant_label.text:
        metadata['variant'] = variant_label.text.strip()

    # Check for gold standard status
    # Gold standard files typically don't have version markers
    # and may have specific status indicators
    revision_desc = tei_root.find('.//tei:revisionDesc', ns)
    is_gold = False
    if revision_desc is not None:
        for change in revision_desc.findall('tei:change', ns):
            status = change.get('status', '')
            if status in ['gold', 'final', 'published']:
                is_gold = True
                break

    metadata['is_gold_standard'] = is_gold  # type: ignore[assignment]

    # Extract edition title (preferred for labels)
    edition_title_elem = tei_root.find('.//tei:editionStmt/tei:edition/tei:title', ns)
    if edition_title_elem is not None and edition_title_elem.text:
        metadata['edition_title'] = edition_title_elem.text.strip()

    # Extract labels/roles from respStmt (fallback)
    labels = []
    for resp_stmt in tei_root.findall('.//tei:titleStmt/tei:respStmt', ns):
        resp_elem = resp_stmt.find('tei:resp', ns)
        if resp_elem is not None and resp_elem.text:
            labels.append(resp_elem.text.strip())

    if labels:
        metadata['label'] = ', '.join(labels)

    # Build doc_metadata dict for storage
    doc_metadata = {}
    if 'title' in metadata:
        doc_metadata['title'] = metadata['title']
    if 'authors' in metadata:
        doc_metadata['authors'] = metadata['authors']
    if 'date' in metadata:
        doc_metadata['date'] = metadata['date']
    if 'journal' in metadata:
        doc_metadata['journal'] = metadata['journal']
    if 'publisher' in metadata:
        doc_metadata['publisher'] = metadata['publisher']

    metadata['doc_metadata'] = doc_metadata  # type: ignore[assignment]

    return metadata


def build_pdf_label_from_metadata(doc_metadata: Dict[str, Any]) -> Optional[str]:
    """
    Build a human-readable label for a PDF from extracted metadata.

    Format: "Author (Year) Title" with fallbacks to partial formats.

    Args:
        doc_metadata: Dictionary with 'title', 'authors', 'date' keys

    Returns:
        Formatted label string or None if no title available
    """
    if 'title' not in doc_metadata:
        return None

    title = doc_metadata['title']

    # Extract author (first author's family name)
    author_part = ""
    if 'authors' in doc_metadata and doc_metadata['authors']:
        first_author = doc_metadata['authors'][0]
        if 'family' in first_author:
            author_part = first_author['family']

    # Extract date/year
    date_part = ""
    if 'date' in doc_metadata:
        date_part = f"({doc_metadata['date']})"

    # Build label with author and date first, then title
    if author_part and date_part:
        return f"{author_part} {date_part} {title}"
    elif author_part:
        return f"{author_part} {title}"
    elif date_part:
        return f"{date_part} {title}"
    else:
        return title


def update_pdf_metadata_from_tei(
    pdf_file,
    tei_metadata: Dict[str, Any],
    file_repo,
    logger,
    doc_collections: Optional[list] = None
) -> bool:
    """
    Update PDF file metadata from extracted TEI metadata.

    Updates:
    - doc_metadata: Full metadata dict (title, authors, date, journal, publisher)
    - label: Human-readable label formatted as "Author (Year) Title"
    - doc_collections: Optional collection list to sync

    Args:
        pdf_file: PDF file object from FileRepository
        tei_metadata: Metadata dict from extract_tei_metadata()
        file_repo: FileRepository instance
        logger: Logger instance
        doc_collections: Optional collection list to sync to PDF

    Returns:
        True if update was attempted, False if no updates needed
    """
    from ..lib.models import FileUpdate

    # Get doc_metadata that was extracted
    doc_metadata = tei_metadata.get('doc_metadata', {})

    # Build a label for the PDF from metadata
    pdf_label = build_pdf_label_from_metadata(doc_metadata)

    # Fallback to DOI/doc_id if no label from metadata
    if not pdf_label and tei_metadata.get('doc_id'):
        pdf_label = tei_metadata['doc_id']

    # Update PDF file with extracted metadata and collection
    # Only update if there's actual data to set (avoid overwriting with empty values)
    has_metadata = bool(doc_metadata)  # Only update if dict is non-empty
    has_updates = has_metadata or pdf_label or doc_collections

    if has_updates:
        updates = FileUpdate()
        if has_metadata:
            updates.doc_metadata = doc_metadata
        if pdf_label:
            updates.label = pdf_label
        if doc_collections:
            updates.doc_collections = doc_collections

        try:
            file_repo.update_file(pdf_file.id, updates)
            logger.info(
                f"Updated PDF metadata: {pdf_file.id[:8]}... "
                f"label='{pdf_label}', collections={doc_collections}"
            )
            return True
        except Exception as e:
            logger.warning(f"Failed to update PDF metadata: {e}")
            return False

    return False


def get_annotator_name(tei_root: etree._Element, who_id: str) -> str:  # type: ignore[name-defined]
    """
    Look up annotator full name from @who ID reference.

    Args:
        tei_root: TEI root element
        who_id: Annotator ID from @who attribute (with or without "#" prefix)

    Returns:
        Full name from persName[@xml:id] or the ID if not found
    """
    # Strip leading "#" if present
    clean_id = who_id.lstrip("#") if who_id else ""
    if not clean_id:
        return "Unknown"

    ns = {
        "tei": "http://www.tei-c.org/ns/1.0",
        "xml": "http://www.w3.org/XML/1998/namespace"
    }

    # Try to find persName with matching xml:id in respStmt
    persName_elem = tei_root.find(
        f".//tei:titleStmt/tei:respStmt/tei:persName[@xml:id='{clean_id}']", ns
    )

    if persName_elem is not None and persName_elem.text:
        return persName_elem.text.strip()

    # Fallback to the ID if name not found
    return clean_id
