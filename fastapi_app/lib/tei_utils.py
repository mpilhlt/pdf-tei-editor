"""
TEI document creation and manipulation utilities.

This module provides framework-agnostic TEI XML processing utilities.
No Flask or FastAPI dependencies.
"""

import datetime
import os
from collections import defaultdict
from typing import Dict, Any, List, Optional, Tuple
from lxml import etree

# Import BibliographicMetadata from metadata_extraction to use as single source of truth
from .metadata_extraction import BibliographicMetadata


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
        metadata: Dictionary with title, authors, date, publisher, journal, volume, issue, pages, id
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
    id = metadata.get("id", "")


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
    if doi:
        etree.SubElement(publicationStmt, "idno", type="DOI").text = doi
    elif id:
        id_type = id.split(":")[0] if ":" in id else ""
        if id_type:
            etree.SubElement(publicationStmt, "idno", type=id_type).text = id
        else:  
            etree.SubElement(publicationStmt, "idno").text = id

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
    timestamp = datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z")
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


# Shared extractor utilities
# ==========================

def get_file_id_from_options(options: Dict[str, Any], pdf_path: Optional[str] = None) -> str:
    """
    Extract file_id from options dict or derive from PDF path.

    This utility consolidates the common pattern used by extractors to determine
    the file identifier for TEI documents.

    Args:
        options: Options dict that may contain 'doc_id' key
        pdf_path: Optional path to PDF file (used as fallback)

    Returns:
        File identifier string, or empty string if none found

    Examples:
        >>> get_file_id_from_options({'doc_id': '10.1234/example'})
        '10.1234/example'
        >>> get_file_id_from_options({}, '/path/to/document.pdf')
        'document'
    """
    file_id = options.get('doc_id')
    if not file_id and pdf_path:
        pdf_name = os.path.basename(pdf_path)
        file_id = os.path.splitext(pdf_name)[0]
    return file_id or ""


def create_edition_stmt_with_fileref(
    timestamp: str,
    title: str,
    file_id: str,
) -> etree._Element:  # type: ignore[name-defined]
    """
    Create an editionStmt element with date, title, and fileref idno.

    Extends create_edition_stmt() by adding a fileref idno element,
    which is a common pattern in extraction workflows.

    Args:
        timestamp: ISO timestamp string
        title: Edition title (e.g., "Extraction")
        file_id: File identifier to use in fileref idno

    Returns:
        editionStmt element with fileref

    Examples:
        >>> stmt = create_edition_stmt_with_fileref(
        ...     "2024-01-15T10:30:00Z",
        ...     "Extraction",
        ...     "10.1234/example"
        ... )
    """
    edition_stmt = create_edition_stmt(timestamp, title)
    edition = edition_stmt.find("edition")
    if edition is None:
        # Fallback: create edition element if not found
        edition = etree.SubElement(edition_stmt, "edition")
    fileref_elem = etree.SubElement(edition, "idno", type="fileref")
    fileref_elem.text = file_id
    return edition_stmt


def create_encoding_desc_with_extractor(
    timestamp: str,
    extractor_name: str,
    extractor_ident: str,
    extractor_version: str = "1.0",
    extractor_ref: Optional[str] = None,
    variant_id: Optional[str] = None,
    additional_labels: Optional[List[Tuple[str, str]]] = None,
) -> etree._Element:  # type: ignore[name-defined]
    """
    Create an encodingDesc element with PDF-TEI-Editor and extractor application info.

    This is a generic version of create_encoding_desc_with_grobid() that can be
    used by any extractor. It always includes the PDF-TEI-Editor application first,
    followed by the extractor-specific application.

    Args:
        timestamp: ISO timestamp string
        extractor_name: Human-readable extractor name (e.g., "GROBID", "LLamore")
        extractor_ident: Machine identifier (e.g., "grobid", "llamore")
        extractor_version: Version string (default: "1.0")
        extractor_ref: Optional URL reference for the extractor
        variant_id: Optional variant identifier
        additional_labels: List of (type, text) tuples for extra labels on extractor app

    Returns:
        encodingDesc element

    Examples:
        >>> desc = create_encoding_desc_with_extractor(
        ...     timestamp="2024-01-15T10:30:00Z",
        ...     extractor_name="GROBID",
        ...     extractor_ident="grobid",
        ...     extractor_version="0.8.0",
        ...     extractor_ref="https://github.com/kermitt2/grobid",
        ...     variant_id="grobid-segmentation",
        ...     additional_labels=[
        ...         ("revision", "abc123"),
        ...         ("flavor", "grobid-footnote-flavour"),
        ...     ]
        ... )
    """
    encodingDesc = etree.Element("encodingDesc")
    appInfo = etree.SubElement(encodingDesc, "appInfo")

    # PDF-TEI-Editor application (always first)
    pdf_tei_app = etree.SubElement(
        appInfo, "application",
        version="1.0",
        ident="pdf-tei-editor",
        type="editor"
    )
    etree.SubElement(pdf_tei_app, "label").text = "PDF-TEI Editor"
    etree.SubElement(
        pdf_tei_app, "ref",
        target="https://github.com/mpilhlt/pdf-tei-editor"
    )

    # Extractor application
    extractor_app = etree.SubElement(
        appInfo, "application",
        version=extractor_version,
        ident=extractor_ident,
        when=timestamp,
        type="extractor"
    )
    etree.SubElement(extractor_app, "label").text = extractor_name

    # Add optional reference
    if extractor_ref:
        etree.SubElement(extractor_app, "ref", target=extractor_ref)

    # Add variant-id label if provided
    if variant_id:
        variant_label = etree.SubElement(extractor_app, "label", type="variant-id")
        variant_label.text = variant_id

    # Add any additional labels
    if additional_labels:
        for label_type, label_text in additional_labels:
            label = etree.SubElement(extractor_app, "label", type=label_type)
            label.text = label_text

    return encodingDesc


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


def extract_processing_instructions(xml_string: str) -> list[str]:
    """
    Extract processing instructions (e.g., <?xml-model ...?>) from XML string.

    Args:
        xml_string: XML content as string or bytes

    Returns:
        List of processing instruction strings (excluding XML declaration)
    """
    import re
    # Ensure we have a string
    if isinstance(xml_string, bytes):
        xml_string = xml_string.decode('utf-8')
    # Match processing instructions (excluding xml declaration)
    pi_pattern = r'<\?(?!xml\s+version)[^\?]+\?>'
    matches = re.findall(pi_pattern, xml_string)
    return matches


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


def extract_tei_metadata(tei_root: etree._Element) -> BibliographicMetadata:  # type: ignore[name-defined]
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

    # Extract doc_id - prefer fileref (already encoded) over DOI (needs encoding)
    fileref_elem = tei_root.find('.//tei:idno[@type="fileref"]', ns)
    if fileref_elem is not None and fileref_elem.text:
        # Fileref is already encoded for filesystem safety
        metadata['doc_id'] = fileref_elem.text.strip()
        metadata['doc_id_type'] = 'fileref'
    else:
        # Try DOI as fallback, but encode it for use as doc_id
        doi_elem = tei_root.find('.//tei:idno[@type="DOI"]', ns)
        if doi_elem is not None and doi_elem.text:
            from .doi_utils import encode_filename
            raw_doi = doi_elem.text.strip()
            metadata['doc_id'] = encode_filename(raw_doi)
            metadata['doc_id_type'] = 'doi'
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

    # Extract status and timestamp from last revision change
    last_status = None
    last_revision = None
    revision_desc = tei_root.find('.//tei:revisionDesc', ns)
    if revision_desc is not None:
        changes = revision_desc.findall('tei:change', ns)
        if changes:
            # Get status and timestamp from last change element
            last_change = changes[-1]
            last_status = last_change.get('status')
            last_revision = last_change.get('when')

    if last_status:
        metadata['status'] = last_status  # type: ignore[assignment]

    if last_revision:
        metadata['last_revision'] = last_revision  # type: ignore[assignment]

    # Check for gold standard status
    # Gold standard files typically don't have version markers
    # and may have specific status indicators
    is_gold = False
    if last_status and last_status in ['gold', 'final', 'published']:
        is_gold = True

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

    # Convert to BibliographicMetadata type
    bibliographic_metadata: BibliographicMetadata = {
        'title': metadata.get('title'),
        'authors': metadata.get('authors', []),
        'date': metadata.get('date'),
        'publisher': metadata.get('publisher'),
        'journal': metadata.get('journal'),
        'volume': metadata.get('volume'),
        'issue': metadata.get('issue'),
        'pages': metadata.get('pages'),
        'doi': metadata.get('doi'),
        'id': metadata.get('id')
    }
    
    return bibliographic_metadata


def build_pdf_label_from_metadata(doc_metadata: BibliographicMetadata) -> Optional[str]:
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
    tei_metadata: BibliographicMetadata,
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

    # Build doc_metadata from the extracted metadata
    doc_metadata = {
        'title': tei_metadata.get('title'),
        'authors': tei_metadata.get('authors'),
        'date': tei_metadata.get('date'),
        'journal': tei_metadata.get('journal'),
        'publisher': tei_metadata.get('publisher')
    }

    # Build a label for the PDF from metadata
    pdf_label = build_pdf_label_from_metadata(tei_metadata)

    # Fallback to DOI/doc_id if no label from metadata
    if not pdf_label and tei_metadata.get('doi'):
        pdf_label = tei_metadata.get('doi')

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


def extract_xpath_text(
    content: bytes | etree._Element,  # type: ignore[name-defined]
    xpath_paths: list[str],
    attribute: Optional[str] = None
) -> Optional[str]:
    """
    Generic XPath lookup function for TEI documents.

    Tries multiple XPath expressions in order and returns the first match.

    Args:
        content: TEI document as bytes or lxml Element
        xpath_paths: List of XPath expressions to try (in order)
        attribute: Optional attribute name to extract (if None, extracts text content)

    Returns:
        Text content or attribute value of first matching element, or None
    """
    try:
        # Parse if bytes
        if isinstance(content, bytes):
            root = etree.fromstring(content)
        else:
            root = content

        ns = {'tei': 'http://www.tei-c.org/ns/1.0'}

        for xpath in xpath_paths:
            elements = root.xpath(xpath, namespaces=ns)
            if isinstance(elements, list) and len(elements) > 0:
                elem = elements[0]
                if isinstance(elem, etree._Element):  # type: ignore[name-defined]
                    if attribute:
                        value = elem.get(attribute)
                        if value:
                            return value
                    else:
                        if elem.text:
                            return elem.text.strip()
    except Exception:
        pass

    return None


def extract_fileref(content: bytes | etree._Element) -> Optional[str]:  # type: ignore[name-defined]
    """
    Extract fileref from TEI document.

    Path: /TEI/teiHeader/fileDesc/editionStmt/edition/idno[@type='fileref']

    Args:
        content: TEI document as bytes or lxml Element

    Returns:
        Fileref string or None
    """
    return extract_xpath_text(
        content,
        ["//tei:fileDesc/tei:editionStmt/tei:edition/tei:idno[@type='fileref']"]
    )


def extract_variant_id(content: bytes | etree._Element) -> Optional[str]:  # type: ignore[name-defined]
    """
    Extract variant ID from TEI document.

    Path: /TEI/teiHeader/encodingDesc/appInfo/application/label[@type='variant-id']

    Args:
        content: TEI document as bytes or lxml Element

    Returns:
        Variant ID string or None
    """
    return extract_xpath_text(
        content,
        ["//tei:encodingDesc/tei:appInfo/tei:application/tei:label[@type='variant-id']"]
    )


def extract_revision_timestamp(content: bytes | etree._Element) -> Optional[str]:  # type: ignore[name-defined]
    """
    Extract timestamp from last revision change.

    Path: /TEI/teiHeader/revisionDesc/change[last()]/@when

    Args:
        content: TEI document as bytes or lxml Element

    Returns:
        ISO timestamp string or None
    """
    try:
        # Parse if bytes
        if isinstance(content, bytes):
            root = etree.fromstring(content)
        else:
            root = content

        ns = {'tei': 'http://www.tei-c.org/ns/1.0'}

        # Get all change elements and take the last one
        changes = root.xpath("//tei:revisionDesc/tei:change", namespaces=ns)
        if isinstance(changes, list) and len(changes) > 0:
            last_change = changes[-1]
            if isinstance(last_change, etree._Element):  # type: ignore[name-defined]
                return last_change.get("when")
    except Exception:
        pass

    return None


def extract_last_revision_status(content: bytes | etree._Element) -> Optional[str]:  # type: ignore[name-defined]
    """
    Extract status from last revision change.

    Path: /TEI/teiHeader/revisionDesc/change[last()]/@status

    Args:
        content: TEI document as bytes or lxml Element

    Returns:
        Status string or None
    """
    try:
        # Parse if bytes
        if isinstance(content, bytes):
            root = etree.fromstring(content)
        else:
            root = content

        ns = {'tei': 'http://www.tei-c.org/ns/1.0'}

        # Get all change elements and take the last one
        changes = root.xpath("//tei:revisionDesc/tei:change", namespaces=ns)
        if isinstance(changes, list) and len(changes) > 0:
            last_change = changes[-1]
            if isinstance(last_change, etree._Element):  # type: ignore[name-defined]
                return last_change.get("status")
    except Exception:
        pass

    return None


def get_resp_stmt_by_id(root: etree._Element, pers_id: str) -> Optional[etree._Element]:  # type: ignore[name-defined]
    """
    Find respStmt element by persName xml:id.

    Args:
        root: TEI root element
        pers_id: The xml:id to search for

    Returns:
        respStmt element or None
    """
    ns = {
        'tei': 'http://www.tei-c.org/ns/1.0',
        'xml': 'http://www.w3.org/XML/1998/namespace'
    }

    # Find persName with matching xml:id
    persNames = root.xpath(
        f"//tei:titleStmt/tei:respStmt/tei:persName[@xml:id='{pers_id}']",
        namespaces=ns
    )

    if isinstance(persNames, list) and len(persNames) > 0:
        persName = persNames[0]
        if isinstance(persName, etree._Element):  # type: ignore[name-defined]
            # Return parent respStmt
            return persName.getparent()

    return None


def add_resp_stmt(root: etree._Element, pers_id: str, pers_name: str, resp: str = "editor") -> None:  # type: ignore[name-defined]
    """
    Add a respStmt element to the titleStmt of a TEI header.

    Args:
        root: TEI root element
        pers_id: The ID of the person (will be used as xml:id)
        pers_name: The name of the person
        resp: The responsibility (default: "editor")

    Raises:
        ValueError: If respStmt with this pers_id already exists
    """
    ns = {'tei': 'http://www.tei-c.org/ns/1.0'}
    xml_ns = 'http://www.w3.org/XML/1998/namespace'

    # Check if already exists
    if get_resp_stmt_by_id(root, pers_id):
        raise ValueError(f"respStmt with xml:id='{pers_id}' already exists")

    # Find or create titleStmt
    tei_header = root.find('.//tei:teiHeader', ns)
    if tei_header is None:
        raise ValueError("teiHeader not found")

    file_desc = tei_header.find('.//tei:fileDesc', ns)
    if file_desc is None:
        raise ValueError("fileDesc not found")

    title_stmt = file_desc.find('.//tei:titleStmt', ns)
    if title_stmt is None:
        title_stmt = etree.SubElement(file_desc, "{http://www.tei-c.org/ns/1.0}titleStmt")

    # Create respStmt
    resp_stmt = etree.SubElement(title_stmt, "{http://www.tei-c.org/ns/1.0}respStmt")
    pers_name_elem = etree.SubElement(resp_stmt, "{http://www.tei-c.org/ns/1.0}persName")
    pers_name_elem.set(f"{{{xml_ns}}}id", pers_id)
    pers_name_elem.text = pers_name

    resp_elem = etree.SubElement(resp_stmt, "{http://www.tei-c.org/ns/1.0}resp")
    resp_elem.text = resp


def add_revision_change(
    root: etree._Element,  # type: ignore[name-defined]
    when: str,
    status: str,
    who: str,
    desc: str,
    full_name: Optional[str] = None
) -> None:
    """
    Add a change element to the revisionDesc section.

    Args:
        root: TEI root element
        when: ISO timestamp string
        status: Status of the change (e.g., "draft", "published")
        who: Person ID (will be prefixed with # if needed)
        desc: Description of the change
        full_name: Optional full name for the person (creates respStmt if needed)

    Raises:
        ValueError: If teiHeader is not found
    """
    ns = {'tei': 'http://www.tei-c.org/ns/1.0'}

    # Ensure respStmt exists if full_name provided
    clean_who = who.lstrip('#')
    if full_name:
        if not get_resp_stmt_by_id(root, clean_who):
            add_resp_stmt(root, clean_who, full_name)

    # Find or create revisionDesc
    tei_header = root.find('.//tei:teiHeader', ns)
    if tei_header is None:
        raise ValueError("teiHeader not found")

    revision_desc = tei_header.find('.//tei:revisionDesc', ns)
    if revision_desc is None:
        revision_desc = etree.SubElement(tei_header, "{http://www.tei-c.org/ns/1.0}revisionDesc")

    # Create change element
    change = etree.SubElement(revision_desc, "{http://www.tei-c.org/ns/1.0}change")
    change.set("when", when)
    change.set("status", status)
    change.set("who", f"#{clean_who}" if not who.startswith('#') else who)

    desc_elem = etree.SubElement(change, "{http://www.tei-c.org/ns/1.0}desc")
    desc_elem.text = desc


def extract_change_signatures(content: bytes | etree._Element) -> list[tuple[str, str, str]]:  # type: ignore[name-defined]
    """
    Extract change element signatures from TEI document.

    Each signature is a tuple of (who, when, status) that uniquely identifies a change.
    This is useful for determining version ancestry - if version B contains all of
    version A's change signatures, B is derived from A.

    Args:
        content: TEI document as bytes or lxml Element

    Returns:
        List of (who, when, status) tuples in document order
    """
    try:
        if isinstance(content, bytes):
            root = etree.fromstring(content)
        else:
            root = content

        ns = {"tei": "http://www.tei-c.org/ns/1.0"}

        change_elements = root.findall(".//tei:revisionDesc/tei:change", ns)
        signatures = []

        for change in change_elements:
            who = change.get("who", "")
            when = change.get("when", "")
            status = change.get("status", "")
            signatures.append((who, when, status))

        return signatures

    except Exception:
        return []


def build_version_ancestry_chains(
    versions: list[dict]
) -> list[list[dict]]:
    """
    Build linear ancestry chains from a list of annotation versions.

    Determines ancestry by comparing change signatures - version B is derived from
    version A if B contains all of A's signatures as a prefix.

    Args:
        versions: List of dicts with 'label', 'stable_id', and 'change_signatures' keys.
                  change_signatures is a list of (who, when, status) tuples.

    Returns:
        List of ancestry chains. Each chain is a list of version dicts ordered
        from oldest ancestor to newest descendant. Chains share no common versions.

    Example:
        If versions have these signature lengths: A(1), B(2 extends A), C(3 extends B),
        D(2 extends A but different from B), the result would be:
        [[A, B, C], [A, D]] but since A appears in multiple chains, we deduplicate
        to get separate chains: [[A, B, C], [D]] where D shows its full lineage.
    """
    if not versions:
        return []

    # Sort by number of change signatures (fewer = older ancestor)
    sorted_versions = sorted(versions, key=lambda v: len(v.get("change_signatures", [])))

    # Build parent-child relationships
    # For each version, find its direct parent (the version with the most signatures
    # that are a prefix of this version's signatures)
    parent_map: dict[str, str | None] = {}  # stable_id -> parent stable_id
    children_map: dict[str, list[str]] = defaultdict(list)  # stable_id -> list of child stable_ids

    version_by_id = {v["stable_id"]: v for v in versions}

    for version in sorted_versions:
        sigs = version.get("change_signatures", [])
        stable_id = version["stable_id"]
        parent_map[stable_id] = None

        if not sigs:
            continue

        # Find the best parent - the version with the most signatures that are a prefix of ours
        best_parent = None
        best_parent_sig_count = 0

        for potential_parent in sorted_versions:
            if potential_parent["stable_id"] == stable_id:
                continue

            parent_sigs = potential_parent.get("change_signatures", [])
            if not parent_sigs:
                continue

            # Check if parent_sigs is a proper prefix of sigs
            if len(parent_sigs) >= len(sigs):
                continue

            # Check if all parent signatures match the beginning of our signatures
            is_prefix = all(
                parent_sigs[i] == sigs[i]
                for i in range(len(parent_sigs))
            )

            if is_prefix and len(parent_sigs) > best_parent_sig_count:
                best_parent = potential_parent["stable_id"]
                best_parent_sig_count = len(parent_sigs)

        parent_map[stable_id] = best_parent
        if best_parent:
            children_map[best_parent].append(stable_id)

    # Find root versions (no parent)
    roots = [v["stable_id"] for v in versions if parent_map.get(v["stable_id"]) is None]

    # Build chains by traversing from each root to all leaf descendants
    chains: list[list[dict]] = []

    def build_chain_to_leaves(current_id: str, current_chain: list[dict]) -> None:
        current_chain.append(version_by_id[current_id])
        children = children_map.get(current_id, [])

        if not children:
            # This is a leaf - save the chain
            chains.append(current_chain.copy())
        else:
            # Continue to each child
            for child_id in children:
                build_chain_to_leaves(child_id, current_chain.copy())

    for root_id in roots:
        build_chain_to_leaves(root_id, [])

    return chains


def update_fileref_in_xml(xml_string: str | bytes, file_id: str) -> str:
    """
    Ensure fileref in XML matches the file_id.
    Creates fileref element if missing.
    Preserves processing instructions from the original XML.

    Args:
        xml_string: TEI XML content as string or bytes
        file_id: File ID to set as fileref

    Returns:
        Updated XML string

    Raises:
        ValueError: If XML parsing fails or teiHeader structure is invalid
    """
    # Ensure we have a string
    if isinstance(xml_string, bytes):
        xml_string = xml_string.decode('utf-8')

    # Extract processing instructions before parsing
    processing_instructions = extract_processing_instructions(xml_string)

    xml_root = etree.fromstring(xml_string.encode('utf-8'))
    ns = {"tei": "http://www.tei-c.org/ns/1.0"}

    # Find or create fileref element
    fileref_elem = xml_root.find('.//tei:idno[@type="fileref"]', ns)

    if fileref_elem is not None:
        # Update existing fileref
        if fileref_elem.text != file_id:
            fileref_elem.text = file_id
            return serialize_tei_with_formatted_header(xml_root, processing_instructions)
        return xml_string

    # Create fileref element
    edition_stmt = xml_root.find('.//tei:editionStmt', ns)
    if edition_stmt is None:
        # Create editionStmt in teiHeader/fileDesc
        file_desc = xml_root.find('.//tei:fileDesc', ns)
        if file_desc is not None:
            edition_stmt = etree.SubElement(file_desc, "{http://www.tei-c.org/ns/1.0}editionStmt")

    if edition_stmt is not None:
        # Find or create edition element
        edition = edition_stmt.find('./tei:edition', ns)
        if edition is None:
            edition = etree.SubElement(edition_stmt, "{http://www.tei-c.org/ns/1.0}edition")

        # Add idno with fileref
        fileref_elem = etree.SubElement(edition, "{http://www.tei-c.org/ns/1.0}idno")
        fileref_elem.set("type", "fileref")
        fileref_elem.text = file_id

        return serialize_tei_with_formatted_header(xml_root, processing_instructions)

    return xml_string


def get_training_data_id(tei_root: etree._Element) -> Optional[str]:  # type: ignore[name-defined]
    """
    Extract training-data-id from TEI header.

    Path: /TEI/teiHeader/encodingDesc/appInfo/application[@ident="GROBID"]/label[@type="training-data-id"]

    Args:
        tei_root: TEI root element

    Returns:
        Training data ID string or None if not found
    """
    ns = {"tei": "http://www.tei-c.org/ns/1.0"}
    label = tei_root.find(
        ".//tei:encodingDesc/tei:appInfo/tei:application[@ident='GROBID']/"
        "tei:label[@type='training-data-id']",
        namespaces=ns
    )
    return label.text if label is not None else None


def set_training_data_id(tei_root: etree._Element, training_data_id: str) -> bool:  # type: ignore[name-defined]
    """
    Set or update training-data-id in TEI header.

    Adds <label type="training-data-id"> to the GROBID application element.

    Args:
        tei_root: TEI root element
        training_data_id: The training data ID to set

    Returns:
        True if successful, False if GROBID application element not found
    """
    ns = {"tei": "http://www.tei-c.org/ns/1.0"}
    grobid_app = tei_root.find(
        ".//tei:encodingDesc/tei:appInfo/tei:application[@ident='GROBID']",
        namespaces=ns
    )
    if grobid_app is None:
        return False

    # Check if label already exists
    existing_label = grobid_app.find("tei:label[@type='training-data-id']", namespaces=ns)
    if existing_label is not None:
        existing_label.text = training_data_id
    else:
        # Create new label element with TEI namespace
        tei_ns = "http://www.tei-c.org/ns/1.0"
        label = etree.Element(f"{{{tei_ns}}}label", type="training-data-id")
        label.text = training_data_id

        # Insert before <ref> element if present, otherwise append
        ref = grobid_app.find("tei:ref", namespaces=ns)
        if ref is not None:
            ref.addprevious(label)
        else:
            grobid_app.append(label)

    return True
