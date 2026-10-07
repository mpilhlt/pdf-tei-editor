"""
XML/TEI validation router for FastAPI.

Provides endpoints for:
- XML schema validation (XSD and RelaxNG)
- CodeMirror autocomplete data generation

For FastAPI migration - Phase 5.
"""

from fastapi import APIRouter, HTTPException, Depends
from pathlib import Path
from typing import Dict, List, Optional, Set, TYPE_CHECKING
import json
import logging

from ..config import get_settings
from ..lib.core.dependencies import require_authenticated_user, get_document_rules_store
from ..lib.models.models_validation import (
    ValidateRequest,
    ValidateResponse,
    ValidationErrorModel,
    AutocompleteDataRequest,
    AutocompleteDataResponse,
    TeiHeaderStructureRequest,
    TeiHeaderStructureResponse
)
from ..lib.core.schema_validator import validate, extract_schema_locations, get_schema_cache_info, ValidationError
from ..lib.doc_rules.schema_override import build_schema_text_override
from ..lib.doc_rules.storage import DocumentRulesStore
from ..lib.utils.autocomplete_generator import generate_autocomplete_map

# For internet connectivity check
from ..lib.utils.server_utils import has_internet

if TYPE_CHECKING:
    from ..lib.utils.relaxng_to_codemirror import RelaxNGParser

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/validate", tags=["validation"])


def _get_core_schema_path(settings) -> Path:
    """
    Path to the bundled core TEI schema (schema/rng/tei-bib.rng), resolved
    via Settings.project_root_dir rather than a Path(__file__) parent chain
    (see fastapi_app/CLAUDE.md's "Use Settings for path resolution" rule).
    """
    return settings.project_root_dir / "schema" / "rng" / "tei-bib.rng"


_core_schema_parser: Optional["RelaxNGParser"] = None


def _get_core_schema_parser(settings) -> "RelaxNGParser":
    """Lazily parse the bundled core TEI schema once per process."""
    global _core_schema_parser
    if _core_schema_parser is None:
        from ..lib.utils.relaxng_to_codemirror import RelaxNGParser
        parser = RelaxNGParser()
        parser.parse_file(str(_get_core_schema_path(settings)))
        _core_schema_parser = parser
    return _core_schema_parser


_core_defs_cache: Optional[Dict[str, Dict]] = None


def _get_core_defs(settings) -> Dict[str, Dict]:
    """
    Lazily BFS-merge the core schema's titleStmt/publicationStmt/sourceDesc
    defs once per process and cache the result: the core schema and these
    roots never change for the process lifetime, so there's no reason to
    pay _collect_merged_defs's cost (163 tags x extract_tag_definitions
    calls) on every request - this is on top of _find_element_definition's
    own O(1) fix in relaxng_to_codemirror.py, not instead of it.
    """
    global _core_defs_cache
    if _core_defs_cache is None:
        _core_defs_cache = _collect_merged_defs(
            _get_core_schema_parser(settings), _TEIHEADER_ROOTS, _TEIHEADER_EXCLUDE
        )
    return _core_defs_cache


def _collect_merged_defs(parser: "RelaxNGParser", roots: List[str], exclude: Set[str], max_depth: int = 6) -> Dict[str, Dict]:
    """
    BFS over RelaxNGParser.extract_tag_definitions(): each call only
    resolves ITS OWN root tag's children one hop deep by name, without
    recursively expanding those child names into their own entries (see
    this function's call site for how this was discovered). Keeps calling
    extract_tag_definitions() on every newly-discovered tag name - each
    such call correctly resolves that tag's own real <element> via
    _find_element_definition(), so its `children` are accurate for ITS
    level - until no new tag names appear or `max_depth` hops is reached.

    `exclude` only keeps extract_tag_definitions() from handing back its
    OWN top-level entry for an excluded name (e.g. respStmt) - it does NOT
    strip that name out of other tags' `children`/`childCardinality`
    (verified empirically: titleStmt's own `children` still lists
    "respStmt" even when excluded). So this also scrubs `exclude` from
    every collected tag's `children` list and `childCardinality` dict
    before it's merged in, so an excluded tag never surfaces anywhere in
    the result, not just as its own entry.
    """
    merged: Dict[str, Dict] = {}
    frontier = list(roots)
    depth = 0
    while frontier and depth < max_depth:
        next_frontier: List[str] = []
        for tag_name in frontier:
            if tag_name in merged or tag_name in exclude:
                continue
            for name, data in parser.extract_tag_definitions(tag_name, exclude=exclude).items():
                if name not in merged:
                    children = [c for c in data.get('children', []) if c not in exclude]
                    child_cardinality = {
                        k: v for k, v in data.get('childCardinality', {}).items() if k not in exclude
                    }
                    data = {**data, 'children': children, 'childCardinality': child_cardinality}
                    merged[name] = data
                    next_frontier.extend(children)
        frontier = next_frontier
        depth += 1
    return merged


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


_TEIHEADER_ROOTS = ["titleStmt", "publicationStmt", "sourceDesc"]
_TEIHEADER_EXCLUDE = {"respStmt"}


@router.post("/teiheader-structure", response_model=TeiHeaderStructureResponse)
def generate_teiheader_structure(
    request: TeiHeaderStructureRequest,
    settings=Depends(get_settings),
    user: dict = Depends(require_authenticated_user)
) -> TeiHeaderStructureResponse:
    """
    Schema-derived field structure for the teiHeader editor's
    titleStmt/publicationStmt/sourceDesc sections, merging the open
    document's own resolved schema with the bundled core TEI schema
    (schema/rng/tei-bib.rng): a tag's description/children/attributes come
    from the document schema where present, else the core schema; a tag
    reachable only in the core schema is included anyway; cardinality
    (required/repeatable) always comes from the core schema, since
    permissive document schemas (e.g. GROBID's training schemas) don't
    reliably encode it. titleStmt/respStmt is always excluded - it's this
    app's own user registry, not bibliographic data.
    """
    from ..lib.utils.relaxng_to_codemirror import RelaxNGParser

    core_defs = _get_core_defs(settings)

    doc_defs: Dict[str, Dict] = {}
    try:
        schema_cache_file = resolve_document_schema_cache_file(
            request.xml_string, settings.schema_cache_dir, invalidate_cache=False
        )
        doc_parser = RelaxNGParser()
        doc_parser.parse_file(str(schema_cache_file))
        doc_defs = _collect_merged_defs(doc_parser, _TEIHEADER_ROOTS, _TEIHEADER_EXCLUDE)
    except HTTPException:
        # No/unreachable document schema - fall back to the core schema
        # alone (see this function's docstring); not a client error.
        pass

    merged: Dict[str, Dict] = {}
    for tag_name, core_def in core_defs.items():
        doc_def = doc_defs.get(tag_name)
        merged[tag_name] = {
            "description": (doc_def or {}).get("description") or core_def.get("description"),
            # doc_def is checked for presence (not truthiness) below: a
            # document schema that legitimately defines an EMPTY
            # children/attributes list for a tag must keep that empty
            # list, not silently fall back to the core schema's value.
            "children": doc_def.get("children", []) if doc_def is not None else core_def.get("children", []),
            "attributes": doc_def.get("attributes", []) if doc_def is not None else core_def.get("attributes", []),
            # Cardinality always from the core schema (product decision).
            "childCardinality": core_def.get("childCardinality", {}),
        }
    # Tags present only in the document schema (not reachable from the core
    # schema's own titleStmt/publicationStmt/sourceDesc closure) are not
    # included - the core schema is authoritative for which tags exist in
    # this editor's scope.

    return TeiHeaderStructureResponse(roots=_TEIHEADER_ROOTS, tags=merged)
