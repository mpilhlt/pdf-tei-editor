from flask import Blueprint, jsonify, request, current_app
import os
from lxml import etree
from lib.decorators import allow_only_secure_hosts, handle_api_errors
from lib.server_utils import ApiError
from pathlib import Path
from glob import glob

bp = Blueprint("files", __name__, url_prefix="/api/files")

file_types = {".pdf": "pdf", ".tei.xml": "xml", ".xml": "xml"}


@bp.route("/list", methods=["GET"])
@handle_api_errors
def list():
    WEB_ROOT = current_app.config["WEB_ROOT"]
    files_data = create_file_data()
    for idx, data in enumerate(files_data):
        file_path = data.get("xml", None)
        if file_path is not None:
            metadata = get_tei_metadata(os.path.join(WEB_ROOT, file_path[1:]))
            if metadata:
                files_data[idx].update(metadata)

    return jsonify({"files": files_data})


@bp.route("/save", methods=["POST"])
@allow_only_secure_hosts
@handle_api_errors
def save():
    """
    Save the given xml as a file
    """
    data = request.get_json()
    xml_string = data.get("xml_string")
    file_path = data.get("file_path")
    # validate input
    if not file_path.startswith("/data/"):
        raise ApiError("Invalid file path")
    if not xml_string:
        raise ApiError("No XML string provided")

    # save the file
    file_parts = file_path.split("/")
    file_path = os.path.join(*file_parts[1:])  # Remove the leading slash
    current_app.logger.info(f"Saving XML to {file_path}")
    with open(file_path, "w", encoding="utf-8") as f:
        f.write(xml_string)
    return jsonify({"result": "ok"})

@bp.route("/delete", methods=["POST"])
@allow_only_secure_hosts
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
        if not file_path.startswith("/data/"):
            raise ApiError("Invalid file path")
        # delete the file 
        file_parts = file_path.split("/")   
        file_path = os.path.join(*file_parts[1:])
        current_app.logger.info(f"Deleting file {file_path}")
        if os.path.exists(file_path):
            os.remove(file_path)
        else:
            raise ApiError(f"File {file_path} does not exist")
    return jsonify({"result": "ok"})


# helper functions


def create_file_data():
    """
    Creates a JSON file with a list of files in the "/data" directory which have "pdf" and "tei.xml"
    extensions. Each file is identified by its ID, which is the filename without the suffix.
    Files in the "data/versions" directory are treated as  (temporary) versions created with 
    prompt modifications or different models 
    The JSON file contains the file ID and the paths to the corresponding PDF and XML files.
    NB: This has become quite convoluted and needs a rewrite
    """
    file_id_data = {}
    for file_path in glob("data/**/*", recursive=True):
        file_type = None
        for suffix, type in file_types.items():
            path = Path(file_path)
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
        file_id_data[file_id][file_type].append(file_path)

    # create the files list
    file_list = []
    # iterate over file ids
    for file_id, file_type_data in file_id_data.items():
        file_dict = {"id": file_id, "versions":[]}
        # iterate over file types
        for file_type, files in file_type_data.items():
            for file_path in files:
                path = Path(file_path)
                if path.parent.parent.name == "versions":
                    file_dict['versions'].append({
                        'label': path.parent.name.replace("_", " "),
                        'path': "/" + file_path
                    })
                else:     
                    file_dict[file_type] = "/" + file_path

        file_dict['versions'] = sorted(file_dict['versions'], key= lambda file: file.get('version', ''), reverse=True)
        # add original as first version
        file_dict['versions'].insert(0, {
            'path': file_dict['xml'],
            'label': "Gold"
        })
        # add to the list
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
        "date": date.text if date is not None else "",
    }
