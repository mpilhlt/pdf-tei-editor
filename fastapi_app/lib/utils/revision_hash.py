"""
Revision hash chain for the document history (see docs/history/2026-10-24-version-freeze.md).

Each `teiHeader/revisionDesc/change` records, in its `@xml:id`, a hash of the canonical content
of `TEI/text` at the time of the revision, chained with the hash of the previous change:
`h(n) = sha256(h(n-1) + "\\n" + canon(text))`, truncated to 16 hex characters, written as
`h-<hash>`. `teiHeader` and `standOff` are not hashed, since they change after a revision for
legitimate reasons (reviews, comments, respStmt).

The server stamps the hashes when a file is saved, so there is a single implementation. A change
is stamped only when it is new, that is, not present in the file it replaces or was copied from
(compared by `who`, `when` and `status`), and only if it is the last change. Older changes
without a hash stay unstamped: their text state cannot be reconstructed.
"""

import hashlib
import re
from typing import Optional

from lxml import etree

from fastapi_app.lib.utils.tei_utils import get_header_changes
from fastapi_app.lib.utils.xml_utils import parse_untrusted_xml

TEI_NS = "http://www.tei-c.org/ns/1.0"
XML_ID = "{http://www.w3.org/XML/1998/namespace}id"
HASH_PREFIX = "h-"
HASH_LENGTH = 16

ChangeSignature = tuple[str, str, str]


def canonical_text(root: etree._Element) -> bytes:  # type: ignore[name-defined]
    """
    Return the canonical form of `TEI/text`: C14N without comments, with whitespace runs
    collapsed and whitespace next to tags removed, so that re-indenting or re-wrapping is no
    change (at the price of not noticing a changed space next to an inline element).

    Args:
        root: TEI root element

    Returns:
        Canonical bytes, empty if the document has no `text` element
    """
    text = root.find(f"{{{TEI_NS}}}text")
    if text is None:
        return b""
    canon = etree.tostring(text, method="c14n", with_comments=False)
    canon = re.sub(rb"\s+", b" ", canon)
    # whitespace runs are single spaces now
    return re.sub(rb" ?([<>]) ?", rb"\1", canon).strip()


def chain_hash(previous: str, canon: bytes) -> str:
    """
    Compute the hash of a revision from the previous revision's hash and the canonical text.

    Args:
        previous: Hash of the previous change (without prefix), empty for the first
        canon: Canonical text from canonical_text()

    Returns:
        16 hex characters
    """
    return hashlib.sha256(previous.encode("ascii") + b"\n" + canon).hexdigest()[:HASH_LENGTH]


def revision_hash(change: etree._Element) -> Optional[str]:  # type: ignore[name-defined]
    """
    Return the hash recorded in a change element, or None if it has none.

    Args:
        change: A `teiHeader/revisionDesc/change` element

    Returns:
        The hash without prefix, or None
    """
    value = change.get(XML_ID) or ""
    return value[len(HASH_PREFIX):] if value.startswith(HASH_PREFIX) else None


def _signature(change: etree._Element) -> ChangeSignature:  # type: ignore[name-defined]
    return (change.get("who", ""), change.get("when", ""), change.get("status", ""))


def _insert_ids(xml_string: str, ids: dict[int, str], count: int) -> Optional[str]:
    """
    Insert `xml:id` attributes into the n-th change start tags of the header's revisionDesc,
    leaving the rest of the document byte for byte as it is.

    Returns None if the start tags cannot be located unambiguously (their number differs from
    `count`, e.g. with `listChange`).
    """
    header = re.search(r"<(?:[\w.-]+:)?teiHeader\b.*?</(?:[\w.-]+:)?teiHeader\s*>", xml_string, re.S)
    if not header:
        return None
    revision_desc = re.search(r"<(?:[\w.-]+:)?revisionDesc\b.*?</(?:[\w.-]+:)?revisionDesc\s*>", header.group(0), re.S)
    if not revision_desc:
        return None
    offset = header.start() + revision_desc.start()
    region = revision_desc.group(0)
    starts = [m.end() for m in re.finditer(r"<(?:[\w.-]+:)?change(?=[\s/>])", region)]
    if len(starts) != count:
        return None
    result = xml_string
    for index in sorted(ids, reverse=True):
        position = offset + starts[index]
        result = f'{result[:position]} xml:id="{ids[index]}"{result[position:]}'
    return result


def stamp_revision_hashes(xml_string: str, reference_xml: Optional[str] = None) -> str:
    """
    Add revision hashes to the header changes of a TEI document that is about to be saved.

    Changes that have a hash in the reference document (the stored file being replaced, or the
    source of a new version) get that hash back, since the editor's copy may not have it yet.
    The last change gets a new hash if it is not in the reference.

    Args:
        xml_string: TEI document to be saved
        reference_xml: The stored file being replaced or the source file of a new version

    Returns:
        The document with the hashes added, or unchanged if there is nothing to add or the
        changes cannot be located in the source text
    """
    try:
        root = parse_untrusted_xml(xml_string)
    except etree.XMLSyntaxError:
        return xml_string
    changes = get_header_changes(root)
    if not changes:
        return xml_string

    known: dict[ChangeSignature, str] = {}
    reference_signatures: set[ChangeSignature] = set()
    if reference_xml:
        try:
            reference_root = parse_untrusted_xml(reference_xml)
            for change in get_header_changes(reference_root):
                signature = _signature(change)
                reference_signatures.add(signature)
                value = change.get(XML_ID)
                if value and value.startswith(HASH_PREFIX):
                    known[signature] = value
        except etree.XMLSyntaxError:
            pass

    used_ids = {value for value in root.xpath("//@xml:id")}
    ids: dict[int, str] = {}
    previous = ""
    last = len(changes) - 1
    for index, change in enumerate(changes):
        existing = revision_hash(change)
        if existing is not None:
            previous = existing
            continue
        if change.get(XML_ID):
            continue
        signature = _signature(change)
        value = known.get(signature)
        if value is None and index == last and signature not in reference_signatures:
            value = HASH_PREFIX + chain_hash(previous, canonical_text(root))
        if value is None or value in used_ids:
            continue
        ids[index] = value
        used_ids.add(value)
        previous = value[len(HASH_PREFIX):]

    if not ids:
        return xml_string
    return _insert_ids(xml_string, ids, len(changes)) or xml_string


def head_hash(root: etree._Element) -> Optional[str]:  # type: ignore[name-defined]
    """
    Return the hash of the last header change, or None if it has none.

    Args:
        root: TEI root element

    Returns:
        The hash without prefix, or None
    """
    changes = get_header_changes(root)
    return revision_hash(changes[-1]) if changes else None


def has_unrevised_edits(root: etree._Element) -> Optional[bool]:  # type: ignore[name-defined]
    """
    Check whether the text changed since the last revision.

    Args:
        root: TEI root element

    Returns:
        True or False, or None if the last change has no hash to compare with
    """
    changes = get_header_changes(root)
    if not changes:
        return None
    current = revision_hash(changes[-1])
    if current is None:
        return None
    previous = ""
    for change in reversed(changes[:-1]):
        value = revision_hash(change)
        if value is not None:
            previous = value
            break
    return chain_hash(previous, canonical_text(root)) != current
