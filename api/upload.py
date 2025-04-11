import mimetypes
import os
from flask import Blueprint, request, jsonify
from werkzeug.utils import secure_filename
import magic 
from pathlib import Path

bp = Blueprint('upload', __name__, url_prefix='/api/upload')

# Configure the upload folder
UPLOAD_FOLDER = 'uploads'
ALLOWED_MIME_TYPES = {'application/pdf', 'application/xml', 'text/xml'}  # Use MIME types

def allow_only_localhost(f):
    def decorated_function(*args, **kwargs):
        target_host = request.headers.get('X-Forwarded-Host') or request.host
        target_host = target_host.split(":")[0]
        if target_host != 'localhost':
            return {"error": f'Access denied from {target_host}. Only localhost is allowed.'}, 403
        return f(*args, **kwargs)
    return decorated_function

def is_allowed_mime_type(filename, file_content):
    """
    Check the file type using both the file extension (mimetypes) and the file's content (magic).
    If python-magic is available it is used otherwise defaults to extension based check.
    """
    # Check based on file extension
    mime_type_by_extension, _ = mimetypes.guess_type(filename)

    if mime_type_by_extension in ALLOWED_MIME_TYPES:
        return True

    # Check based on file content using libmagic
    mime_type_by_content = magic.from_buffer(file_content, mime=True).decode('utf-8')
    if mime_type_by_content in ALLOWED_MIME_TYPES:
        return True

    return False


@bp.route('', methods=['POST'])
@allow_only_localhost
def upload_file():
    """
    Handles file uploads to the server.  Saves the uploaded file to the UPLOAD_FOLDER.
    Returns a JSON response indicating success or failure.
    """
    upload_folder = UPLOAD_FOLDER

    if 'file' not in request.files:
        return jsonify({'error': 'No file part'}), 400

    file = request.files['file']

    if file.filename == '':
        return jsonify({'error': 'No selected file'}), 400

    if file:
        # Read the file content for MIME type detection
        file_content = file.read()
        file.seek(0)  # Reset file pointer to the beginning after reading

        if is_allowed_mime_type(file.filename, file_content):
            filename = secure_filename(file.filename)
            extension = Path(filename).suffix[1:]
            filepath = os.path.join(upload_folder, filename)
            try:
                file.save(filepath)
                return jsonify({'type': extension, 'path': filepath}), 200
            except Exception as e:
                return jsonify({'error': f'Error saving file: {str(e)}'}), 500
        else:
            return jsonify({'error': 'Invalid file type. Allowed types: application/pdf, application/xml'}), 400
    else:
        return jsonify({'error': 'No file'}), 400

