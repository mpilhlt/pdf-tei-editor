from flask import Blueprint, jsonify, request, current_app
import os
from lxml import etree
from xml.etree import ElementTree
from xml.etree.ElementTree import ParseError

bp = Blueprint('files', __name__, url_prefix='/api/files')

file_types = {
    '.pdf': 'pdf',
    '.tei.xml' : 'xml',
    '.xml': 'xml'
}

@bp.route('/list', methods=['GET'])
def list(): 
    try:
        file_data = create_file_data(['data/pdf', 'data/tei'])
        for idx, file in enumerate(file_data):  
            file_path = "." + file['xml']
            metadata = get_tei_metadata(file_path)
            if metadata:
                file_data[idx].update(metadata)
                
        return jsonify({'files': file_data})
    except Exception as e:
        current_app.logger.exception(f"An unexpected error occurred.")
        return jsonify({'error': f'Error: {str(e)}'}), 500
    
@bp.route('/save', methods=['POST'])
def save():
    """
    Validates an XML document based on the contained schemaLocation URLs, downloads and caches them,
    and returns a JSON array of error messages.
    """
    try:
        data = request.get_json()
        xml_string = data.get('xml_string')
        file_path = data.get('file_path')
        if not file_path.starts_with('/data/'):
            return jsonify({'error': 'Invalid file path'}), 400
        if not xml_string:
            return jsonify({'error': 'No XML string provided'}), 400
        with open(file_path, 'w', encoding='utf-8') as f:
            f.write(xml_string)
        # Validate the XML file
        return jsonify({'result': 'ok'})

    except Exception as e:
        current_app.logger.exception(f"An unexpected error occurred.")  # Log the error for debugging
        return jsonify({'error': f'Error: {str(e)}'}), 500


# helper functions

def create_file_data(directories):
    """
    Creates a JSON file with a list of files in the specified directories.
    Each file is identified by its ID, which is the filename without the suffix.
    The JSON file contains the file ID and the paths to the files in each directory.
    """
    files_in_dirs = {}
    for directory in directories:
        files = os.listdir(directory)
        for file in files:
            file_type = None
            for suffix, type in file_types.items():
                if file.endswith(suffix):
                    file_type = type
                    file_id = file[:-len(suffix)]
                    break
            if file_type is None:
                continue
            file_path = os.path.join(directory, file).replace('\\', '/')
            if file_id not in files_in_dirs:
                files_in_dirs[file_id] = []
            files_in_dirs[file_id].append( (file_type, '/' +  os.path.relpath(file_path, '.').replace('\\', '/')) )
            
    common_files = []
    for file_id, files in files_in_dirs.items():
        if len(files) != len(directories):
            current_app.logger.warning(f'Number of files does not match number of directories for {file_id}')
            continue
        file_dict = {
            "id": file_id
        }
        for base_dir, file in files:
            file_dict[base_dir] = file
        common_files.append(file_dict)
    common_files = sorted(common_files, key=lambda file_dict: file_dict['id'])
    return common_files

def get_tei_metadata(file_path):
    """
    Retrieves TEI metadata from the specified file.
    """
    try:
        if not os.path.exists(file_path):
            current_app.logger.error(f"File not found: {file_path}")
            return None
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

    except Exception as e:
        current_app.logger.error(f"Error reading TEI metadata from {file_path}: {str(e)}")
        return None





