import os
import requests
import re
from flask import Blueprint, request, jsonify, current_app
from lxml import etree
from pathlib import Path
from shutil import move

from llamore import GeminiExtractor
from llamore import LineByLinePrompter
from llamore import TeiBiblStruct
import datetime


from server.lib.decorators import handle_api_errors, session_required
from server.lib.server_utils import ApiError, make_timestamp, remove_obsolete_marker_if_exists

DOI_REGEX = r"^10.\d{4,9}/[-._;()/:A-Z0-9]+$"  # from https://www.crossref.org/blog/dois-and-matching-regular-expressions/
gemini_api_key = os.environ.get("GEMINI_API_KEY", "")  # set in .env

prompt_path = os.path.join(os.path.dirname(__file__), "..", "data", "prompt.json")

bp = Blueprint("extract", __name__, url_prefix="/api/extract")

# the url of the TEI schema used, needs to go into app config
TEI_XSD_SCHEMA_LOCATION = "https://raw.githubusercontent.com/mpilhlt/pdf-tei-editor/refs/heads/main/schema/xsd/tei.xsd"
TEI_RNG_SCHEMA_LOCATION = "https://raw.githubusercontent.com/mpilhlt/pdf-tei-editor/refs/heads/main/schema/rng/tei-bib.rng"

@bp.route("", methods=["POST"])
@handle_api_errors
@session_required
def extract():
    if "GeminiExtractor" not in globals():
        raise ApiError("Extraction service not available (Install LLamore first)")

    if gemini_api_key == "":
        raise ApiError("No Gemini API key available.")

    options = request.get_json()
    pdf_filename = options.get("pdf")
    if pdf_filename == "":
        raise ApiError("Missing PDF file name")
    
    collection_name = options.get("collection")

    # get file id from DOI or file name
    doi = options.get("doi", "")
    if doi != "":
        # if a (file-system-encoded) DOI is given, use it
        file_id = doi.replace("/", "__")
    else:
        # otherwise use filename of the upload
        file_id = Path(pdf_filename).stem

    # file paths
    UPLOAD_DIR = current_app.config["UPLOAD_DIR"]
    DATA_ROOT = current_app.config['DATA_ROOT']
    
    target_dir = os.path.join(DATA_ROOT, "pdf")
    
    if collection_name:
        target_dir = os.path.join(target_dir, collection_name)
    os.makedirs(target_dir, exist_ok=True)

    uplodad_pdf_path = Path(os.path.join(UPLOAD_DIR, pdf_filename))
    target_pdf_path = Path(os.path.join(target_dir, file_id + ".pdf"))
    remove_obsolete_marker_if_exists(target_pdf_path, current_app.logger)

    # check for uploaded file
    if uplodad_pdf_path.exists():
        # rename and move PDF
        move(uplodad_pdf_path, target_pdf_path)
    elif not target_pdf_path.exists():
        raise ApiError(f"File {pdf_filename} has not been uploaded.")        

    # generate TEI via reference extraction using LLamore
    try:
        tei_xml = tei_from_pdf(target_pdf_path, options)
    except Exception as e:
        os.remove(target_pdf_path)  # remove the PDF if extraction fails
        raise ApiError(f"Could not extract references from {pdf_filename}: {e}")
    
    # save xml file
    path_elems = filter(None, [DATA_ROOT, "tei", collection_name, f"{file_id}.tei.xml"])
    target_tei_path = os.path.join(*path_elems)
    final_tei_path = target_tei_path
    if os.path.exists(target_tei_path):
        # we already have a gold file, so save as a version, not as the original
        version = make_timestamp().replace(" ", "_").replace(":", "-")
        final_tei_path = os.path.join(DATA_ROOT, "versions", version, file_id + ".tei.xml")
    
    remove_obsolete_marker_if_exists(final_tei_path, current_app.logger)
    os.makedirs(os.path.dirname(final_tei_path), exist_ok=True)

    with open(final_tei_path, "w", encoding="utf-8") as f:
        f.write(tei_xml)

    # return result
    result = {
        "id": file_id,
        "xml": Path("/data/" + os.path.relpath(final_tei_path, DATA_ROOT)).as_posix(),
        "pdf": Path("/data/" + os.path.relpath(target_pdf_path, DATA_ROOT)).as_posix(),
    }
    return jsonify(result)


def check_doi(doi):
    if not re.match(DOI_REGEX, doi, flags=re.IGNORECASE):
        raise ValueError(f"{doi} is not a valid DOI string")


def tei_from_pdf(pdf_path: str, options: dict = {}) -> str:
    # the TEI doc with RelaxNG validation (default)
    tei_doc = create_tei_doc(TEI_RNG_SCHEMA_LOCATION, "relaxng")

    # create the header
    doi = options.get("doi", "")
    tei_header = create_tei_header(doi)
    tei_doc.append(tei_header)

    # add the references as a listBibl element
    listBibl = extract_refs_from_pdf(pdf_path, options)
    standOff = etree.SubElement(tei_doc, "standOff")
    standOff.append(listBibl.getchildren()[0])

    # serialize re-indented XML
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
        import xml.dom.minidom
        tei_xml = xml.dom.minidom.parseString(tei_xml).toprettyxml(indent="  ", encoding="utf-8").decode()
        
        # Remove xml declaration and add the processing instruction
        lines = tei_xml.split("\n")[1:]  # Remove XML declaration
        # Add RelaxNG processing instruction at the beginning
        lines.insert(0, f'<?xml-model {pi_content}?>')
        tei_xml = "\n".join(lines)
    else:
        # Standard serialization for XSD schema
        tei_xml = etree.tostring(tei_doc, pretty_print=False, encoding="UTF-8").decode()
        import xml.dom.minidom
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


def extract_refs_from_pdf(pdf_path: str, options:dict = {}) -> etree.Element:
    """
    Extract references from a PDF file using the Gemini API.
    Args:
        pdf_path (str): Path to the PDF file.
        options (dict): a dict of key-value pairs with extraction options
    Returns:
        etree.Element: XML element containing the extracted references.
    """
    print(f"Extracting references from {pdf_path} via LLamore/Gemini")

    class CustomPrompter(LineByLinePrompter):
        # Override the user_prompt method to customize the prompt
        def user_prompt(self, text= None, additional_instructions="") -> str:
            instructions = options.get("instructions", None)

            if instructions:
                additional_instructions += "In particular, follow these rules:\n\n" + instructions
            return super().user_prompt(text, additional_instructions)
            
    extractor = GeminiExtractor(api_key=gemini_api_key, prompter=CustomPrompter())
    references = extractor(pdf_path)
    parser = TeiBiblStruct()
    return etree.fromstring(parser.to_xml(references))


def create_tei_doc(schema_location: str, schema_type: str = "relaxng") -> etree.Element:
    tei = etree.Element("TEI", nsmap={None: "http://www.tei-c.org/ns/1.0"})
    
    if schema_type == "xmlschema":
        # XSD schema validation
        tei.set(
            "{http://www.w3.org/2001/XMLSchema-instance}schemaLocation",
            f"http://www.tei-c.org/ns/1.0 {schema_location}",
        )
    elif schema_type == "relaxng":
        # RelaxNG schema validation - add as processing instruction before the element
        # This will be handled by the XML serialization to add the processing instruction
        tei.set("_relaxng_schema", schema_location)
    
    return tei

def parse_crossref(doi):
    """
    Fetches and parses metadata for a given DOI from the CrossRef API.

    Args:
        doi (str): The Digital Object Identifier.

    Returns:
        dict: A dictionary containing the parsed metadata.

    Raises:
        requests.exceptions.HTTPError: If the CrossRef API returns an error.
    """
    url = f"https://api.crossref.org/works/{doi}"
    response = requests.get(url)
    response.raise_for_status()  # Raise an exception for bad status codes (4xx or 5xx)
    data = response.json()

    # Extract relevant metadata, handling potential missing keys gracefully
    message = data.get("message", {})
    title = message.get("title", [None])[0]
    authors_data = message.get("author", [])
    authors = [
        {"given": author.get("given"), "family": author.get("family")}
        for author in authors_data
    ]
    # Safely access nested dictionary keys for date
    issued_data = message.get("issued", {})
    date_parts = issued_data.get("date-parts", [[]])
    date = date_parts[0][0] if date_parts and date_parts[0] else None

    publisher = message.get("publisher")
    journal = message.get("container-title", [None])[0]
    volume = message.get("volume")
    issue = message.get("issue")
    pages = message.get("page")

    return {
        "title": title,
        "authors": authors,
        "date": date,
        "publisher": publisher,
        "journal": journal,
        "volume": volume,
        "issue": issue,
        "pages": pages,
    }

def parse_datacite(doi):
    """
    Fetches and parses metadata for a given DOI from the DataCite API.

    Args:
        doi (str): The Digital Object Identifier.

    Returns:
        dict: A dictionary containing the parsed metadata.

    Raises:
        requests.exceptions.HTTPError: If the DataCite API returns an error.
    """
    url = f"https://api.datacite.org/dois/{doi}"
    response = requests.get(url)
    response.raise_for_status()  # Raise an exception for bad status codes (4xx or 5xx)
    data = response.json()

    # Extract relevant metadata, handling potential missing keys gracefully
    attributes = data.get("data", {}).get("attributes", {})
    title = attributes.get("titles", [None])[0].get("title") if attributes.get("titles") else None
    
    authors_data = attributes.get("creators", [])
    authors = [
        {"given": author.get("givenName"), "family": author.get("familyName")}
        for author in authors_data
    ]

    date = attributes.get("publicationYear")
    publisher = attributes.get("publisher")
    # DataCite uses 'container' for journal information, but it might be empty
    journal = attributes.get("container", {}).get("title") if attributes.get("container") else None
    volume = attributes.get("volume",'') # DataCite might not consistently have volume/issue/pages in the same way as CrossRef
    issue = attributes.get("issue",'')
    pages = attributes.get("page")

    return {
        "title": title,
        "authors": authors,
        "date": date,
        "publisher": publisher,
        "journal": journal,
        "volume": volume,
        "issue": issue,
        "pages": pages,
    }


def create_tei_header(doi: str) -> etree.Element:
    # defaults
    authors = []
    date = ""
    publisher = ""
    volume = ""
    issue = ""
    pages = ""

    if doi != "":
        current_app.logger.info(f"Downloading metadata for {doi} from crossref.org...")
        try:
            metadata = parse_crossref(doi)
        except requests.exceptions.HTTPError as e:
            try:
                current_app.logger.info(f"CrossRef API error: {e}")
                current_app.logger.info(f"Trying DataCite API for {doi}...")
                metadata = parse_datacite(doi)
            except requests.exceptions.HTTPError as e:
                raise ApiError(f"Could not fetch metadata for DOI {doi}: {e}")
        except Exception as e:
            raise ApiError(f"Could not retrieve metadata for DOI {doi}: {e}")
        
        # extract metadata
        title = metadata.get("title", "Unknown Title")
        authors = metadata.get("authors", [])
        date = metadata.get("date", "")
        publisher = metadata.get("publisher", "Unknown Publisher")
        journal = metadata.get("journal", "")
        volume = metadata.get("volume", "")
        issue = metadata.get("issue", "")

    # <teiHeader>
    teiHeader = etree.Element("teiHeader")

    # <fileDesc>
    fileDesc = etree.SubElement(teiHeader, "fileDesc")
    titleStmt = etree.SubElement(fileDesc, "titleStmt")
    etree.SubElement(titleStmt, "title", level="a").text = title
    for author in authors:
        author_elem = etree.SubElement(titleStmt, "author")
        persName = etree.SubElement(author_elem, "persName")
        etree.SubElement(persName, "forename").text = author["given"]
        etree.SubElement(persName, "surname").text = author["family"]

    # <publicationStmt>
    publicationStmt = etree.SubElement(fileDesc, "publicationStmt")
    etree.SubElement(publicationStmt, "publisher").text = publisher
    availability = etree.SubElement(publicationStmt, "availability")
    etree.SubElement(
        availability,
        "licence",
        attrib={"target": "https://creativecommons.org/licenses/by/4.0/"},
    )
    etree.SubElement(publicationStmt, "date", type="publication").text = str(date)
    etree.SubElement(publicationStmt, "idno", type="DOI").text = doi

    # formatted citation in <sourceDesc>
    authors_str = ", ".join(
        [f'{author["given"]} {author["family"]}' for author in authors]
    )
    citation = f"{authors_str}. ({date}). {title}. {journal}, {volume}({issue}), {pages}. DOI: {doi}"
    sourceDesc = etree.SubElement(fileDesc, "sourceDesc")
    etree.SubElement(sourceDesc, "bibl").text = citation

    # <encodingDesc>
    """
        <encodingDesc>
            <appInfo>
                <application version="1.24" ident="Xaira">
                    <label>XAIRA Indexer</label>
                    <ptr target="#P1"/>
                </application>
            </appInfo>
        </encodingDesc>
     """
    encodingDesc = etree.SubElement(teiHeader, 'encodingDesc')
    appInfo = etree.SubElement(encodingDesc, 'appInfo')
    application1 = etree.SubElement(appInfo, 'application', version="1.0", ident="llamore")
    etree.SubElement(application1, 'label').text = "https://github.com/mpilhlt/llamore"
    application2 = etree.SubElement(appInfo, 'application', version="1.0", ident="pdf-tei-editor")
    etree.SubElement(application2, 'label').text = "https://github.com/mpilhlt/pdf-tei-editor"
    application3 = etree.SubElement(appInfo, 'application', version="1.0", ident="model")
    etree.SubElement(application3, 'label').text = "Gemini 2.0/LineByLinePrompter"

    # <revisionDesc>
    """
        <revisionDesc>
            <change  status="created" when="2024-08-01T14:38:32.499588">
                <name ref="#BJ">Bob Johnson</name>
                <desc>Merged the initial manual transcription by Alice Higgins with the automatic transcription from OCR Engine v3.2.  Used Alice's transcription as the base and corrected errors in it using the OCR output. </desc>
            </change>
            <change when="2024-10-28">
                <name ref="#BJ">Bob Johnson</name>
                <desc>Performed final proofreading and validation of the TEI document.</desc>
            </change>
        </revisionDesc>        
    """
    revisionDesc = etree.SubElement(teiHeader, 'revisionDesc')
    timestamp = datetime.datetime.now().isoformat()
    change = etree.SubElement(revisionDesc, 'change', when=timestamp, status="created")
    etree.SubElement(change, 'desc').text = f"First version extracted from PDF using LLamore."
   
    return teiHeader
