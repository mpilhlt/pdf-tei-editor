"""
Rule-excerpt gathering and review orchestration for the annotation-review
backend plugin.

See docs/superpowers/specs/2026-09-24-llm-annotation-review-design.md
(Part C) for the design rationale.
"""

import asyncio
import ipaddress
import logging
import re
import socket
from urllib.parse import urlparse

from lxml import etree

from fastapi_app.lib.core.url_cache import UrlCache
from fastapi_app.lib.llm import LLMProvider
from fastapi_app.lib.utils.annotation_rules_utils import (
    extract_annotation_rule_refs,
    fetch_rule_excerpt,
)

from .chunking import split_into_chunks
from .prompts import (
    Finding,
    build_system_prompt,
    build_user_prompt,
    parse_and_validate_findings,
)

logger = logging.getLogger(__name__)

TEI_NS = "http://www.tei-c.org/ns/1.0"

_TEXT_ELEMENT_RE = re.compile(r"<text\b[^>]*>.*</text\s*>", re.DOTALL)


class NoRuleExcerptsError(Exception):
    """Raised when no rule excerpt could be resolved for any category — nothing to review against."""


def _is_safe_fetch_url(url: str) -> bool:
    """
    Reject rule-ref URLs that could be used for SSRF: only plain http/https
    is allowed, and the resolved host must be a globally routable address
    (rejects private, loopback, link-local, multicast, reserved,
    unspecified, and CGNAT/RFC 6598 space). Fails closed - any parse or
    DNS-resolution error is treated as unsafe.

    This check exists here (not in annotation_rules_utils.py) because this
    plugin is the first caller that resolves a URL taken directly from
    client-supplied XML rather than from server config or a write-time-pinned
    ref - see docs/superpowers/specs/2026-09-24-llm-annotation-review-design.md
    (Part C) for context; other callers of fetch_rule_excerpt/resolve_forge_permalink
    have a different, lower-risk trust model and are out of scope for this check.

    Known residual risk (accepted, not fixed here): this validates the
    hostname's resolved IP at check time, not at actual connect time - a
    DNS-rebinding attacker (a very short TTL record that resolves
    differently a moment later) could still bypass this. Closing that
    fully would require connect-time IP pinning (a custom transport
    adapter), which is disproportionate effort while this plugin has no
    UI trigger yet (see docs/superpowers/specs/2026-09-24-llm-annotation-review-design.md,
    Parts D/E, not yet built).
    """
    try:
        parsed = urlparse(url)
    except ValueError:
        return False

    if parsed.scheme not in ("http", "https"):
        return False
    if not parsed.hostname:
        return False

    try:
        addr_info = socket.getaddrinfo(parsed.hostname, None)
    except (socket.gaierror, UnicodeError, ValueError):
        return False

    for _family, _, _, _, sockaddr in addr_info:
        ip = ipaddress.ip_address(sockaddr[0])
        if not ip.is_global:
            return False

    return True


def extract_text_content(xml_string: str) -> str:
    """
    Return the raw <text>...</text> substring of a TEI document, exactly as
    it appears in the original string (not re-serialized) - preserves quote
    style, entity encoding, and whitespace exactly, since Part E will later
    re-match each finding's "old" against the live editor's raw text and
    silently drop anything that doesn't match byte-for-byte.

    Raises:
        ValueError: if the document is not well-formed XML, or has no
            <text> element.
    """
    try:
        root = etree.fromstring(xml_string.encode("utf-8"))
    except etree.XMLSyntaxError as e:
        raise ValueError(f"Document is not well-formed XML: {e}") from e

    text_el = root.find(f".//{{{TEI_NS}}}text")
    if text_el is None:
        raise ValueError("Document has no <text> element")

    match = _TEXT_ELEMENT_RE.search(xml_string)
    if match is None:
        # Degenerate case the regex isn't built for (e.g. self-closing <text/>) -
        # fall back to the serialized form rather than crashing.
        return etree.tostring(text_el, encoding="unicode", xml_declaration=False)
    return match.group(0)


def gather_rule_excerpts(xml_string: str, cache: UrlCache) -> list[tuple[str, str]]:
    """
    Resolve one rule excerpt per editorialDecl category, using each
    category's "machine"-subtype ref. A category with no machine ref, or
    whose excerpt fails to fetch, is skipped (logged), not raised.
    """
    excerpts: list[tuple[str, str]] = []
    for rule_ref in extract_annotation_rule_refs(xml_string):
        machine_ref = next((r for r in rule_ref["refs"] if r["subtype"] == "machine"), None)
        if machine_ref is None:
            continue
        if not _is_safe_fetch_url(machine_ref["target"]):
            logger.warning(
                f"annotation-review: skipping rule category '{rule_ref['category']}' "
                f"- unsafe fetch target: {machine_ref['target']!r}"
            )
            continue
        try:
            excerpt = fetch_rule_excerpt(machine_ref["target"], cache, allow_redirects=False)
        except Exception as e:  # noqa: BLE001 - any fetch failure for one category is skip-worthy, not fatal
            logger.warning(
                f"annotation-review: skipping rule category '{rule_ref['category']}' "
                f"- could not fetch excerpt from {machine_ref['target']}: {e}"
            )
            continue
        excerpts.append((rule_ref["category"], excerpt))
    return excerpts


def count_chunks(xml_string: str) -> int:
    """
    Number of chunks the document's <text> is reviewed in.

    Raises:
        ValueError: document is malformed or has no <text> element.
    """
    return len(split_into_chunks(extract_text_content(xml_string)))


async def run_review(
    xml_string: str,
    provider: LLMProvider,
    model_id: str,
    cache: UrlCache,
    chunk_index: int = 0,
) -> tuple[list[Finding], int]:
    """
    Review one chunk of the document's <text>: gather rule excerpts, build the
    prompt, call the LLM, and return (validated findings, total chunk count).
    Findings are validated against the whole <text>, so "old" must be unique
    in the document, not just in the chunk.

    Raises:
        ValueError: document is malformed, has no <text> element, or chunk_index is out of range.
        NoRuleExcerptsError: no rule excerpt could be resolved for any category.
    """
    text_content = extract_text_content(xml_string)
    chunks = split_into_chunks(text_content)
    if not 0 <= chunk_index < len(chunks):
        raise ValueError(f"chunk_index {chunk_index} out of range (document has {len(chunks)} chunks)")
    rule_excerpts = await asyncio.to_thread(gather_rule_excerpts, xml_string, cache)
    if not rule_excerpts:
        raise NoRuleExcerptsError("No rule excerpts could be resolved for this document")

    system_prompt = build_system_prompt()
    user_prompt = build_user_prompt(rule_excerpts, chunks[chunk_index], (chunk_index + 1, len(chunks)))
    raw_response = await provider.chat_completion(model_id, system_prompt, user_prompt)
    return parse_and_validate_findings(raw_response, text_content), len(chunks)
