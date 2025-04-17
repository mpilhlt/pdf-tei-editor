from flask import Blueprint, request, jsonify, current_app
from lxml import etree
from glob import glob
import os
import requests
import re
from pathlib import Path
from shutil import move
from lib.decorators import handle_api_errors
from lib.server_utils import ApiError, get_gold_tei_path, make_timestamp


DOI_REGEX = r"^10.\d{4,9}/[-._;()/:A-Z0-9]+$"  # from https://www.crossref.org/blog/dois-and-matching-regular-expressions/
gemini_api_key = os.environ.get("GEMINI_API_KEY", "")  # set in .env

# import llamore from GitHub source
if os.path.isdir("llamore"):
    import sys

    sys.path.append("llamore/src")
    from llamore import GeminiExtractor
    from llamore import TeiBiblStruct
else:
    print("LLamore repo does not exist, extraction service is not available")


bp = Blueprint("extract", __name__, url_prefix="/api/extract")

# the url of the TEI schema used
TEI_SCHEMA_LOCATION = "https://raw.githubusercontent.com/mpilhlt/pdf-tei-editor/refs/heads/main/schema/tei.xsd"


@bp.route("", methods=["POST"])
@handle_api_errors
def extract():
    if "GeminiExtractor" not in globals():
        raise ApiError("Extraction service not available (Install LLamore first)")

    if gemini_api_key == "":
        raise ApiError("No Gemini API key available.")

    data = request.get_json()
    pdf_filename = data.get("pdf")
    if pdf_filename == "":
        raise ApiError("Missing PDF file name")

    UPLOAD_DIR = current_app.config["UPLOAD_DIR"]
    WEB_ROOT = current_app.config["WEB_ROOT"]

    pdf_path = Path(os.path.join(UPLOAD_DIR, pdf_filename))
    if not pdf_path.exists():
        raise ApiError(f"File {pdf_filename} has not been uploaded.")

    # handle DOI
    doi = data.get("doi", "")
    if doi != "":
        # if a (file-system-encoded) DOI is given, use it
        file_id = doi.replace("/", "__")
    else:
        # otherwise use filename of the upload
        file_id = Path(pdf_filename).stem

    # rename and move PDF
    gold_pdf_path = os.path.join(WEB_ROOT, "data", "pdf", file_id + ".pdf")
    move(pdf_path, gold_pdf_path)

    # generate TEI via reference extraction using LLamore
    tei_xml = tei_from_pdf(doi, gold_pdf_path)

    # save file
    gold_tei_path = tei_path = get_gold_tei_path(file_id)
    if os.path.exists(gold_tei_path):
        # we already have a gold file, so save as a version, not as the original
        version = make_timestamp().replace(" ", "_")
        tei_path = os.path.join("data", "versions", version, file_id + ".tei.xml")
        os.makedirs(os.path.dirname(tei_path), exist_ok=True)

    with open(tei_path, "w", encoding="utf-8") as f:
        f.write(tei_xml)

    # return result
    result = {
        "id": file_id,
        "xml": Path("/" + os.path.relpath(tei_path, WEB_ROOT)).as_posix(),
        "pdf": Path("/" + os.path.relpath(gold_pdf_path, WEB_ROOT)).as_posix(),
    }
    return jsonify(result)


def check_doi(doi):
    if not re.match(DOI_REGEX, doi, flags=re.IGNORECASE):
        raise ValueError(f"{doi} is not a valid DOI string")


def tei_from_pdf(doi: str, pdf_path: str) -> str:
    # the TEI doc
    tei_doc = create_tei_doc(TEI_SCHEMA_LOCATION)

    # create the header
    tei_header = create_tei_header(doi)
    tei_doc.append(tei_header)

    # add the references as a listBibl element
    listBibl = extract_refs_from_pdf(pdf_path)
    standOff = etree.SubElement(tei_doc, "standOff")
    standOff.append(listBibl.getchildren()[0])

    # serialize re-indented XML
    remove_whitespace(tei_doc)
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


def extract_refs_from_pdf(pdf_path: str) -> etree.Element:
    print(f"Extracting references from {pdf_path} via LLamore/Gemini")
    extractor = GeminiExtractor(gemini_api_key)
    references = extractor(pdf_path)
    parser = TeiBiblStruct()
    return etree.fromstring(parser.to_xml(references))


def create_tei_doc(schema_location: str) -> etree.Element:
    tei = etree.Element("TEI", nsmap={None: "http://www.tei-c.org/ns/1.0"})
    tei.set(
        "{http://www.w3.org/2001/XMLSchema-instance}schemaLocation",
        f"http://www.tei-c.org/ns/1.0 {schema_location}",
    )
    return tei


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
        url = f"https://api.crossref.org/works/{doi}"
        response = requests.get(url)
        response.raise_for_status()
        data = response.json()

        # metadata used
        title = data["message"]["title"][0]
        authors = [
            {"given": author["given"], "family": author["family"]}
            for author in data["message"]["author"]
        ]
        date = data["message"]["issued"]["date-parts"][0][0]
        publisher = data["message"]["publisher"]
        journal = data["message"]["container-title"][0]
        volume = data["message"]["volume"]
        issue = data["message"]["issue"]
        pages = data["message"]["page"]

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
            <change when="2024-10-27">
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
    change = etree.SubElement(revisionDesc, 'change', when=make_timestamp().split(" ")[0])
    etree.SubElement(change, 'desc').text = "Initial extraction"
   
    return teiHeader
