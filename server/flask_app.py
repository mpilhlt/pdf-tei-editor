#!/usr/bin/env python3

# A simple backend for the PDF-TEI Editor application 
# 
# Implements a REST API at /api/<path> (see individual routes). Responds with a JSON
# message which is an arbitrary value in case of success or a `{errror: "Error message"}`
# object in case of an errors. 

from flask import Flask, send_from_directory, jsonify, redirect
import os
import importlib.util
from glob import glob
from dotenv import load_dotenv
import tempfile
from pathlib import Path

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
    
# paths
project_root = Path(__file__).resolve().parent.parent
server_root = project_root / 'server'
web_root = project_root / 'app' / 'web'
node_modules_root = project_root / 'node_modules'
src_root = project_root / 'app' / 'src'
data_root = project_root / 'data' if local_webdav_root is None else local_webdav_root

# Flask app
app = Flask(__name__, static_folder=str(project_root))

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

app.config['DATA_ROOT'] = str(data_root)
print(f"Data files served from {data_root}")

# Provide a temporary directory for file uploads
app.config['UPLOAD_DIR'] = tempfile.mkdtemp()
print(f"Temporary upload dir is {app.config['UPLOAD_DIR']}")

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

