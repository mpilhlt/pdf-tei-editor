"""
Registry mapping a document's extractor identity to the plugin that can
regenerate its document rules (interpretation-ref editorialDecl entries and
schema PI). See
docs/superpowers/specs/2026-09-27-document-rules-registry-design.md
("Refreshing document rules").

Provenance is read from encodingDesc/appInfo/application[@type="extractor"]
- the oldest, most stable per-document record this app writes (see
docs/development/tei-header-integrations.md), present even on documents
extracted before editorialDecl or this feature existed. Extractor plugins
register one DocumentRulesProvider each, keyed by their own @ident, at
plugin initialize() time.
"""

from typing import Optional, Protocol

from lxml import etree

from fastapi_app.lib.core.url_cache import UrlCache
from fastapi_app.lib.utils.annotation_rules_utils import AnnotationRuleRef

TEI_NS = "http://www.tei-c.org/ns/1.0"


class DocumentRulesProvider(Protocol):
    """What an extractor plugin implements to support "Refresh document rules"."""

    def build_editorial_decl_entries(self, variant_id: str, cache: UrlCache) -> list[AnnotationRuleRef]:
        """Current interpretation-ref entries for variant_id. Return [] if this extractor has none."""
        ...

    def get_schema_url(self, variant_id: str) -> Optional[str]:
        """Current schema URL for variant_id, or None if this extractor has no schema mapping."""
        ...


_registry: dict[str, tuple[str, DocumentRulesProvider]] = {}


def register_document_rules_provider(extractor_ident: str, plugin_id: str, provider: DocumentRulesProvider) -> None:
    """Register (or replace) the provider for one extractor @ident."""
    _registry[extractor_ident] = (plugin_id, provider)


def unregister_document_rules_provider(extractor_ident: str) -> None:
    """Remove a previously registered provider, if any. No-op if none is registered."""
    _registry.pop(extractor_ident, None)


def extract_extractor_provenance(tei_content: str) -> Optional[tuple[str, str]]:
    """
    Read (extractor @ident, variant-id label) from a TEI document's
    encodingDesc/appInfo/application[@type="extractor"].

    Returns None if the document isn't parseable (even leniently), has no
    such application element, or either value is missing/empty - all
    treated as "nothing to dispatch a refresh to" by callers, not raised.
    """
    parser = etree.XMLParser(recover=True)
    try:
        root = etree.fromstring(tei_content.encode("utf-8"), parser)
    except etree.XMLSyntaxError:
        return None

    ns = {"tei": TEI_NS}
    app = root.find(".//tei:encodingDesc/tei:appInfo/tei:application[@type='extractor']", ns)
    if app is None:
        return None

    ident = app.get("ident")

    variant_el = app.find("tei:label[@type='variant-id']", ns)
    variant_id = variant_el.text if variant_el is not None else None

    if not ident or not variant_id:
        return None
    return ident, variant_id


def get_document_rules_provider_for_document(xml_string: str) -> Optional[tuple[str, DocumentRulesProvider]]:
    """
    Resolve the DocumentRulesProvider that can refresh this document's rules.

    Reads the document's extractor @ident and variant-id and looks up a
    provider registered for that ident. Returns (variant_id, provider) -
    variant_id is what a caller needs to actually invoke the provider's
    methods. Returns None both when the document has no readable extractor
    provenance and when no provider is registered for its ident - to a
    caller these are the same "nothing to refresh" outcome (see
    rules_refresh.py's "No rule-refresh provider ..." message).
    """
    provenance = extract_extractor_provenance(xml_string)
    if provenance is None:
        return None
    ident, variant_id = provenance
    entry = _registry.get(ident)
    if entry is None:
        return None
    _plugin_id, provider = entry
    return variant_id, provider
