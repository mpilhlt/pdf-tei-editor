"""
Document rules registry: a pluggable resource-kind registry plus generic
override/selection storage for the resources a TEI document references
(interpretation-ref prompt/rule fragments and its schema). See
docs/superpowers/specs/2026-09-27-document-rules-registry-design.md.
"""

from fastapi_app.lib.doc_rules.kinds import (
    ResourceDescriptor,
    ResourceKind,
    get_resource_kind,
    list_resources,
    register_resource_kind,
)
from fastapi_app.lib.doc_rules.resource_key import infer_format, normalize_resource_key
from fastapi_app.lib.doc_rules.storage import DocumentRulesStore

__all__ = [
    "ResourceDescriptor",
    "ResourceKind",
    "register_resource_kind",
    "get_resource_kind",
    "list_resources",
    "normalize_resource_key",
    "infer_format",
    "DocumentRulesStore",
]
