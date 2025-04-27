#!/usr/bin/env python3

# A simple backend for the PDF-TEI Editor application 
# 
# Implements a REST API at /api/<path> (see individual routes). Responds with a JSON
# message which is an arbitrary value in case of success or a `{errror: "Error message"}`
# object in case of an errors. 

from flask import Flask, send_from_directory, jsonify, redirect
import os, sys
import importlib.util
from glob import glob
from dotenv import load_dotenv
import tempfile

web_root = os.path.dirname(__file__)
load_dotenv()

app = Flask(__name__, static_folder=web_root)

# Dynamically register blueprints from the 'api' folder
api_folder = os.path.join(web_root, 'api')
for filename in os.listdir(api_folder):
    if filename.endswith('.py') and filename != '__init__.py':
        module_name = filename[:-3]  # Remove ".py" extension
        module_path = os.path.join(api_folder, filename)

        # Use importlib to dynamically import the module
        spec = importlib.util.spec_from_file_location(module_name, module_path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)

        # Check if the module has a 'bp' attribute (blueprint instance)
        if hasattr(module, 'bp'):
            app.register_blueprint(module.bp)
            print(f"Registered blueprint: {module_name}")  # Optional logging
        else:
            print(f"Warning: No blueprint ('bp' attribute) found in {module_name}")

# Save the absolute path of the web root 
app.config['WEB_ROOT'] = web_root

# Provide a temporary directory for file uploads
app.config['UPLOAD_DIR'] = tempfile.mkdtemp()
print(f"Temporary upload dir is {app.config['UPLOAD_DIR']}")

# Serve static files
@app.route('/<path:path>')
def serve_static(path):
    return send_from_directory(web_root, path)


# Redirect root to /web/index.html
@app.route('/')
def index():
    return redirect('/web/index.html')


# Simple health check
@app.route('/api/health', methods=['GET'])
def health_check():
    """
    Simple health check endpoint.
    """
    return jsonify({'status': 'ok'}), 200

