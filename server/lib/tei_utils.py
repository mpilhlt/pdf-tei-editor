"""
TEI document creation and manipulation utilities
"""

import datetime
from typing import Dict, Any, List, Optional
from lxml import etree
import xml.dom.minidom


def create_tei_document(schema_type: str = "relaxng", 
                       schema_location: str = "https://raw.githubusercontent.com/mpilhlt/pdf-tei-editor/refs/heads/main/schema/rng/tei-bib.rng") -> etree.Element:
    """
    Create a TEI document root element with schema validation.
    
    Args:
        schema_type: "relaxng" or "xmlschema"
        schema_location: URL to the schema file
        
    Returns:
        TEI root element
    """
    tei = etree.Element("TEI", nsmap={None: "http://www.tei-c.org/ns/1.0"})
    
    if schema_type == "xmlschema":
        # XSD schema validation
        tei.set(
            "{http://www.w3.org/2001/XMLSchema-instance}schemaLocation",
            f"http://www.tei-c.org/ns/1.0 {schema_location}",
        )
    elif schema_type == "relaxng":
        # RelaxNG schema validation - mark for processing instruction
        tei.set("_relaxng_schema", schema_location)
    
    return tei


def create_tei_header(doi: str = "", metadata: Optional[Dict[str, Any]] = None, 
                     applications: Optional[List[Dict[str, str]]] = None) -> etree.Element:
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


def create_edition_stmt(date: str, title: str) -> etree.Element:
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


def create_encoding_desc_with_grobid(grobid_version: str, grobid_revision: str, timestamp: str, variant_id: str = "grobid-segmentation") -> etree.Element:
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


def create_revision_desc_with_status(timestamp: str, status: str, description: str) -> etree.Element:
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


def serialize_tei_xml(tei_doc: etree.Element) -> str:
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
        
        # Serialize the element
        tei_xml = etree.tostring(tei_doc, pretty_print=False, encoding="UTF-8").decode()
        tei_xml = xml.dom.minidom.parseString(tei_xml).toprettyxml(indent="  ", encoding="utf-8").decode()
        
        # Remove xml declaration and add the processing instruction
        lines = tei_xml.split("\n")[1:]  # Remove XML declaration
        # Add RelaxNG processing instruction at the beginning
        lines.insert(0, f'<?xml-model {pi_content}?>')
        tei_xml = "\n".join(lines)
    else:
        # Standard serialization
        tei_xml = etree.tostring(tei_doc, pretty_print=False, encoding="UTF-8").decode()
        tei_xml = xml.dom.minidom.parseString(tei_xml).toprettyxml(indent="  ", encoding="utf-8").decode()
        # remove xml declaration
        tei_xml = "\n".join(tei_xml.split("\n")[1:])
    
    return tei_xml


def remove_whitespace(element):
    """Recursively removes all tails and texts from the tree."""
    if element.text:
        element.text = element.text.strip()
    if element.tail:
        element.tail = element.tail.strip()
    for child in element:
        remove_whitespace(child)


def serialize_tei_with_formatted_header(tei_doc: etree.Element) -> str:
    """
    Serialize TEI document with selective formatting:
    - Pretty-print the teiHeader for readability
    - Preserve exact formatting of all other elements (text, facsimile, etc.)
    """
    import xml.dom.minidom
    
    # Extract and temporarily remove all non-header elements to preserve their formatting
    non_header_elements = []
    elements_to_remove = []
    
    for child in tei_doc:
        if child.tag != "{http://www.tei-c.org/ns/1.0}teiHeader":
            # Serialize each non-header element separately without formatting changes
            element_xml = etree.tostring(child, encoding='unicode', method='xml')
            non_header_elements.append(element_xml)
            elements_to_remove.append(child)
    
    # Remove non-header elements temporarily
    for element in elements_to_remove:
        tei_doc.remove(element)
    
    # Pretty-print the remaining document (mainly the teiHeader)
    header_xml = etree.tostring(tei_doc, encoding='unicode', method='xml')
    pretty_header = xml.dom.minidom.parseString(header_xml).toprettyxml(indent="  ")
    
    # Clean up the pretty-printed header (remove xml declaration and empty lines)
    header_lines = [line for line in pretty_header.split('\n') if line.strip() and not line.startswith('<?xml')]
    
    # If we have non-header elements, insert them back
    if non_header_elements:
        # Find the closing TEI tag and insert the elements before it
        closing_tei_idx = None
        for i, line in enumerate(header_lines):
            if '</TEI>' in line:
                closing_tei_idx = i
                break
        
        if closing_tei_idx is not None:
            # Insert each non-header element before the closing TEI tag
            for element_xml in non_header_elements:
                header_lines.insert(closing_tei_idx, f"  {element_xml}")
                closing_tei_idx += 1  # Update index for next insertion
        else:
            # If no closing tag found, append elements and closing tag
            for element_xml in non_header_elements:
                header_lines.append(f"  {element_xml}")
            header_lines.append("</TEI>")
    
    return '\n'.join(header_lines)