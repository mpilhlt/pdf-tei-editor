from flask import Blueprint, request, jsonify, current_app
import os
from werkzeug.utils import secure_filename
from pathlib import Path
import mimetypes

from api.lib.decorators import handle_api_errors
from api.lib.server_utils import ApiError

try:
    import magic  # python-magic
    HAS_MAGIC = True
except ImportError:
    HAS_MAGIC = False
    print("python-magic is not installed. File type detection will be less accurate.")

bp = Blueprint('upload', __name__, url_prefix='/api/upload')

ALLOWED_MIME_TYPES = {'application/pdf', 'application/xml', 'text/xml'}  # Use MIME types

@bp.route('', methods=['POST'])
@handle_api_errors
def upload_file():
    """
    Handles file uploads to the server.  Saves the uploaded file to the UPLOAD_FOLDER.
    Returns a JSON response indicating success or failure.
    """

    UPLOAD_DIR = current_app.config['UPLOAD_DIR']

    if 'file' not in request.files:
        raise ApiError('No file part')

    file = request.files['file']

    if file.filename == '':
        raise ApiError('No selected file')

    if file:
        # Read the file content for MIME type detection
        file_content = file.read()
        file.seek(0)  # Reset file pointer to the beginning after reading

        if is_allowed_mime_type(file.filename, file_content):
            filename = secure_filename(file.filename)
            extension = Path(filename).suffix[1:]
            filepath = os.path.join(UPLOAD_DIR, filename)
            try:
                file.save(filepath)
                return jsonify({'type': extension, 'filename': filename}), 200
            except Exception as e:
                raise ApiError(f'Error saving file: {str(e)}')
        else:
            raise ApiError('Invalid file type. Allowed types: application/pdf, application/xml')
    else:
        raise ApiError('No file')

def is_allowed_mime_type(filename, file_content):
    """
    Check the file type using both the file extension (mimetypes) and the file's content (magic).
    """

    if HAS_MAGIC:
        # Check based on file content using libmagic
        mime_type_by_content = magic.from_buffer(file_content, mime=True).decode('utf-8')
        if mime_type_by_content in ALLOWED_MIME_TYPES:
            return True
    else:
        print("magic library not available, skipping content-based MIME type check.")
        
    # Check based on file extension
    mime_type_by_extension, _ = mimetypes.guess_type(filename)

    if mime_type_by_extension in ALLOWED_MIME_TYPES:
        return True

    return False
