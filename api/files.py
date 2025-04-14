from flask import Blueprint, jsonify, request, current_app
import os
from lxml import etree
from lib.decorators import allow_only_localhost, handle_api_errors
from lib.server_utils import ApiError
import re
from pathlib import Path
import json

bp = Blueprint('files', __name__, url_prefix='/api/files')

file_types = {
    '.pdf': 'pdf',
    '.tei.xml' : 'xml',
    '.xml': 'xml'
}

@bp.route('/list', methods=['GET'])
@handle_api_errors
def list(): 
    WEB_ROOT = current_app.config['WEB_ROOT']
    files_data = create_file_data(['data/pdf', 'data/tei'])
    for idx, data in enumerate(files_data):
        file_path = data.get('xml', None)
        if file_path is not None:
            metadata = get_tei_metadata(os.path.join(WEB_ROOT, file_path[1:]))
            print(metadata)
            if metadata:
                files_data[idx].update(metadata)
            
    return jsonify({'files': files_data})

    
@bp.route('/save', methods=['POST'])
@allow_only_localhost
@handle_api_errors
def save():
    """
    Save the given xml as a file
    """
    data = request.get_json()
    xml_string = data.get('xml_string')
    file_path = data.get('file_path')
    # validate input
    if not file_path.startswith('/data/'):
        raise ApiError('Invalid file path')
    if not xml_string:
        raise ApiError('No XML string provided')
    # save the file
    file_parts = file_path.split('/');
    file_path = os.path.join(*file_parts[1:])  # Remove the leading slash
    current_app.logger.info(f"Saving XML to {file_path}")
    with open(file_path, 'w', encoding='utf-8') as f:
            f.write(xml_string)
    return jsonify({'result': 'ok'})


# helper functions

def create_file_data(directories):
    """
    Creates a JSON file with a list of files in the specified directories.
    Each file is identified by its ID, which is the filename without the suffix, which allows
    to group together the PDF and TEI files. 
    The JSON file contains the file ID and the paths to the corresponding PDF and XML files.
    """
    file_id_data = {}
    for directory in directories:
        files = os.listdir(directory)
        for file in files:
            file_type = None
            for suffix, type in file_types.items():
                if file.endswith(suffix):
                    file_type = type
                    file_id = file[:-len(suffix)]
                    timestamp = extract_timestamp(file_id)
                    if timestamp != '':
                        file_id = file_id[:-len(timestamp)-1]
                    break
            if file_type is None:
                continue
            file_path = Path(os.path.join(directory, file)).as_posix()
            rel_file_path = Path('/' +  os.path.relpath(file_path, '.')).as_posix()
            if file_id not in file_id_data:
                file_id_data[file_id] = {}
            if file_type not in file_id_data[file_id]:
                file_id_data[file_id][file_type] = []
            file_id_data[file_id][file_type].append({
                "path": rel_file_path,
                "time": timestamp
            })
    # create the files list
    file_list = []
    # iterate over file ids 
    for file_id, file_type_data in file_id_data.items():
        file_dict = {
            "id": file_id
        }
        # iterate over file types
        for file_type, files in file_type_data.items():
            # use only the latest version of a timestamped file
            files = sorted(files, key= lambda file: file.get('time'), reverse=True)
            file_dict[file_type] = files[0].get('path')
        # add to the list of pdf-tei pairs
        file_list.append(file_dict)

    # sort by id
    file_list = sorted(file_list, key=lambda file_dict: file_dict.get('id'))
    return file_list

def extract_timestamp(filename):
    pattern = r"(\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2})"
    match = re.search(pattern, filename)
    if match:
        return match.group(1)
    else:
        return ""

def get_tei_metadata(file_path):
    """
    Retrieves TEI metadata from the specified file.
    """
    tree = etree.parse(file_path)
    root = tree.getroot()
    ns = {'tei': 'http://www.tei-c.org/ns/1.0'}
    author = root.find('./tei:teiHeader//tei:author//tei:surname', ns)
    title = root.find('./tei:teiHeader//tei:title', ns)
    date = root.find('./tei:teiHeader//tei:date', ns)
    return {
        'author': author.text if author is not None else '',
        'title': title.text if title is not None else '',
        'date': date.text if date is not None else ''
    }




