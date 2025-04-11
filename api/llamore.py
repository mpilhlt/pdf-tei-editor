from flask import Blueprint, request, jsonify
from lxml import etree
from io import StringIO
from glob import glob
import os
import requests

import sys
sys.path.append('llamore/src')
from llamore import GeminiExtractor
from llamore import TeiBiblStruct

bp = Blueprint('llamore', __name__, url_prefix='/api/extract')

# set this to True to regenerate the files
overwrite = False

# use Geminin extractor: provide your API key in `.env`
extractor = GeminiExtractor(api_key=os.environ["GEMINI_API_KEY"])

def create_tei_header(doi):
    url = f"https://api.crossref.org/works/{doi}"
    response = requests.get(url)
    data = response.json()

    title = data['message']['title'][0]
    authors = [{"given": author['given'], "family": author['family']} for author in data['message']['author']]
    date = data['message']['issued']['date-parts'][0][0]
    publisher = data['message']['publisher']
    journal = data['message']['container-title'][0]
    volume = data['message']['volume']
    issue = data['message']['issue']
    pages = data['message']['page']

    tei = etree.Element("TEI", nsmap={None: "http://www.tei-c.org/ns/1.0"})
    teiHeader = etree.SubElement(tei, "teiHeader")
    fileDesc = etree.SubElement(teiHeader, "fileDesc")

    titleStmt = etree.SubElement(fileDesc, "titleStmt")
    etree.SubElement(titleStmt, "title", level="a").text = title
    for author in authors:
        author_elem = etree.SubElement(titleStmt, "author")
        persName = etree.SubElement(author_elem, "persName")
        etree.SubElement(persName, "forename").text = author['given']
        etree.SubElement(persName, "surname").text = author['family']

    publicationStmt = etree.SubElement(fileDesc, "publicationStmt")
    etree.SubElement(publicationStmt, "publisher").text = publisher
    availability = etree.SubElement(publicationStmt, "availability")
    etree.SubElement(availability, "licence", attrib={"target": "https://creativecommons.org/licenses/by/4.0/"})
    etree.SubElement(publicationStmt, "date", type="publication").text = str(date)
    etree.SubElement(publicationStmt, "idno", type="DOI").text = doi

    # formatted citation
    authors_str = ', '.join([f'{author["given"]} {author["family"]}' for author in authors])
    citation = f"{authors_str}. ({date}). {title}. {journal}, {volume}({issue}), {pages}. DOI: {doi}"
    sourceDesc = etree.SubElement(fileDesc, "sourceDesc")
    etree.SubElement(sourceDesc, "bibl").text = citation

    return etree.tostring(tei, pretty_print=True, encoding="UTF-8").decode()

@bp.route('', methods=['POST'])
def extract():
    for pdf_path in glob("../uploads/*.pdf"):
        
        pdf_file = os.path.basename(pdf_path)
        doi = pdf_file.replace(".pdf", "").replace("__", "/")
        outfile = f"../uploads/{doi.replace('/','__')}.tei.xml"
        
        if overwrite == False and os.path.exists(outfile):
            continue
        
        # create a TEI document with header generated from crossref metadata
        print(f"Retrieving metadata for {doi}")
        tei_document = etree.fromstring(create_tei_header(doi))
        tei_document.set('{http://www.w3.org/2001/XMLSchema-instance}schemaLocation', 'http://www.tei-c.org/ns/1.0 ../../schema/xsd/document.xsd')

        # add the references as a listBibl element
        print(f"Extracting references from {pdf_file}")
        references = extractor(pdf_path)
        parser = TeiBiblStruct()
        listBibl = etree.fromstring(parser.to_xml(references))
        standOff = etree.SubElement(tei_document, "standOff")
        standOff.append(listBibl.getchildren()[0])
        tei_xml = etree.tostring(tei_document, pretty_print=True, encoding="UTF-8").decode()
        with open(outfile, "w", encoding='utf-8') as f:
            f.write(tei_xml)