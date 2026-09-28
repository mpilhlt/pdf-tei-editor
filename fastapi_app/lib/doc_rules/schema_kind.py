"""
The "schema" resource kind: the RelaxNG schema referenced by a document's
<?xml-model?> PI or schemaRef. See
docs/superpowers/specs/2026-09-27-document-rules-registry-design.md
("Schema validation integration"). XSD is out of scope for v1 (deferred):
a multi-file XSD has no single "original text" to present as one
editable resource.
"""

from fastapi_app.config import get_settings
from fastapi_app.lib.core.schema_validator import (
    download_schema_file,
    extract_schema_locations,
    get_schema_cache_info,
    is_schema_cache_stale,
    resolve_schema_location,
)
from fastapi_app.lib.doc_rules.kinds import ResourceDescriptor, ResourceKind
from fastapi_app.lib.doc_rules.resource_key import infer_format, normalize_resource_key


class SchemaKind(ResourceKind):
    name = "schema"

    def discover(self, xml_string: str) -> list[ResourceDescriptor]:
        descriptors: list[ResourceDescriptor] = []
        for location in extract_schema_locations(xml_string):
            if location["type"] != "relaxng":
                continue
            url = location["schemaLocation"]
            descriptors.append(ResourceDescriptor(
                kind=self.name,
                url=url,
                key=normalize_resource_key(url),
                label="Schema (RelaxNG)",
                format=infer_format(url),
            ))
        return descriptors

    def resolve_original(self, url: str) -> str:
        settings = get_settings()
        location = resolve_schema_location(url)
        cache_dir, cache_file, _ = get_schema_cache_info(location, settings.schema_cache_dir)
        if is_schema_cache_stale(cache_file):
            download_schema_file(location, cache_dir, cache_file)
        return cache_file.read_text(encoding="utf-8")
