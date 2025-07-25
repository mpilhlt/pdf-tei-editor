#!/usr/bin/env python3

# A simple backend for the PDF-TEI Editor application 
# 
# Implements a REST API at /api/<path> (see individual routes). Responds with a JSON
# message which is an arbitrary value in case of success or a `{errror: "Error message"}`
# object in case of an errors. 

from flask import Flask, send_from_directory, jsonify, redirect, request, current_app
import os
import importlib.util
from glob import glob
from dotenv import load_dotenv
import tempfile
from pathlib import Path
import shutil

load_dotenv()

# WebDAV support
local_webdav_root = None
if os.environ.get('WEBDAV_ENABLED', 0) == "1":
    required_vars = [
        'WEBDAV_LOCAL_ROOT', 
        'WEBDAV_HOST', 
        'WEBDAV_REMOTE_ROOT', 
        'WEBDAV_USER', 
        'WEBDAV_PASSWORD'
    ]
    if not all(v in os.environ for v in required_vars):
        raise ValueError("Missing one or more required WEBDAV environment variables.")
    local_webdav_root = Path(os.path.realpath(os.environ.get('WEBDAV_LOCAL_ROOT'))) 
    if not local_webdav_root.exists():
        raise ValueError(f"WebDAV local root {local_webdav_root} does not exist.")
    
# paths
project_root = Path(__file__).resolve().parent.parent
server_root = project_root / 'server'
web_root = project_root / 'app' / 'web'
node_modules_root = project_root / 'node_modules'
src_root = project_root / 'app' / 'src'
data_root = project_root / 'data' if local_webdav_root is None else local_webdav_root

# Flask app
app = Flask(__name__, static_folder=str(project_root))

# Dir to place app data in
app_db_dir = project_root / 'db'
app.config['DB_DIR'] = app_db_dir

# Initialize users.json if it doesn't exist
users_json_path = app_db_dir / 'users.json'
if not users_json_path.exists():
    shutil.copy(project_root / 'users.json.dist', users_json_path)
    print(f"Copied users.json.dist to {users_json_path}")

# Dynamically register blueprints from the 'api' folder
api_folder = os.path.join(server_root, 'api')
for filename in os.listdir(api_folder):
    if filename.endswith('.py') and filename != '__init__.py':
        module_name = filename[:-3]  # Remove ".py" extension
        module_path = os.path.join(api_folder, filename)

        # Use importlib to dynamically import the module
        spec = importlib.util.spec_from_file_location(module_name, module_path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)

        # Dymnically register the blueprint if it exists
        if hasattr(module, 'bp'):
            app.register_blueprint(module.bp)
            print(f"Registered blueprint: {module_name}")  
        else:
            print(f"Warning: No blueprint ('bp' attribute) found in {module_name}")

# Save the absolute path of the different root paths
app.config['PROJECT_ROOT'] = str(project_root)
app.config['WEB_ROOT'] = str(web_root)
print(f"Web files served from {web_root}")

# WebDAV support
if local_webdav_root is not None:
    app.config['WEBDAV_ENABLED'] = True
    print(f"WebDAV synchronization with {os.environ.get('WEBDAV_HOST')} enabled")
else:
    app.config['WEBDAV_ENABLED'] = False

# Path to the data files
app.config['DATA_ROOT'] = str(data_root)
print(f"Data files served from {data_root}")

# Provide a temporary directory for file uploads
app.config['UPLOAD_DIR'] = tempfile.mkdtemp()
print(f"Temporary upload dir is {app.config['UPLOAD_DIR']}")

### Routes ###

@app.before_request
def log_session_id():
    if 'X-Session-ID' in request.headers:
        session_id = request.headers.get('X-Session-ID')
        current_app.logger.info(f"===== Request for {request.endpoint} from session {session_id}")


# Serve from node_modules during development
@app.route('/node_modules/<path:path>')
def serve_node_modules(path):
    return send_from_directory(node_modules_root, path)

# Serve from /app/src during development
@app.route('/src/<path:path>')
def serve_src(path):
    return send_from_directory(src_root, path)

# Serve data files
@app.route('/data/<path:path>')
def serve_static(path):
    return send_from_directory(data_root, path)

# Serve config files 
@app.route('/config/<path:path>')
def serve_config(path):
    return send_from_directory(project_root / 'config', path)

# Serve documentation
@app.route('/docs/<path:path>')
def serve_docs(path):
    return send_from_directory(project_root / 'docs', path)

# Serve static files
@app.route('/<path:path>')
def serve_data(path):
    return send_from_directory(web_root, path)

# Redirect root to index.html
@app.route('/')
def index():
    return redirect('/index.html')

# Simple health check
@app.route('/api/health', methods=['GET'])
def health_check():
    """
    Simple health check endpoint.
    """
    return jsonify({'status': 'ok'}), 200

