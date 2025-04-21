from flask import Blueprint, jsonify, request, current_app
import os
import re
from xml.etree import ElementTree
from xml.etree.ElementTree import ParseError
from xmlschema import XMLSchema
from lib.decorators import allow_only_secure_hosts, handle_api_errors
from lib.server_utils import ApiError

bp = Blueprint('validate', __name__, url_prefix='/api/')

@bp.route('/validate', methods=['POST'])
@allow_only_secure_hosts
@handle_api_errors
def validate_route():
    """
    Validates an XML document based on the contained schemaLocation URLs, downloads and caches them,
    and returns a JSON array of error messages.
    """
    data = request.get_json()
    xml_string = data.get('xml_string')
    error_messages = validate(xml_string)
    return jsonify({'errors': error_messages})


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
    Implementation adapted from https://github.com/FranklinChen/validate-xml-python/blob/master/validate.py3
    """
    try:
        xmldoc = ElementTree.fromstring(xml_string)
    except ParseError as e:
        # if xml is invalid, return right away
        line, col = e.position
        return [{
            "reason": str(e),
            "line": line,
            "col": col
        }]

    # validate xml schema
    schema_locations = extract_schema_locations(xml_string)
    if not schema_locations:
        current_app.logger.debug(f'No schema location found in XML, skipping validation.')
        return []
    
    errors = []
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
            schema = XMLSchema(schema_location) 
            schema.export(target=schema_cache_dir, save_remote=True)
        else:
            current_app.logger.debug(f"Using cached version at {schema_cache_file}")
            schema = XMLSchema(schema_cache_file) 

        try:
            for error in schema.iter_errors(xml_string):
                errors.append({
                    "reason": error.reason,
                    "path": error.path
                })
        except ElementTree.ParseError as e:
            line, col = e.position
            errors.append({
                "reason": str(e),
                "line": line,
                "col": col
            })
    return errors