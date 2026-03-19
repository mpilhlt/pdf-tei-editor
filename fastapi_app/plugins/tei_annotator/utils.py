"""
Text-processing helpers and webservice call utility for the tei-annotator plugin.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

import requests
from lxml import etree

from fastapi_app.lib.utils.config_utils import get_config
from fastapi_app.plugins.tei_annotator.config import LB_PLACEHOLDER, TEI_NS

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Text-processing helpers
# ---------------------------------------------------------------------------

def bibl_to_plain_text(bibl_el: etree._Element) -> str:
    """
    Extract plain text from a <bibl> element, replacing <lb/> with LB_PLACEHOLDER.

    All annotation child elements (author, title, etc.) are stripped; only their
    text content is preserved.
    """
    return _collect_text(bibl_el, strip_bibl=False)


def element_to_plain_text_with_lb(el: etree._Element) -> str:
    """
    Extract plain text from any element, replacing <lb/> with LB_PLACEHOLDER
    and stripping <bibl> wrapper tags along with all other annotation elements.
    """
    return _collect_text(el, strip_bibl=True)


def restore_lb(xml_fragment: str) -> str:
    """Replace LB_PLACEHOLDER occurrences with <lb/> in an XML fragment string."""
    return xml_fragment.replace(LB_PLACEHOLDER, "<lb/>")


def _collect_text(el: etree._Element, strip_bibl: bool) -> str:
    """
    Recursively collect text content of *el*, converting lb elements to the
    placeholder and stripping all other element wrappers.
    """
    parts: list[str] = []

    def _visit(node: etree._Element) -> None:
        if node.text:
            parts.append(node.text)
        for child in node:
            local = etree.QName(child.tag).localname if isinstance(child.tag, str) else None
            if local == "lb":
                parts.append(LB_PLACEHOLDER)
            elif local == "bibl" and strip_bibl:
                _visit(child)
            else:
                _visit(child)
            if child.tail:
                parts.append(child.tail)

    if el.text:
        parts.append(el.text)
    for child in el:
        local = etree.QName(child.tag).localname if isinstance(child.tag, str) else None
        if local == "lb":
            parts.append(LB_PLACEHOLDER)
        else:
            _visit(child)
        if child.tail:
            parts.append(child.tail)

    return "".join(parts)


# ---------------------------------------------------------------------------
# Webservice call
# ---------------------------------------------------------------------------

async def call_annotate(
    *,
    text: str,
    schema: dict[str, Any],
    provider: str,
    model: str,
) -> dict[str, Any]:
    """
    POST a single text to the TEI Annotator webservice (/api/annotate).

    Returns the first response dict (keys: "xml", "fuzzy_spans", "elapsed_seconds"),
    or an empty dict if the service returns no results.

    Raises RuntimeError if the server URL is not configured.
    """
    config = get_config()
    server_url = config.get("tei-annotator.server.url")
    if not server_url:
        raise RuntimeError("tei-annotator.server.url is not configured")

    url = f"{server_url.rstrip('/')}/api/annotate"
    api_key = config.get("tei-annotator.server.api-key")
    headers: dict[str, str] = {}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"

    body: dict[str, Any] = {
        "provider": provider,
        "model": model,
        "schema": schema,
        "text": text,
    }

    # Log request details for debugging
    logger.debug(
        "TEI Annotator request to %s: provider=%s, model=%s, text_length=%d, schema_keys=%s",
        url,
        provider,
        model,
        len(text),
        list(schema.keys()) if isinstance(schema, dict) else type(schema).__name__,
    )

    def _do_post() -> list[dict[str, Any]]:
        resp = requests.post(url, json=body, headers=headers, timeout=300)
        try:
            resp.raise_for_status()
        except requests.exceptions.HTTPError as exc:
            # Log the response body for debugging 422 errors
            logger.error(
                "TEI Annotator API error %s for %s. Response body: %s",
                resp.status_code,
                url,
                resp.text[:1000] if resp.text else "(empty)",
            )
            raise
        data = resp.json()
        return data if isinstance(data, list) else [data]

    results = await asyncio.to_thread(_do_post)
    return results[0] if results else {}
