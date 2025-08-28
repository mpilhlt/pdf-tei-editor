from flask import Blueprint, jsonify, request, current_app
import os
import re
import json
import subprocess
import tempfile
import signal
import time
import logging
from lxml import etree
from lxml.etree import XMLSyntaxError, XMLSchema, RelaxNG, XMLSchemaParseError, DocumentInvalid
import xmlschema # too slow for validation but has some nice features like exporting a local copy of the schema
from urllib.error import HTTPError
import requests

from server.lib.decorators import handle_api_errors
from server.lib.server_utils import ApiError
from server.lib.relaxng_to_codemirror import generate_autocomplete_map

logger = logging.getLogger(__name__)

RELAXNG_NAMESPACE = "http://relaxng.org/ns/structure/1.0"
XSD_NAMESPACE = "http://www.w3.org/2001/XMLSchema"

# Validation timeout in seconds
VALIDATION_TIMEOUT = 30

# Known schemas with special handling requirements
SCHEMA_CONFIG = {
    "https://raw.githubusercontent.com/kermitt2/grobid/refs/heads/master/grobid-home/schemas/rng/Grobid.rng": {
        "timeout": 10,  # Reduced timeout for complex schemas
        "reason": "Grobid RelaxNG schema is complex and may be slow"
    }
}

class ValidationTimeoutError(Exception):
    """Raised when schema validation times out"""
    pass

def create_validation_script():
    """Create a standalone validation script that can be run in a subprocess"""
    return '''#!/usr/bin/env python3
import sys
import json
from lxml import etree
from lxml.etree import XMLSyntaxError, XMLSchema, RelaxNG, DocumentInvalid

def main():
    if len(sys.argv) != 4:
        print(json.dumps({"error": "Usage: script.py <schema_file> <xml_file> <namespace_type>"}))
        sys.exit(1)
    
    schema_file, xml_file, namespace_type = sys.argv[1:4]
    
    try:
        # Parse schema
        schema_tree = etree.parse(schema_file)
        
        # Parse XML
        with open(xml_file, 'rb') as f:
            xml_bytes = f.read()
        
        parser = etree.XMLParser()
        validation_xmldoc = etree.XML(xml_bytes, parser)
        
        # Load schema based on type
        if namespace_type == "http://relaxng.org/ns/structure/1.0":
            schema = RelaxNG(schema_tree)
        else:
            schema = XMLSchema(schema_tree)
        
        # Perform validation
        errors = []
        try:
            schema.assertValid(validation_xmldoc)
        except DocumentInvalid:
            for error in schema.error_log:
                errors.append({
                    "message": error.message.replace("{http://www.tei-c.org/ns/1.0}", "tei:"),
                    "line": error.line,
                    "column": error.column
                })
        
        print(json.dumps({"success": True, "errors": errors}))
        
    except Exception as e:
        print(json.dumps({"success": False, "error": str(e)}))

if __name__ == "__main__":
    main()
'''

def validate_with_timeout(schema_file, validation_xml_bytes, namespace_type, timeout=VALIDATION_TIMEOUT):
    """
    Validate XML with a timeout using subprocess isolation.
    Returns a list of validation errors or raises ValidationTimeoutError.
    """
    # Create temporary files for the validation script and XML data
    with tempfile.NamedTemporaryFile(mode='w', suffix='.py', delete=False) as script_file:
        script_file.write(create_validation_script())
        script_path = script_file.name
    
    with tempfile.NamedTemporaryFile(mode='wb', delete=False) as xml_file:
        xml_file.write(validation_xml_bytes)
        xml_path = xml_file.name
    
    try:
        # Run validation in subprocess with timeout
        # Use the Python executable directly instead of 'uv run python' 
        # to avoid dependency on uv being in PATH (e.g., in production systemd service)
        import sys
        result = subprocess.run([
            sys.executable, script_path, schema_file, xml_path, namespace_type
        ], 
        capture_output=True, 
        text=True, 
        timeout=timeout
        )
        
        if result.returncode != 0:
            raise Exception(f"Validation process failed: {result.stderr}")
        
        # Parse the JSON response
        try:
            response = json.loads(result.stdout)
            if response.get("success"):
                return response.get("errors", [])
            else:
                raise Exception(response.get("error", "Unknown validation error"))
        except json.JSONDecodeError:
            raise Exception(f"Invalid response from validation process: {result.stdout}")
            
    except subprocess.TimeoutExpired:
        raise ValidationTimeoutError(f"Schema validation timed out after {timeout} seconds")
    except Exception as e:
        raise Exception(f"Validation failed: {str(e)}")
    finally:
        # Clean up temporary files
        try:
            os.unlink(script_path)
            os.unlink(xml_path)
        except OSError:
            pass  # Ignore cleanup errors


bp = Blueprint('validate', __name__, url_prefix='/api/')

@bp.route('/validate', methods=['POST'])
@handle_api_errors
def validate_route():
    """
    Validates an XML document based on the contained schemaLocation URLs, downloads and caches them,
    and returns a JSON array of Diagnostic objects as expected by @codemirror/lint.
    """
    data = request.get_json()
    xml_string = data.get('xml_string')
    errors = validate(xml_string)
    return jsonify(errors)


@bp.route('/validate/autocomplete-data', methods=['POST'])
@handle_api_errors
def autocomplete_data_route():
    """
    Generates autocomplete data from the schema associated with an XML document.
    Returns JSON autocomplete data suitable for CodeMirror XML mode.
    """
    data = request.get_json()
    xml_string = data.get('xml_string')
    
    if not xml_string:
        raise ApiError("xml_string parameter is required")
    
    # Get the schema locations from the XML
    schema_locations = extract_schema_locations(xml_string)
    if not schema_locations:
        logger.debug('No schema location found in XML, cannot generate autocomplete data.')
        return jsonify({"error": "No schema location found in XML document"})
    
    # For autocomplete, prioritize RelaxNG schemas, fall back to first available
    schema_info = None
    for sl in schema_locations:
        if sl.get('type') == 'relaxng':
            schema_info = sl
            break
    if not schema_info:
        schema_info = schema_locations[0]
    
    namespace = schema_info['namespace']
    schema_location = schema_info['schemaLocation']
    schema_type = schema_info.get('type', 'unknown')
    
    if not schema_location.startswith("http"):
        raise ApiError(f"Schema location must start with 'http': {schema_location}")
    
    logger.debug(f"Generating autocomplete data for namespace {namespace} with {schema_type} schema at {schema_location}")
    
    # Get cache information
    schema_cache_dir, schema_cache_file, _ = get_schema_cache_info(schema_location)
    autocomplete_cache_file = os.path.join(schema_cache_dir, 'codemirror-autocomplete.json')
    
    # Check if autocomplete data is already cached
    if os.path.isfile(autocomplete_cache_file):
        logger.debug(f"Using cached autocomplete data at {autocomplete_cache_file}")
        with open(autocomplete_cache_file, 'r', encoding='utf-8') as f:
            return jsonify(json.load(f))
    
    # Download schema if it doesn't exist
    if not os.path.isfile(schema_cache_file):
        download_schema_file(schema_location, schema_cache_dir, schema_cache_file)
    else:
        logger.debug(f"Using cached schema at {schema_cache_file}")
    
    # Parse schema to determine type
    try:
        schema_tree = etree.parse(schema_cache_file)
        root_namespace = schema_tree.getroot().tag.split('}')[0][1:]
    except Exception as e:
        raise ApiError(f"Failed to parse schema file: {str(e)}")
    
    # Only generate autocomplete data for RelaxNG schemas
    if root_namespace != RELAXNG_NAMESPACE:
        raise ApiError(f"Autocomplete generation only supported for RelaxNG schemas. Found: {root_namespace}")
    
    # Generate autocomplete data using the RelaxNG converter
    try:
        logger.debug(f"Generating autocomplete data from RelaxNG schema: {schema_cache_file}")
        autocomplete_data = generate_autocomplete_map(
            schema_cache_file, 
            include_global_attrs=True, 
            sort_alphabetically=True, 
            deduplicate=True
        )
        
        # Cache the generated data
        os.makedirs(schema_cache_dir, exist_ok=True)
        with open(autocomplete_cache_file, 'w', encoding='utf-8') as f:
            json.dump(autocomplete_data, f, indent=2, ensure_ascii=False)
        
        logger.debug(f"Cached autocomplete data to {autocomplete_cache_file}")
        return jsonify(autocomplete_data)
        
    except Exception as e:
        raise ApiError(f"Failed to generate autocomplete data: {str(e)}")


def extract_schema_locations(xml_string):
    """
    Extract schema locations from XML document, supporting both XSD and RelaxNG approaches:
    - XSD: uses xsi:schemaLocation attribute
    - RelaxNG: uses xml-model processing instruction
    """
    results = []
    
    # First try XSD-style schemaLocation attribute
    schema_locations_match = re.search(r'schemaLocation="([^"]+)"', xml_string)
    if schema_locations_match:
        schema_locations_str = schema_locations_match.group(1)
        parts = re.split(r'\s+', schema_locations_str.strip())
        while len(parts) >= 2:
            results.append({ 
                "namespace": parts.pop(0), 
                "schemaLocation": parts.pop(0),
                "type": "xsd"
            })
    
    # Then try RelaxNG-style xml-model processing instruction
    xml_model_match = re.search(r'<\?xml-model\s+href="([^"]+)"[^>]*schematypens="http://relaxng\.org/ns/structure/1\.0"[^>]*\?>', xml_string)
    if xml_model_match:
        schema_location = xml_model_match.group(1)
        # Extract namespace from root element (assuming TEI)
        namespace_match = re.search(r'<\w+[^>]*xmlns="([^"]+)"', xml_string)
        namespace = namespace_match.group(1) if namespace_match else "http://www.tei-c.org/ns/1.0"
        results.append({
            "namespace": namespace,
            "schemaLocation": schema_location,
            "type": "relaxng"
        })
    
    return results


def get_schema_cache_info(schema_location):
    """
    Extract cache directory and file information for a schema location.
    Returns a tuple of (cache_dir, cache_file, filename)
    """
    schema_location_parts = schema_location.split("/")[2:-1]
    schema_cache_dir = os.path.join('schema', 'cache', *schema_location_parts)
    schema_file_name = os.path.basename(schema_location)
    schema_cache_file = os.path.join(schema_cache_dir, schema_file_name)
    return schema_cache_dir, schema_cache_file, schema_file_name


def download_schema_file(schema_location, schema_cache_dir, schema_cache_file):
    """
    Download a schema file using simple HTTP request.
    Used by autocomplete route which only supports RelaxNG anyway.
    """
    logger.debug(f"Downloading schema from {schema_location} and caching it at {schema_cache_file}")
    os.makedirs(schema_cache_dir, exist_ok=True)
    
    try:
        with requests.get(schema_location, stream=True) as r:
            r.raise_for_status()  # This will raise an HTTPError for bad responses (4xx or 5xx)
            with open(schema_cache_file, 'wb') as f:
                for chunk in r.iter_content(chunk_size=8192):
                    f.write(chunk)
    except HTTPError:
        raise ApiError(f"Failed to download schema from {schema_location} - check the URL")
    except Exception as e:
        raise ApiError(f"Failed to download schema: {str(e)}")


def validate(xml_string):
    """
    Validates an XML string using the schema declaration and schemaLocation in the xml document
    """
    parser = etree.XMLParser()
    errors = []
    
    try:
        # Convert string to bytes to handle encoding declarations properly
        xml_bytes = xml_string.encode('utf-8') if isinstance(xml_string, str) else xml_string
        xmldoc = etree.XML(xml_bytes, parser)
    except XMLSyntaxError as e:
        # if xml is invalid, return right away
        for error in e.error_log:
            errors.append({
                "message": error.message,
                "line": error.line,
                "column": error.column
            })
        return errors

    # validate xml schema
    schema_locations = extract_schema_locations(xml_string)
    if not schema_locations:
        logger.debug(f'No schema location found in XML, skipping validation.')
        return []
    
    for sl in schema_locations:
        namespace = sl['namespace']
        schema_location = sl['schemaLocation']
        schema_type = sl.get('type', 'unknown')
        
        if not schema_location.startswith("http"):
            logger.warning(f"Not validating for namespace {namespace} with schema at {schema_location}: schema location must start with 'http'")
            continue
            
        logger.debug(f"Validating doc for namespace {namespace} with {schema_type} schema at {schema_location}")
        
        # Check for schema-specific configuration
        validation_timeout = VALIDATION_TIMEOUT
        if schema_location in SCHEMA_CONFIG:
            schema_config = SCHEMA_CONFIG[schema_location]
            validation_timeout = schema_config.get("timeout", VALIDATION_TIMEOUT)
            logger.debug(f"Using custom timeout {validation_timeout}s for {schema_location}: {schema_config.get('reason', '')}")
        
        schema_cache_dir, schema_cache_file, schema_file_name = get_schema_cache_info(schema_location)
        
        # Download schema if not cached
        if not os.path.isfile(schema_cache_file):
            logger.debug(f"Downloading schema from {schema_location} and caching it at {schema_cache_file}")
            os.makedirs(schema_cache_dir, exist_ok=True)
            try:
                if schema_type == "relaxng":
                    # Download the RelaxNG schema file
                    with requests.get(schema_location, stream=True) as r:
                        r.raise_for_status()
                        with open(schema_cache_file, 'wb') as f:
                            for chunk in r.iter_content(chunk_size=8192):
                                f.write(chunk)
                else:
                    # For XSD, use xmlschema which handles includes/imports
                    xmlschema.download_schemas(schema_location, target=schema_cache_dir, save_remote=True)
            except HTTPError:
                raise ApiError(f"Failed to download schema for {namespace} from {schema_location} - check the URL")
            except xmlschema.XMLSchemaParseError as e:
                raise ApiError(f"Failed to parse schema for {namespace} from {schema_location}: {str(e)}")
        else:
            logger.debug(f"Using cached version at {schema_cache_file}")
        
        # Parse schema to determine actual type from file content
        try:
            schema_tree = etree.parse(schema_cache_file)
            root_namespace = schema_tree.getroot().tag.split('}')[0][1:]
        except Exception as e:
            raise ApiError(f"Failed to parse schema file {schema_cache_file}: {str(e)}")
        
        if root_namespace not in [XSD_NAMESPACE, RELAXNG_NAMESPACE]:
            raise ApiError(f'Unsupported schema namespace: {root_namespace}')
        
        # Prepare XML document for validation based on schema type
        if root_namespace == RELAXNG_NAMESPACE:
            # For RelaxNG, remove schemaLocation attribute if present to avoid validation errors
            validation_xml = re.sub(r'\s+xmlns:xsi="[^"]*"', '', xml_string)
            validation_xml = re.sub(r'\s+xsi:schemaLocation="[^"]*"', '', validation_xml)
            validation_xml_bytes = validation_xml.encode('utf-8') if isinstance(validation_xml, str) else validation_xml
        else:
            # For XSD, use original XML
            validation_xml_bytes = xml_string.encode('utf-8') if isinstance(xml_string, str) else xml_string
            
        # Perform validation with timeout protection using subprocess isolation
        try:
            logger.debug(f"Starting validation with {validation_timeout}s timeout")
            validation_errors = validate_with_timeout(
                schema_cache_file,  # Pass file path instead of tree
                validation_xml_bytes, 
                root_namespace, 
                timeout=validation_timeout
            )
            errors.extend(validation_errors)
            logger.debug(f"Validation completed with {len(validation_errors)} errors")
            
        except ValidationTimeoutError as e:
            logger.warning(f"⏰ VALIDATION TIMEOUT: {namespace} schema validation timed out after {validation_timeout}s - {schema_location}")
            errors.append({
                "message": f"⏰ Schema validation timed out after {validation_timeout} seconds. The schema may be too complex or the document too large. Validation was skipped for performance reasons.",
                "line": 1,
                "column": 1,
                "severity": "warning"
            })
        except Exception as e:
            logger.error(f"Validation failed for {namespace}: {str(e)}")
            errors.append({
                "message": f"Validation error: {str(e)}",
                "line": 1,
                "column": 1
            })
    return errors