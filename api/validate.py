from flask import Blueprint, jsonify, request, current_app
import os
import re
from lxml import etree
from lxml.etree import ElementTree as ET
from lxml.etree import XMLSyntaxError, XMLSchema, XMLSchemaParseError, XMLSchemaValidateError, DocumentInvalid
import xmlschema # too slow for validation but has some nice features like exporting a local copy of the schema
from urllib.error import HTTPError

from api.lib.decorators import handle_api_errors
from api.lib.server_utils import ApiError


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
        current_app.logger.debug(f"Validating doc for namespace {namespace} from schema at {schema_location}")
        schema_location_parts = schema_location.split("/")[2:-1]
        schema_cache_dir = os.path.join('schema', 'cache', *schema_location_parts)
        schema_file_name = os.path.basename(schema_location)
        schema_cache_file = os.path.join(schema_cache_dir, schema_file_name)
        
        if not os.path.isfile(schema_cache_file):
            current_app.logger.debug(f"Downloading schema from {schema_location} and caching it at {schema_cache_file}")
            os.makedirs(schema_cache_dir, exist_ok=True)
            try:
                xmlschema.download_schemas(schema_location, target=schema_cache_dir, save_remote=True)
            except HTTPError:
                raise ApiError(f"Failed to download schema for {namespace} from {schema_location} - check the URL")
            except xmlschema.XMLSchemaParseError as e:
                raise ApiError(f"Failed to parse schema for {namespace} from {schema_location}: {str(e)}")
        else:
            current_app.logger.debug(f"Using cached version at {schema_cache_file}")
        
        # Load the schema from the cache
        schema_tree = etree.parse(schema_cache_file)
        try:
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