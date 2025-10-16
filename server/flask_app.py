#!/usr/bin/env python3

# A simple backend for the PDF-TEI Editor application 
# 
# Implements a REST API at /api/<path> (see individual routes). Responds with a JSON
# message which is an arbitrary value in case of success or a `{errror: "Error message"}`
# object in case of an errors. 

from flask import Flask, send_from_directory, jsonify, redirect, request, current_app
import os
import importlib.util
import logging
from glob import glob
from dotenv import load_dotenv
import tempfile
from pathlib import Path
import shutil
from server.lib.server_utils import ColoredFormatter
import json

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
config_dir = project_root / 'config'

# Flask app
app = Flask(__name__, static_folder=str(project_root))
logger = logging.getLogger(__name__)

# Middleware to handle HTTPS properly when behind a reverse proxy
class HTTPSMiddleware:
    def __init__(self, app):
        self.app = app
    
    def __call__(self, environ, start_response):
        # Check if we're behind a reverse proxy with HTTPS
        if environ.get('HTTP_X_FORWARDED_PROTO') == 'https':
            environ['wsgi.url_scheme'] = 'https'
        return self.app(environ, start_response)

# Apply the middleware
app.wsgi_app = HTTPSMiddleware(app.wsgi_app)

# Configure Flask to prefer HTTPS when behind a reverse proxy
app.config['PREFERRED_URL_SCHEME'] = 'https'

def configure_logger_with_colors(target_logger, level=logging.DEBUG):
    """Configure a logger with colorized output for development and file logging"""
    # Always configure for development since we're using this in dev mode
    target_logger.handlers.clear()

    # Console handler with colors (skip in test environment to keep console clean)
    if not os.environ.get('TEST_IN_PROGRESS'):
        console_handler = logging.StreamHandler()
        console_handler.setFormatter(ColoredFormatter(
            '[%(asctime)s] %(levelname)s in %(name)s: %(message)s'
        ))
        target_logger.addHandler(console_handler)
    
    # File handler for log/server.log
    log_dir = project_root / 'log'
    log_dir.mkdir(exist_ok=True)
    log_file = log_dir / 'server.log'
    
    file_handler = logging.FileHandler(str(log_file))
    file_handler.setFormatter(logging.Formatter(
        '[%(asctime)s] %(levelname)s in %(name)s: %(message)s'
    ))
    target_logger.addHandler(file_handler)
    
    target_logger.setLevel(level)
    target_logger.propagate = False

# Configure colorized logging for development
configure_logger_with_colors(logger)
# Configure Flask's logger to use the same setup
app.logger.handlers = logger.handlers
app.logger.setLevel(logger.level)

# Configure separate access logging for HTTP requests
log_dir = project_root / 'log'
log_dir.mkdir(exist_ok=True)

# Purge non-.log files from log directory on startup
def purge_non_log_files():
    """Remove all files from log directory that don't end with .log"""
    try:
        for file_path in log_dir.iterdir():
            if file_path.is_file() and not file_path.name.endswith('.log'):
                file_path.unlink()
                logger.info(f"Purged non-log file: {file_path.name}")
    except Exception as e:
        logger.warning(f"Failed to purge non-log files: {e}")

purge_non_log_files()

access_log_file = log_dir / 'access.log'

# Create access logger that only handles HTTP requests
access_logger = logging.getLogger('werkzeug')
access_logger.handlers.clear()
access_handler = logging.FileHandler(str(access_log_file))
access_handler.setFormatter(logging.Formatter('%(message)s'))
access_logger.addHandler(access_handler)
access_logger.setLevel(logging.INFO)
access_logger.propagate = False

# Dir to place app data in
app_db_dir = project_root / 'data' / 'db'
os.makedirs(app_db_dir, exist_ok=True)
app.config['DB_DIR'] = app_db_dir

# Initialize configuration and user management
for file in os.listdir(config_dir):
    if file.endswith('json'):
        config_db_file = app_db_dir / file
        if not config_db_file.exists():
            shutil.copy(config_dir / file, config_db_file)
            print(f"Copied {file} to {app_db_dir}")

# add missing config values
with open(config_dir / 'config.json') as f1, open(app_db_dir / 'config.json') as f:
    config_template: dict = json.load(f1)
    config_db: dict = json.load(f)
for key, value in config_template.items():
    if config_db.get(key, None) is None:
        print(f"Adding missing default config value for {key}")
        config_db.setdefault(key, value)
with open(app_db_dir / 'config.json', "w") as f:
    json.dump(config_db, f, indent=2)

# Set default logging level for all loggers
logging.getLogger().setLevel(logging.INFO)

# Configure logging levels from config
log_levels = config_db.get("server.logging.level", {})
for logger_name, level in log_levels.items():
    log_level = getattr(logging, level.upper(), None)
    if log_level:
        module_logger = logging.getLogger(logger_name)
        configure_logger_with_colors(module_logger, log_level)
        print(f"Set log level for {logger_name} to {level.upper()}")

# A simple in-memory message queue for each client
# This is a dictionary that will hold a queue for each client, identified by a unique ID
app.message_queues = {}

# Dynamically register blueprints from the 'api' folder
api_folder = os.path.join(server_root, 'api')

def load_blueprints_from_directory(directory, prefix=""):
    """Recursively load blueprints from directory and subdirectories"""
    for item in os.listdir(directory):
        item_path = os.path.join(directory, item)
        
        if os.path.isfile(item_path) and item.endswith('.py') and item != '__init__.py':
            # Load .py files as modules
            module_name = f"server.api.{prefix}{item[:-3]}" if prefix else f"server.api.{item[:-3]}"  # Remove ".py" extension

            # Use importlib to dynamically import the module
            import importlib
            module = importlib.import_module(module_name)

            # Dynamically register the blueprint if it exists
            if hasattr(module, 'bp'):
                app.register_blueprint(module.bp)
                logger.debug(f"Registered blueprint: {module_name}")  
            else:
                logger.warning(f"Warning: No blueprint ('bp' attribute) found in {module_name}")
        
        elif os.path.isdir(item_path) and not item.startswith('__'):
            # Recursively load from subdirectories
            new_prefix = f"{prefix}{item}." if prefix else f"{item}."
            load_blueprints_from_directory(item_path, new_prefix)

load_blueprints_from_directory(api_folder)

# Save the absolute path of the different root paths
app.config['PROJECT_ROOT'] = str(project_root)
app.config['WEB_ROOT'] = str(web_root)
logger.info(f"Web files served from {web_root}")

# WebDAV support
if local_webdav_root is not None:
    app.config['WEBDAV_ENABLED'] = True
    logger.info(f"WebDAV synchronization with {os.environ.get('WEBDAV_HOST')} enabled")
else:
    app.config['WEBDAV_ENABLED'] = False

# Path to the data files
app.config['DATA_ROOT'] = str(data_root)
logger.info(f"Data files served from {data_root}")

# Provide a temporary directory for file uploads
app.config['UPLOAD_DIR'] = tempfile.mkdtemp()
logger.info(f"Temporary upload dir is {app.config['UPLOAD_DIR']}")

### Routes ###

@app.before_request
def log_session_id():
    if request.endpoint and request.endpoint.startswith("serve_"):
        return
    
    session_id = request.headers.get('X-Session-ID', None)
    current_app.logger.debug(f"Request: {request.endpoint}{" from session " + session_id if session_id else ''}")

# Helper function to check if we're in development mode
def is_development_mode():
    return config_db.get("application.mode", "development") == "development"

# Serve from node_modules during development only
@app.route('/node_modules/<path:path>')
def serve_node_modules(path):
    if not is_development_mode():
        return jsonify({"error": "Not found"}), 404
    return send_from_directory(node_modules_root, path)

# Serve from /app/src during development only
@app.route('/src/<path:path>')
def serve_src(path):
    if not is_development_mode():
        return jsonify({"error": "Not found"}), 404
    return send_from_directory(src_root, path)

# Serve from /tests during development only
@app.route('/tests/<path:path>')
def serve_tests(path):
    if not is_development_mode():
        return jsonify({"error": "Not found"}), 404
    return send_from_directory(project_root / 'tests', path)

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

