from flask import Blueprint, jsonify, request, current_app
import os
import re
import json
from lxml import etree
from lxml.etree import XMLSyntaxError, XMLSchema, RelaxNG, XMLSchemaParseError, DocumentInvalid
import xmlschema # too slow for validation but has some nice features like exporting a local copy of the schema
from urllib.error import HTTPError
import requests

from server.lib.decorators import handle_api_errors
from server.lib.server_utils import ApiError
from server.lib.relaxng_to_codemirror import generate_autocomplete_map

RELAXNG_NAMESPACE = "http://relaxng.org/ns/structure/1.0"
XSD_NAMESPACE = "http://www.w3.org/2001/XMLSchema"


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
        current_app.logger.debug('No schema location found in XML, cannot generate autocomplete data.')
        return jsonify({"error": "No schema location found in XML document"})
    
    # For now, we only support the first schema location
    # TODO: Handle multiple schemas if needed
    schema_info = schema_locations[0]
    namespace = schema_info['namespace']
    schema_location = schema_info['schemaLocation']
    
    if not schema_location.startswith("http"):
        raise ApiError(f"Schema location must start with 'http': {schema_location}")
    
    current_app.logger.debug(f"Generating autocomplete data for namespace {namespace} with schema at {schema_location}")
    
    # Get cache information
    schema_cache_dir, schema_cache_file, _ = get_schema_cache_info(schema_location)
    autocomplete_cache_file = os.path.join(schema_cache_dir, 'codemirror-autocomplete.json')
    
    # Check if autocomplete data is already cached
    if os.path.isfile(autocomplete_cache_file):
        current_app.logger.debug(f"Using cached autocomplete data at {autocomplete_cache_file}")
        with open(autocomplete_cache_file, 'r', encoding='utf-8') as f:
            return jsonify(json.load(f))
    
    # Download schema if it doesn't exist
    if not os.path.isfile(schema_cache_file):
        download_schema_file(schema_location, schema_cache_dir, schema_cache_file)
    else:
        current_app.logger.debug(f"Using cached schema at {schema_cache_file}")
    
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
        current_app.logger.debug(f"Generating autocomplete data from RelaxNG schema: {schema_cache_file}")
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
        
        current_app.logger.debug(f"Cached autocomplete data to {autocomplete_cache_file}")
        return jsonify(autocomplete_data)
        
    except Exception as e:
        raise ApiError(f"Failed to generate autocomplete data: {str(e)}")


def extract_schema_locations(xml_string):
    schema_locations_match = re.search(r'schemaLocation="[^"]+"', xml_string)
    if schema_locations_match is None:
        return []
    schema_locations_str = schema_locations_match.group(0) #extract the matched string
    results = []
    parts = re.split(r'\s+', schema_locations_str[16:-1]) #remove 'schemaLocation="' and '"'
    while len(parts) >= 2:
        results.append({ "namespace": parts.pop(0), "schemaLocation": parts.pop(0) })
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
    current_app.logger.debug(f"Downloading schema from {schema_location} and caching it at {schema_cache_file}")
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
        xmldoc = etree.XML(xml_string, parser)
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
        current_app.logger.debug(f'No schema location found in XML, skipping validation.')
        return []
    
    for sl in schema_locations:
        namespace = sl['namespace']
        schema_location = sl['schemaLocation']
        if not schema_location.startswith("http"):
            current_app.logger.warning(f"Not validating for namespace {namespace} with schema at {schema_location}: schema location must start with 'http'")
            continue
            
        current_app.logger.debug(f"Validating doc for namespace {namespace} with schema at {schema_location}")
        schema_cache_dir, schema_cache_file, schema_file_name = get_schema_cache_info(schema_location)
        schema_tree = etree.parse(schema_cache_file)
        root_namespace = schema_tree.getroot().tag.split('}')[0][1:]
        
        if root_namespace not in [XSD_NAMESPACE, RELAXNG_NAMESPACE]:
            raise ApiError(f'Unsupported schema namespace: {root_namespace}')
        
        if not os.path.isfile(schema_cache_file):
            current_app.logger.debug(f"Downloading schema from {schema_location} and caching it at {schema_cache_file}")
            os.makedirs(schema_cache_dir, exist_ok=True)
            try:
                if root_namespace == RELAXNG_NAMESPACE:
                    # Use the filename from the schema info
                    schema_cache_file = os.path.join(schema_cache_dir, schema_file_name)

                    # Download the RelaxNG schema file
                    with requests.get(schema_location, stream=True) as r:
                        r.raise_for_status()  # This will raise an HTTPError for bad responses (4xx or 5xx)
                        with open(schema_cache_file, 'wb') as f:
                            for chunk in r.iter_content(chunk_size=8192):
                                f.write(chunk)
                else:
                    # xmlschema has a convenience method for this which will also download included XSD docs
                    xmlschema.download_schemas(schema_location, target=schema_cache_dir, save_remote=True)
            except HTTPError:
                raise ApiError(f"Failed to download schema for {namespace} from {schema_location} - check the URL")
            except xmlschema.XMLSchemaParseError as e:
                raise ApiError(f"Failed to parse schema for {namespace} from {schema_location}: {str(e)}")
        else:
            current_app.logger.debug(f"Using cached version at {schema_cache_file}")
        
        # Load the schema from the cache
        try:
            if root_namespace == RELAXNG_NAMESPACE:
                schema = RelaxNG(schema_tree)
            else:
                schema = XMLSchema(schema_tree)                
        except XMLSchemaParseError as e:
            raise ApiError(f"Failed to load schema for {namespace} from {schema_cache_file}: {str(e)}")
        try:
            schema.assertValid(xmldoc)
        except DocumentInvalid:
            for error in schema.error_log:
                errors.append({
                    "message": error.message.replace("{http://www.tei-c.org/ns/1.0}", "tei:"), # todo generalize this
                    "line": error.line,
                    "column": error.column
            })
    return errors