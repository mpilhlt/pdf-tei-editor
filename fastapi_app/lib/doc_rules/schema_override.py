"""
Bridges the document rules registry's per-user schema overrides into
schema_validator.validate()'s schema_text_override seam. See
docs/superpowers/specs/2026-09-27-document-rules-registry-design.md
("Schema validation integration").
"""

from fastapi_app.lib.core.schema_validator import extract_schema_locations, resolve_schema_location
from fastapi_app.lib.doc_rules.resource_key import normalize_resource_key
from fastapi_app.lib.doc_rules.storage import DocumentRulesStore


def build_schema_text_override(xml_string: str, store: DocumentRulesStore, owner: str) -> dict[str, str]:
    """
    For each RelaxNG schema location the document declares, look up
    `owner`'s selected override (if any) and return a dict keyed by the
    *resolved* schema location - matching how validate() itself resolves
    redirects before looking up this dict - so validate() reads a
    per-user override instead of the shared schema cache for that
    location. A resource's override is looked up by the raw (pre-redirect)
    URL's normalized key, matching how it was created/selected via
    /api/v1/document-rules and how SchemaKind.discover() keys it; only the
    dict's own keys are re-expressed in resolved form for validate()'s
    benefit. Locations with no selection, and non-RelaxNG locations (XSD
    is out of scope for v1 - see the design spec's Deferred section), are
    omitted entirely.
    """
    overrides: dict[str, str] = {}
    for location in extract_schema_locations(xml_string):
        if location["type"] != "relaxng":
            continue
        raw_url = location["schemaLocation"]
        resource_key = normalize_resource_key(raw_url)
        text = store.get_selected_override_text("schema", resource_key, owner)
        if text is not None:
            overrides[resolve_schema_location(raw_url)] = text
    return overrides
