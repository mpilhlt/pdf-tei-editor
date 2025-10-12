"""
XML/TEI schema validation module.

Provides validation against XSD and RelaxNG schemas with timeout protection.
Framework-agnostic design using dependency injection.

Ported from server/api/validate.py for FastAPI migration.
"""

import os
import re
import json
import subprocess
import tempfile
import logging
from typing import List, Dict, Optional, Tuple
from pathlib import Path
from lxml import etree  # type: ignore
from lxml.etree import XMLSyntaxError
import xmlschema
import requests

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


class ValidationError(Exception):
    """Raised when validation configuration or execution fails"""
    pass


def create_validation_script() -> str:
    """
    Create a standalone validation script that can be run in a subprocess.

    Returns:
        Python script as string
    """
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


def validate_with_timeout(
    schema_file: str,
    validation_xml_bytes: bytes,
    namespace_type: str,
    timeout: int = VALIDATION_TIMEOUT
) -> List[Dict]:
    """
    Validate XML with a timeout using subprocess isolation.

    Args:
        schema_file: Path to the schema file
        validation_xml_bytes: XML content as bytes
        namespace_type: Schema namespace URI
        timeout: Timeout in seconds

    Returns:
        List of validation error dictionaries

    Raises:
        ValidationTimeoutError: If validation times out
        ValidationError: If validation process fails
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
        result = subprocess.run(
            [
                sys.executable,
                script_path,
                schema_file,
                xml_path,
                namespace_type
            ],
            capture_output=True,
            text=True,
            timeout=timeout
        )

        if result.returncode != 0:
            raise ValidationError(f"Validation process failed: {result.stderr}")

        # Parse the JSON response
        try:
            response = json.loads(result.stdout)
            if response.get("success"):
                return response.get("errors", [])
            else:
                raise ValidationError(response.get("error", "Unknown validation error"))
        except json.JSONDecodeError:
            raise ValidationError(f"Invalid response from validation process: {result.stdout}")

    except subprocess.TimeoutExpired:
        raise ValidationTimeoutError(f"Schema validation timed out after {timeout} seconds")
    except ValidationError:
        raise
    except Exception as e:
        raise ValidationError(f"Validation failed: {str(e)}")
    finally:
        # Clean up temporary files
        try:
            os.unlink(script_path)
            os.unlink(xml_path)
        except OSError:
            pass  # Ignore cleanup errors


def extract_schema_locations(xml_string: str) -> List[Dict[str, str]]:
    """
    Extract schema locations from XML document.

    Supports both XSD and RelaxNG approaches:
    - XSD: uses xsi:schemaLocation attribute
    - RelaxNG: uses xml-model processing instruction

    Args:
        xml_string: XML document as string

    Returns:
        List of dicts with keys: namespace, schemaLocation, type
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
    xml_model_match = re.search(
        r'<\?xml-model\s+href="([^"]+)"[^>]*schematypens="http://relaxng\.org/ns/structure/1\.0"[^>]*\?>',
        xml_string
    )
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


def get_schema_cache_info(schema_location: str, cache_root: Path) -> Tuple[Path, Path, str]:
    """
    Extract cache directory and file information for a schema location.

    Args:
        schema_location: URL of the schema
        cache_root: Root directory for schema cache

    Returns:
        Tuple of (cache_dir, cache_file, filename)
    """
    schema_location_parts = schema_location.split("/")[2:-1]
    schema_cache_dir = cache_root / Path(*schema_location_parts)
    schema_file_name = os.path.basename(schema_location)
    schema_cache_file = schema_cache_dir / schema_file_name
    return schema_cache_dir, schema_cache_file, schema_file_name


def download_schema_file(
    schema_location: str,
    schema_cache_dir: Path,
    schema_cache_file: Path
) -> None:
    """
    Download a schema file using simple HTTP request.

    Args:
        schema_location: URL of the schema
        schema_cache_dir: Directory to cache the schema
        schema_cache_file: Path to the cached schema file

    Raises:
        ValidationError: If download fails
    """
    logger.debug(f"Downloading schema from {schema_location} and caching it at {schema_cache_file}")
    schema_cache_dir.mkdir(parents=True, exist_ok=True)

    try:
        with requests.get(schema_location, stream=True, timeout=30) as r:
            r.raise_for_status()
            with open(schema_cache_file, 'wb') as f:
                for chunk in r.iter_content(chunk_size=8192):
                    f.write(chunk)
    except requests.HTTPError as e:
        raise ValidationError(f"Failed to download schema from {schema_location} - check the URL: {e}")
    except Exception as e:
        raise ValidationError(f"Failed to download schema: {str(e)}")


def validate(xml_string: str, cache_root: Optional[Path] = None) -> List[Dict]:
    """
    Validate an XML string using the schema declaration in the document.

    Framework-agnostic validation function with dependency injection.

    Args:
        xml_string: XML document to validate
        cache_root: Root directory for schema cache (default: schema/cache)

    Returns:
        List of error dictionaries with keys: message, line, column, severity (optional)
    """
    if cache_root is None:
        cache_root = Path('schema/cache')

    parser = etree.XMLParser()
    errors = []

    # First check for XML syntax errors
    try:
        xml_bytes = xml_string.encode('utf-8') if isinstance(xml_string, str) else xml_string
        etree.XML(xml_bytes, parser)
    except XMLSyntaxError as e:
        for error in e.error_log:  # type: ignore
            errors.append({
                "message": error.message,
                "line": error.line,
                "column": error.column
            })
        return errors

    # Validate against schema
    schema_locations = extract_schema_locations(xml_string)
    if not schema_locations:
        logger.debug('No schema location found in XML, skipping validation.')
        return []

    for sl in schema_locations:
        namespace = sl['namespace']
        schema_location = sl['schemaLocation']
        schema_type = sl.get('type', 'unknown')

        if not schema_location.startswith("http"):
            logger.warning(
                f"Not validating for namespace {namespace} with schema at {schema_location}: "
                "schema location must start with 'http'"
            )
            continue

        logger.debug(f"Validating doc for namespace {namespace} with {schema_type} schema at {schema_location}")

        # Check for schema-specific configuration
        validation_timeout = VALIDATION_TIMEOUT
        if schema_location in SCHEMA_CONFIG:
            schema_config = SCHEMA_CONFIG[schema_location]
            validation_timeout = schema_config.get("timeout", VALIDATION_TIMEOUT)
            logger.debug(
                f"Using custom timeout {validation_timeout}s for {schema_location}: "
                f"{schema_config.get('reason', '')}"
            )

        schema_cache_dir, schema_cache_file, _ = get_schema_cache_info(schema_location, cache_root)

        # Download schema if not cached
        if not schema_cache_file.is_file():
            logger.debug(f"Downloading schema from {schema_location} and caching it at {schema_cache_file}")
            schema_cache_dir.mkdir(parents=True, exist_ok=True)
            try:
                if schema_type == "relaxng":
                    # Download the RelaxNG schema file
                    download_schema_file(schema_location, schema_cache_dir, schema_cache_file)
                else:
                    # For XSD, use xmlschema which handles includes/imports
                    xmlschema.download_schemas(str(schema_location), target=str(schema_cache_dir), save_remote=True)
            except requests.HTTPError as e:
                raise ValidationError(
                    f"Failed to download schema for {namespace} from {schema_location} - check the URL: {e}"
                )
            except xmlschema.XMLSchemaParseError as e:
                raise ValidationError(
                    f"Failed to parse schema for {namespace} from {schema_location}: {str(e)}"
                )
        else:
            logger.debug(f"Using cached version at {schema_cache_file}")

        # Parse schema to determine actual type from file content
        try:
            schema_tree = etree.parse(str(schema_cache_file))
            root_namespace = schema_tree.getroot().tag.split('}')[0][1:]
        except Exception as e:
            raise ValidationError(f"Failed to parse schema file {schema_cache_file}: {str(e)}")

        if root_namespace not in [XSD_NAMESPACE, RELAXNG_NAMESPACE]:
            raise ValidationError(f'Unsupported schema namespace: {root_namespace}')

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
                str(schema_cache_file),
                validation_xml_bytes,
                root_namespace,
                timeout=validation_timeout
            )
            errors.extend(validation_errors)
            logger.debug(f"Validation completed with {len(validation_errors)} errors")

        except ValidationTimeoutError as e:
            logger.warning(
                f"⏰ VALIDATION TIMEOUT: {namespace} schema validation timed out after "
                f"{validation_timeout}s - {schema_location}"
            )
            errors.append({
                "message": (
                    f"⏰ Schema validation timed out after {validation_timeout} seconds. "
                    "The schema may be too complex or the document too large. "
                    "Validation was skipped for performance reasons."
                ),
                "line": 1,
                "column": 1,
                "severity": "warning"
            })
        except ValidationError as e:
            logger.error(f"Validation failed for {namespace}: {str(e)}")
            errors.append({
                "message": f"Validation error: {str(e)}",
                "line": 1,
                "column": 1
            })

    return errors
