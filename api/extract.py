from flask import Blueprint, request, jsonify, current_app
from lxml import etree
from glob import glob
import os
import requests
import re
from pathlib import Path
from shutil import move
from lib.decorators import handle_api_errors
from lib.server_utils import ApiError
import datetime

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
    
    UPLOAD_DIR = current_app.config['UPLOAD_DIR']
    WEB_ROOT = current_app.config['WEB_ROOT']
    
    pdf_path = Path(os.path.join(UPLOAD_DIR, pdf_filename))
    if not pdf_path.exists():
        raise ApiError(f'File {pdf_filename} has not been uploaded.')

    # handle DOI
    doi = data.get("doi", '')
    if doi != '':
        # if a DOI is given, use the shortDOI (with the "10." prefix removed as filename
        file_id = get_short_doi(doi)[3:]
    else:
        # otherwise use filename of the upload
        file_id = Path(pdf_filename).stem

    # rename and move PDF
    gold_pdf_path = os.path.join(WEB_ROOT, "data", "pdf", f"{file_id}.pdf")
    move(pdf_path, gold_pdf_path)

    # generate and save TEI via reference extraction using LLamore 
    tei_xml = tei_from_pdf(doi, gold_pdf_path)

    # save TEI with a timestamp to avoid overwriting 
    current_datetime = datetime.datetime.now()
    timestamp = current_datetime.strftime("%Y-%m-%d_%H-%M-%S")

    gold_tei_path = os.path.join(WEB_ROOT, "data", "tei", f"{file_id}_{timestamp}.tei.xml") 
    with open(gold_tei_path, "w", encoding="utf-8") as f:
        f.write(tei_xml)
    
    # return result
    result = {
        "id": file_id, 
        "xml": Path('/' + os.path.relpath(gold_tei_path, WEB_ROOT)).as_posix(), 
        "pdf": Path('/' + os.path.relpath(gold_pdf_path, WEB_ROOT)).as_posix()
    }
    return jsonify(result)


def check_doi(doi):
    if not re.match(DOI_REGEX, doi, flags=re.IGNORECASE):
        raise ValueError(f"{doi} is not a valid DOI string")


def get_short_doi(doi):
    check_doi(doi)
    current_app.logger.info(f"Getting short doi for {doi} from crossref.org...")
    url = f"https://shortdoi.org/{doi}?format=json"  #
    response = requests.get(url)
    response.raise_for_status()
    data = response.json()
    return data.get("ShortDOI")


def tei_from_pdf(doi: str, pdf_path: str) -> str:
    # the TEI doc
    tei_doc = create_tei_doc(TEI_SCHEMA_LOCATION)

    # create the header from doi metadata
    if (doi != ''):
        tei_header = create_tei_header_from_doi(doi)
        tei_doc.append(tei_header)

    # add the references as a listBibl element
    listBibl = extract_refs_from_pdf(pdf_path)
    standOff = etree.SubElement(tei_doc, "standOff")
    standOff.append(listBibl.getchildren()[0])

    # serialize XML
    tei_xml = etree.tostring(tei_doc, pretty_print=True, encoding="UTF-8").decode()
    return tei_xml


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


def create_tei_header_from_doi(doi: str) -> etree.Element:
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

    return teiHeader
