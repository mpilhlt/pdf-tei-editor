"""
XML/TEI validation router for FastAPI.

Provides endpoints for:
- XML schema validation (XSD and RelaxNG)
- CodeMirror autocomplete data generation

For FastAPI migration - Phase 5.
"""

from fastapi import APIRouter, HTTPException, Depends
from pathlib import Path
import json
import logging

from ..config import get_settings
from ..lib.models_validation import (
    ValidateRequest,
    ValidateResponse,
    ValidationErrorModel,
    AutocompleteDataRequest,
    AutocompleteDataResponse
)
from ..lib.schema_validator import validate, extract_schema_locations, get_schema_cache_info, ValidationError
from ..lib.autocomplete_generator import generate_autocomplete_map

# For internet connectivity check
from ..lib.server_utils import has_internet

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/validate", tags=["validation"])


@router.post("", response_model=ValidateResponse)
def validate_xml(
    request: ValidateRequest,
    settings=Depends(get_settings)
) -> ValidateResponse:
    """
    Validate XML document against embedded schema references.

    Supports both XSD (xsi:schemaLocation) and RelaxNG (xml-model) schemas.
    Automatically downloads and caches schemas on first use.
    Uses subprocess isolation for timeout protection on complex schemas.

    Returns:
        List of validation errors. Empty list if validation passed.
    """
    try:
        # Determine cache root - use data_root/schema/cache
        cache_root = settings.data_root / "schema" / "cache"

        # Perform validation using framework-agnostic library
        errors = validate(request.xml_string, cache_root=cache_root)

        # Convert to Pydantic models
        error_models = [
            ValidationErrorModel(
                message=err["message"],
                line=err["line"],
                column=err["column"],
                severity=err.get("severity")
            )
            for err in errors
        ]

        return ValidateResponse(errors=error_models)

    except ValidationError as e:
        logger.error(f"Validation error: {e}")
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error(f"Unexpected error during validation: {e}")
        raise HTTPException(status_code=500, detail=f"Validation failed: {str(e)}")


@router.post("/autocomplete-data", response_model=AutocompleteDataResponse)
def generate_autocomplete_data(
    request: AutocompleteDataRequest,
    settings=Depends(get_settings)
) -> AutocompleteDataResponse:
    """
    Generate CodeMirror autocomplete data from the schema associated with an XML document.

    Only supports RelaxNG schemas. The schema is extracted from the XML document's
    schema reference (xml-model processing instruction or xsi:schemaLocation).

    If invalidate_cache is True, requires internet connectivity to re-download the schema.

    Returns:
        JSON autocomplete data suitable for CodeMirror XML mode.
    """
    try:
        # Check internet connectivity if cache invalidation is requested
        if request.invalidate_cache:
            if not has_internet():
                raise HTTPException(
                    status_code=503,
                    detail="Cannot invalidate cache without internet connection. Schema re-download requires network access."
                )

        # Get the schema locations from the XML
        schema_locations = extract_schema_locations(request.xml_string)
        if not schema_locations:
            logger.debug('No schema location found in XML, cannot generate autocomplete data.')
            raise HTTPException(
                status_code=400,
                detail="No schema location found in XML document"
            )

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
            raise HTTPException(
                status_code=400,
                detail=f"Schema location must start with 'http': {schema_location}"
            )

        logger.debug(
            f"Generating autocomplete data for namespace {namespace} "
            f"with {schema_type} schema at {schema_location}"
        )

        # Get cache information
        cache_root = settings.data_root / "schema" / "cache"
        schema_cache_dir, schema_cache_file, _ = get_schema_cache_info(schema_location, cache_root)
        autocomplete_cache_file = schema_cache_dir / 'codemirror-autocomplete.json'

        # Check if autocomplete data is already cached
        if autocomplete_cache_file.is_file() and not request.invalidate_cache:
            logger.debug(f"Using cached autocomplete data at {autocomplete_cache_file}")
            with open(autocomplete_cache_file, 'r', encoding='utf-8') as f:
                autocomplete_data = json.load(f)
                return AutocompleteDataResponse(data=autocomplete_data)

        # Download schema if it doesn't exist
        # Note: invalidate_cache only affects autocomplete data cache, not the schema itself
        if not schema_cache_file.is_file():
            from ..lib.schema_validator import download_schema_file
            download_schema_file(schema_location, schema_cache_dir, schema_cache_file)
        else:
            logger.debug(f"Using cached schema at {schema_cache_file}")

        # Parse schema to determine type
        from lxml import etree
        try:
            schema_tree = etree.parse(str(schema_cache_file))
            root_namespace = schema_tree.getroot().tag.split('}')[0][1:]
        except Exception as e:
            raise HTTPException(
                status_code=500,
                detail=f"Failed to parse schema file: {str(e)}"
            )

        # Only generate autocomplete data for RelaxNG schemas
        RELAXNG_NAMESPACE = "http://relaxng.org/ns/structure/1.0"
        if root_namespace != RELAXNG_NAMESPACE:
            raise HTTPException(
                status_code=400,
                detail=f"Autocomplete generation only supported for RelaxNG schemas. Found: {root_namespace}"
            )

        # Generate autocomplete data using the RelaxNG converter
        try:
            logger.debug(f"Generating autocomplete data from RelaxNG schema: {schema_cache_file}")
            autocomplete_data = generate_autocomplete_map(
                str(schema_cache_file),
                include_global_attrs=True,
                sort_alphabetically=True,
                deduplicate=True
            )

            # Cache the generated data
            schema_cache_dir.mkdir(parents=True, exist_ok=True)
            with open(autocomplete_cache_file, 'w', encoding='utf-8') as f:
                json.dump(autocomplete_data, f, indent=2, ensure_ascii=False)

            logger.debug(f"Cached autocomplete data to {autocomplete_cache_file}")
            return AutocompleteDataResponse(data=autocomplete_data)

        except Exception as e:
            raise HTTPException(
                status_code=500,
                detail=f"Failed to generate autocomplete data: {str(e)}"
            )

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Unexpected error generating autocomplete data: {e}")
        raise HTTPException(
            status_code=500,
            detail=f"Failed to generate autocomplete data: {str(e)}"
        )
