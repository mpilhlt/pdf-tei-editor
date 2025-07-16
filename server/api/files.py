from flask import Blueprint, jsonify, request, current_app
import os
import re
from lxml import etree
from pathlib import Path
from glob import glob

from server.lib.decorators import handle_api_errors
from server.lib.server_utils import ApiError, make_timestamp, get_data_file_path

bp = Blueprint("files", __name__, url_prefix="/api/files")

file_types = {".pdf": "pdf", ".tei.xml": "xml", ".xml": "xml"}


@bp.route("/list", methods=["GET"])
@handle_api_errors
def list():
    data_root = current_app.config["DATA_ROOT"]
    files_data = create_file_data(data_root)
    for idx, data in enumerate(files_data):
        file_path = data.get("xml", None)
        if file_path is not None:
            metadata = get_tei_metadata(get_data_file_path(file_path))
            if 'author' in metadata:
                label = f"{metadata.get('author', '')}, {metadata.get('title', '')[:25]}... ({metadata.get('date','')})"
            else:
                label = data['id']
            metadata['label'] = label
            if metadata:
                files_data[idx].update(metadata)

    return jsonify(files_data)

def safe_file_path(file_path):
    # Remove any non-alphabetic leading characters for safety
    while not file_path[0].isalpha():
        file_path = file_path[1:]
    if not file_path.startswith("data/"):
        raise ApiError("Invalid file path") 
    return file_path


@bp.route("/save", methods=["POST"])
@handle_api_errors
def save():
    """
    Save the given xml as a file
    """
    
    # parameters
    data = request.get_json()
    xml_string: str = data.get("xml_string")
    file_path: str = safe_file_path(data.get("file_path"))
    save_as_new_version = data.get("new_version", False)
    
    # validate input
    if not xml_string:
        raise ApiError("No XML string provided")

    # save the file
    if save_as_new_version:
        file_id = Path(file_path).stem
        version = make_timestamp().replace(" ", "_").replace(":", "-")
        file_path = os.path.join("data", "versions", version, file_id + ".xml")
        os.makedirs(os.path.dirname(file_path), exist_ok=True)
        current_app.logger.info(f"Saving XML as newe version to {file_path}")
    else: 
        current_app.logger.info(f"Saving current XML to {file_path}")
    
    with open(file_path, "w", encoding="utf-8") as f:
        f.write(xml_string)
    return jsonify({"path": "/" + file_path})

@bp.route("/delete", methods=["POST"])
@handle_api_errors      
def delete():
    """
    Delete the given files
    """
    files = request.get_json()
    if not files:
        raise ApiError("No files provided")
    #if not type(files) is list: 
    #    raise ApiError("Files should be a list")
    for file_path in files: 
        # validate input
        file_path = safe_file_path(file_path)
        # delete the file 
        current_app.logger.info(f"Deleting file {file_path}")
        if os.path.exists(file_path):
            os.remove(file_path)
            if len(os.listdir(os.path.dirname(file_path))) == 0:
                os.removedirs(os.path.dirname(file_path))
        else:
            raise ApiError(f"File {file_path} does not exist")
    return jsonify({"result": "ok"})


@bp.route("/create_version_from_upload", methods=["POST"])
@handle_api_errors
def create_version_from_upload():
    """
    Creates a new version of a file from an uploaded file.
    """
    data = request.get_json()
    temp_filename = data.get("temp_filename")
    file_path = safe_file_path(data.get("file_path"))

    if not temp_filename or not file_path:
        raise ApiError("Missing temp_filename or file_path")

    UPLOAD_DIR = current_app.config["UPLOAD_DIR"]
    temp_filepath = os.path.join(UPLOAD_DIR, temp_filename)

    if not os.path.exists(temp_filepath):
        raise ApiError(f"Temporary file {temp_filename} not found")

    file_id = Path(file_path).stem
    version = make_timestamp().replace(" ", "_").replace(":", "-")
    new_version_path = os.path.join("data", "versions", version, file_id + ".xml")
    os.makedirs(os.path.dirname(new_version_path), exist_ok=True)

    with open(temp_filepath, "r", encoding="utf-8") as f_in:
        xml_content = f_in.read()
        # Remove XML declaration
        xml_content = re.sub(r'<\?xml.*\?>', '', xml_content).strip()

    with open(new_version_path, "w", encoding="utf-8") as f_out:
        f_out.write(xml_content)

    os.remove(temp_filepath)

    return jsonify({"path": "/" + new_version_path})

# helper functions


def create_file_data(data_root):
    """
    Creates a JSON file with a list of files in the "/data" directory which have "pdf" and "tei.xml"
    extensions. Each file is identified by its ID, which is the filename without the suffix.
    Files in the "data/versions" directory are treated as  (temporary) versions created with 
    prompt modifications or different models 
    The JSON file contains the file ID and the paths to the corresponding PDF and XML files.
    NB: This has become quite convoluted and needs a rewrite
    """
    file_id_data = {}
    for file_path in glob(f"{data_root}/**/*", recursive=True):
        path = Path(file_path).relative_to(data_root)
        file_type = None
        for suffix, type in file_types.items():
            if file_path.endswith(suffix):
                file_type = type
                file_id = path.name[:-len(suffix)]
                break
        if file_type is None:
            continue
        
        # create entry in id-type-data map
        if file_id not in file_id_data:
            file_id_data[file_id] = {}
        if file_type not in file_id_data[file_id]:
            file_id_data[file_id][file_type] = []
        file_id_data[file_id][file_type].append(path.as_posix())

    # create the files list
    file_list = []
    # iterate over file ids
    for file_id, file_type_data in file_id_data.items():
        file_dict = {"id": file_id, "versions":[]}
        # iterate over file types
        for file_type, files in file_type_data.items():
            for file_path in files:
                path = Path(file_path)
                path_from_root = "/data/" + file_path
                if path.parent.parent.name == "versions":
                    label = get_version_name(get_data_file_path(path_from_root)) or path.parent.name.replace("_", " ")
                    file_dict['versions'].append({
                        'label': label,
                        'path': path_from_root
                    })
                else:     
                    file_dict[file_type] = path_from_root

        file_dict['versions'] = sorted(file_dict['versions'], key= lambda file: file.get('version', ''), reverse=True)
        # add original as first version if it exists
        if 'xml' in file_dict:
            file_dict['versions'].insert(0, {
                'path': file_dict['xml'],
                'label': "Gold"
            })
        
        # only add if we have both pdf and xml
        if 'pdf' in file_dict and 'xml' in file_dict:
            file_list.append(file_dict)

    # sort by id
    file_list = sorted(file_list, key=lambda file_dict: file_dict.get("id"))
    return file_list


def get_tei_metadata(file_path):
    """
    Retrieves TEI metadata from the specified file.
    """
    tree = etree.parse(file_path)
    root = tree.getroot()
    ns = {"tei": "http://www.tei-c.org/ns/1.0"}
    author = root.find("./tei:teiHeader//tei:author//tei:surname", ns)
    title = root.find("./tei:teiHeader//tei:title", ns)
    date = root.find("./tei:teiHeader//tei:date", ns)
    return {
        "author": author.text if author is not None else "",
        "title": title.text if title is not None else "",
        "date": date.text if date is not None else ""
    }


def get_version_name(file_path):
    """
    Retrieves version title from the specified file, encoded in teiHeader/fileDesc/editionStmt/edition/title
    """
    tree = etree.parse(file_path)
    root = tree.getroot()
    ns = {"tei": "http://www.tei-c.org/ns/1.0"}
    edition_stmts = root.xpath("//tei:editionStmt", namespaces=ns)
    if not edition_stmts:
        return None
    version_title_element = edition_stmts[-1].xpath("./tei:edition/tei:title", namespaces=ns)
    if version_title_element:
        return version_title_element[0].text
    else:
        return None
    