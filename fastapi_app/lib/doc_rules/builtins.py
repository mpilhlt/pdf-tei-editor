"""Registers the two resource kinds core ships: interpretation-ref and schema."""

from fastapi_app.lib.doc_rules.interpretation_ref_kind import InterpretationRefKind
from fastapi_app.lib.doc_rules.kinds import ResourceKindRegistry
from fastapi_app.lib.doc_rules.schema_kind import SchemaKind


def register_builtin_kinds(registry: ResourceKindRegistry) -> None:
    """Called once, lazily, by ResourceKindRegistry.get_instance() on first access."""
    registry.register(InterpretationRefKind())
    registry.register(SchemaKind())
