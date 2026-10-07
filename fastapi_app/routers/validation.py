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
from ..lib.core.dependencies import require_authenticated_user, get_document_rules_store
from ..lib.models.models_validation import (
    ValidateRequest,
    ValidateResponse,
    ValidationErrorModel,
    AutocompleteDataRequest,
    AutocompleteDataResponse
)
from ..lib.core.schema_validator import validate, extract_schema_locations, get_schema_cache_info, ValidationError
from ..lib.doc_rules.schema_override import build_schema_text_override
from ..lib.doc_rules.storage import DocumentRulesStore
from ..lib.utils.autocomplete_generator import generate_autocomplete_map

# For internet connectivity check
from ..lib.utils.server_utils import has_internet

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/validate", tags=["validation"])


def resolve_document_schema_cache_file(xml_string: str, cache_root: Path, invalidate_cache: bool) -> Path:
    """
    Resolve "the schema that governs this document" to its locally cached
    RelaxNG file path, downloading it first if needed. Shared by
    /autocomplete-data and /teiheader-structure - both need exactly this
    resolution (schema location from the XML, RelaxNG preferred, cache
    lookup, download-if-missing/invalidated).

    Raises HTTPException(400) if no schema location is found, or the
    location doesn't start with "http"; HTTPException(503) if invalidation
    was requested without internet; HTTPException(404) if the schema
    download 404s.
    """
    if invalidate_cache and not has_internet():
        raise HTTPException(
            status_code=503,
            detail="Cannot invalidate cache without internet connection. Schema re-download requires network access."
        )

    schema_locations = extract_schema_locations(xml_string)
    if not schema_locations:
        logger.debug('No schema location found in XML, cannot resolve document schema.')
        raise HTTPException(status_code=400, detail="No schema location found in XML document")

    schema_info = next((sl for sl in schema_locations if sl.get('type') == 'relaxng'), schema_locations[0])
    schema_location = schema_info['schemaLocation']
    if not schema_location.startswith("http"):
        raise HTTPException(status_code=400, detail=f"Schema location must start with 'http': {schema_location}")

    schema_cache_dir, schema_cache_file, _ = get_schema_cache_info(schema_location, cache_root)

    if not schema_cache_file.is_file() or invalidate_cache:
        from ..lib.core.schema_validator import download_schema_file
        try:
            download_schema_file(schema_location, schema_cache_dir, schema_cache_file)
        except Exception as e:
            if "404" in str(e) or "Not Found" in str(e):
                raise HTTPException(status_code=404, detail=f"Schema not found: {schema_location}")
            raise
    else:
        logger.debug(f"Using cached schema at {schema_cache_file}")

    return schema_cache_file


@router.post("", response_model=ValidateResponse)
def validate_xml(
    request: ValidateRequest,
    settings=Depends(get_settings),
    # Any authenticated user, not reviewer/admin: a schema override only ever
    # affects the calling user's own validation (see build_schema_text_override
    # / DocumentRulesStore's owner-scoped lookups) - unlike the separate,
    # reviewer/admin-gated "Refresh document rules" action described in the
    # same design spec. Don't role-gate this to match that sibling feature.
    user: dict = Depends(require_authenticated_user),
    store: DocumentRulesStore = Depends(get_document_rules_store),
) -> ValidateResponse:
    """
    Validate XML document against embedded schema references.

    Supports both XSD (xsi:schemaLocation) and RelaxNG (xml-model) schemas.
    Automatically downloads and caches schemas on first use.
    Uses subprocess isolation for timeout protection on complex schemas.
    If the caller has selected a schema override via the document rules
    registry, validates against that instead of the shared cached schema.

    Returns:
        List of validation errors. Empty list if validation passed.
    """
    try:
        schema_text_override = build_schema_text_override(request.xml_string, store, user["username"])

        # Perform validation using framework-agnostic library
        errors = validate(
            request.xml_string,
            cache_root=settings.schema_cache_dir,
            schema_text_override=schema_text_override,
        )

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
        if "404" not in str(e) and "Not Found" not in str(e):
            logger.error(f"Validation error: {e}")
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        # Also catches a build_schema_text_override() failure (e.g. a
        # document-rules DB error) - folded into the same generic handler
        # deliberately rather than a separate except clause, but note for
        # debugging that "Validation failed" can mean the rules lookup
        # failed, not necessarily the schema validation itself.
        logger.error(f"Unexpected error during validation: {e}")
        raise HTTPException(status_code=500, detail=f"Validation failed: {str(e)}")


@router.post("/autocomplete-data", response_model=AutocompleteDataResponse)
def generate_autocomplete_data(
    request: AutocompleteDataRequest,
    settings=Depends(get_settings),
    user: dict = Depends(require_authenticated_user)
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
        schema_cache_file = resolve_document_schema_cache_file(
            request.xml_string, settings.schema_cache_dir, request.invalidate_cache
        )
        schema_cache_dir = schema_cache_file.parent
        autocomplete_cache_file = schema_cache_dir / 'codemirror-autocomplete.json'

        if autocomplete_cache_file.is_file() and not request.invalidate_cache:
            logger.debug(f"Using cached autocomplete data at {autocomplete_cache_file}")
            with open(autocomplete_cache_file, 'r', encoding='utf-8') as f:
                autocomplete_data = json.load(f)
                return AutocompleteDataResponse(data=autocomplete_data)

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
