"""
Server-side edits of the unit comments of a TEI file, as text edits that leave the rest of the
file byte for byte as it is:

- `add_reply()`: a reply to a comment thread, written by users who cannot edit the file (see the
  reply endpoint in `fastapi_app/routers/files_comments.py`).
- `merge_foreign_comments()`: when a file is saved over, puts back comments of other users that
  the saved text lacks (a reply that arrived while the owner was editing).

The written markup is the same as `serializeComments()` in `app/src/modules/unit-comments.js`.
"""

from __future__ import annotations

import random
import re
from dataclasses import dataclass

from lxml import etree

from .standoff_reader import (
    COMMENT_LIST_TYPE,
    XML_ID,
    UnitComment,
    child_elements,
    find_standoff_list,
    read_comments,
    resp_persons,
    thread_status,
)
from .store import now_iso

FP_ALGORITHM = "fp-sha256-8-v1"
DEFAULT_INDENT_UNIT = "  "


class ThreadNotFoundError(ValueError):
    """The comment thread does not exist in the file."""


@dataclass
class ReplyResult:
    xml: str
    comment_id: str
    annotation_xml: str


def escape_xml(text: str) -> str:
    """Escapes text for XML content and attribute values."""
    return text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;")


def new_comment_id(existing: set[str]) -> str:
    """A comment id (`uc-` and six base-36 characters) not in use."""
    alphabet = "0123456789abcdefghijklmnopqrstuvwxyz"
    while True:
        comment_id = "uc-" + "".join(random.choice(alphabet) for _ in range(6))
        if comment_id not in existing:
            return comment_id


def _element_span(xml: str, local: str, xml_id: str) -> tuple[int, int]:
    """Start and end offsets of the element with the given local name and `xml:id` (no nesting of the same name)."""
    start_re = re.compile(rf'<(?:[\w.-]+:)?{local}\b[^>]*\bxml:id=(["\']){re.escape(xml_id)}\1[^>]*>')
    start = start_re.search(xml)
    if not start:
        raise ThreadNotFoundError(xml_id)
    if start.group(0).endswith("/>"):
        return start.start(), start.end()
    end = re.compile(rf"</(?:[\w.-]+:)?{local}\s*>").search(xml, start.end())
    if not end:
        raise ThreadNotFoundError(xml_id)
    return start.start(), end.end()


def _indent_at(xml: str, pos: int) -> str:
    """The indentation of the line that contains `pos`."""
    line_start = xml.rfind("\n", 0, pos) + 1
    match = re.match(r"[ \t]*", xml[line_start:])
    return match.group(0) if match else ""


def _indent_unit(xml: str, list_start: int, child_start: int) -> str:
    inner = _indent_at(xml, child_start)
    outer = _indent_at(xml, list_start)
    return inner[len(outer):] if inner.startswith(outer) and len(inner) > len(outer) else DEFAULT_INDENT_UNIT


def serialize_reply(comment_id: str, thread_id: str, author: str, text: str, when: str, indent: str, unit: str) -> str:
    """A reply `annotation` element, starting with `indent` (as written by unit-comments.js)."""
    i2 = indent + unit
    i3 = i2 + unit
    return "\n".join([
        f'{indent}<annotation xml:id="{escape_xml(comment_id)}" motivation="replying" target="#{escape_xml(thread_id)}" resp="#{escape_xml(author)}">',
        f"{i2}<revisionDesc>",
        f'{i3}<change when="{escape_xml(when)}" who="#{escape_xml(author)}"/>',
        f"{i2}</revisionDesc>",
        f'{i2}<note type="comment">{escape_xml(text)}</note>',
        f"{indent}</annotation>",
    ])


def _ensure_resp_stmt(xml: str, root: etree._Element, username: str, fullname: str, resp: str) -> str:  # type: ignore[name-defined]
    """Adds a respStmt for the user at the end of the titleStmt, if none of its persNames has the user's id."""
    for pers in root.iter("{http://www.tei-c.org/ns/1.0}persName"):
        if pers.get(XML_ID) == username and pers.getparent() is not None and etree.QName(pers.getparent()).localname == "respStmt":
            return xml
    close = re.compile(r"</(?:[\w.-]+:)?titleStmt\s*>").search(xml)
    if not close:
        return xml
    indent = _indent_at(xml, close.start())
    open_tag = re.compile(r"<(?:[\w.-]+:)?titleStmt\b[^>]*>").search(xml)
    first_child = re.compile(r"\n([ \t]*)<").search(xml, open_tag.end()) if open_tag else None
    child_indent = first_child.group(1) if first_child and len(first_child.group(1)) > len(indent) else indent + DEFAULT_INDENT_UNIT
    unit = child_indent[len(indent):] or DEFAULT_INDENT_UNIT
    resp_stmt = "\n".join([
        f"{child_indent}<respStmt>",
        f'{child_indent}{unit}<persName xml:id="{escape_xml(username)}">{escape_xml(fullname)}</persName>',
        f"{child_indent}{unit}<resp>{escape_xml(resp)}</resp>",
        f"{child_indent}</respStmt>",
    ])
    line_start = xml.rfind("\n", 0, close.start()) + 1
    if xml[line_start:close.start()].strip() == "":
        return xml[:line_start] + resp_stmt + "\n" + xml[line_start:]
    return xml[:close.start()] + "\n" + resp_stmt + "\n" + indent + xml[close.start():]


def add_reply(xml: str, thread_id: str, author: str, fullname: str, text: str, when: str | None = None) -> ReplyResult:
    """
    Adds a reply after the last comment of a thread; replying to a resolved thread reopens it.
    Adds the author to the respStmts (resp `Commenter`) if missing.

    Raises:
        ThreadNotFoundError: If the file has no thread with this id
    """
    root = etree.fromstring(xml.encode("utf-8"))
    comments = read_comments(find_standoff_list(root, COMMENT_LIST_TYPE))
    thread_root = next((c for c in comments if c.id == thread_id and not c.reply_to), None)
    if thread_root is None:
        raise ThreadNotFoundError(thread_id)
    when = when or now_iso()
    last_id = ([c.id for c in comments if c.reply_to == thread_id] or [thread_id])[-1]
    comment_id = new_comment_id({c.id for c in comments})

    # reopen a resolved thread: a change in the first comment's revisionDesc
    if thread_status(thread_root) == "resolved":
        start, end = _element_span(xml, "annotation", thread_id)
        close = re.compile(r"</(?:[\w.-]+:)?revisionDesc\s*>").search(xml, start, end)
        if close:
            change_indent = _indent_at(xml, close.start()) + DEFAULT_INDENT_UNIT
            for m in re.finditer(r"\n([ \t]*)<(?:[\w.-]+:)?change\b", xml[start:close.start()]):
                change_indent = m.group(1)
            change = f'<change when="{escape_xml(when)}" who="#{escape_xml(author)}" status="open"/>'
            line_start = xml.rfind("\n", 0, close.start()) + 1
            if xml[line_start:close.start()].strip() == "":
                xml = xml[:line_start] + change_indent + change + "\n" + xml[line_start:]
            else:
                xml = xml[:close.start()] + change + xml[close.start():]

    lst = find_standoff_list(root, COMMENT_LIST_TYPE)
    assert lst is not None
    start, end = _element_span(xml, "annotation", last_id)
    indent = _indent_at(xml, start)
    list_match = re.compile(rf'<(?:[\w.-]+:)?listAnnotation\b[^>]*\btype=(["\']){COMMENT_LIST_TYPE}\1').search(xml)
    unit = _indent_unit(xml, list_match.start(), start) if list_match else DEFAULT_INDENT_UNIT
    reply = serialize_reply(comment_id, thread_id, author, text, when, indent, unit)
    xml = xml[:end] + "\n" + reply + xml[end:]

    xml = _ensure_resp_stmt(xml, root, author, fullname or author, "Commenter")
    return ReplyResult(xml=xml, comment_id=comment_id, annotation_xml=reply.strip())


def merge_foreign_comments(stored: str, incoming: str, username: str) -> str:
    """
    Puts back into `incoming` the unit comments of `stored` that `incoming` lacks and that were
    written by somebody other than `username` (users can only delete their own comments, so these
    were added by others while `username` was editing). Each goes after the comment that precedes
    it in `stored`, or at the start of the list. Authors of comments in the result who have a
    respStmt in `stored` but not in `incoming` get it back.

    Args:
        stored: The file as stored
        incoming: The text being saved over it
        username: The saving user

    Returns:
        `incoming`, with the missing comments re-inserted
    """
    try:
        stored_root = etree.fromstring(stored.encode("utf-8"))
        incoming_root = etree.fromstring(incoming.encode("utf-8"))
    except etree.XMLSyntaxError:
        return incoming
    stored_comments = read_comments(find_standoff_list(stored_root, COMMENT_LIST_TYPE))
    incoming_ids = {c.id for c in read_comments(find_standoff_list(incoming_root, COMMENT_LIST_TYPE))}
    deleted_threads = {c.id for c in stored_comments if not c.reply_to and c.id not in incoming_ids and c.author == username}
    missing = [
        c for c in stored_comments
        if c.id not in incoming_ids and c.author != username and (c.reply_to or c.id) not in deleted_threads
    ]
    if missing:
        incoming = _insert_comments(stored, incoming, incoming_root, stored_comments, incoming_ids, missing)
    return _restore_resp_stmts(stored_root, incoming)


def _restore_resp_stmts(stored_root: etree._Element, incoming: str) -> str:  # type: ignore[name-defined]
    """Adds respStmts of `stored_root` for comment authors that `incoming` has no respStmt for."""
    try:
        incoming_root = etree.fromstring(incoming.encode("utf-8"))
    except etree.XMLSyntaxError:
        return incoming
    stored_persons = resp_persons(stored_root)
    incoming_persons = resp_persons(incoming_root)
    authors = {c.author for c in read_comments(find_standoff_list(incoming_root, COMMENT_LIST_TYPE))}
    for author in sorted(authors):
        if author in stored_persons and author not in incoming_persons:
            incoming = _ensure_resp_stmt(incoming, incoming_root, author, stored_persons[author], "Commenter")
            incoming_root = etree.fromstring(incoming.encode("utf-8"))
    return incoming


def _insert_comments(
    stored: str,
    incoming: str,
    incoming_root: etree._Element,  # type: ignore[name-defined]
    stored_comments: list[UnitComment],
    incoming_ids: set[str],
    missing: list[UnitComment],
) -> str:
    """Inserts the `missing` comments of `stored` into `incoming`, each after its predecessor in `stored`."""
    if find_standoff_list(incoming_root, COMMENT_LIST_TYPE) is None:
        incoming = _add_empty_comment_list(incoming, incoming_root)
        if find_standoff_list(etree.fromstring(incoming.encode("utf-8")), COMMENT_LIST_TYPE) is None:
            return incoming

    order = [c.id for c in stored_comments]
    present = set(incoming_ids)
    for comment in missing:
        s_start, s_end = _element_span(stored, "annotation", comment.id)
        block = stored[s_start:s_end]
        previous = next((cid for cid in reversed(order[: order.index(comment.id)]) if cid in present), None)
        if previous:
            _, at = _element_span(incoming, "annotation", previous)
            indent = _indent_at(incoming, _element_span(incoming, "annotation", previous)[0])
        else:
            list_open = re.compile(rf'<(?:[\w.-]+:)?listAnnotation\b[^>]*\btype=(["\']){COMMENT_LIST_TYPE}\1[^>]*>').search(incoming)
            assert list_open is not None
            at = list_open.end()
            indent = _indent_at(incoming, list_open.start()) + DEFAULT_INDENT_UNIT
        incoming = incoming[:at] + "\n" + _reindent(block, _indent_at(stored, s_start), indent) + incoming[at:]
        present.add(comment.id)
    return incoming


def _reindent(block: str, old: str, new: str) -> str:
    lines = block.split("\n")
    out = [new + lines[0]]
    for line in lines[1:]:
        out.append(new + line[len(old):] if line.startswith(old) else line)
    return "\n".join(out)


def _add_empty_comment_list(xml: str, root: etree._Element) -> str:  # type: ignore[name-defined]
    """Adds an empty `listAnnotation[@type="unit-comment"]`, in the existing `standOff` or a new one after the `teiHeader`."""
    empty = f'<listAnnotation type="{COMMENT_LIST_TYPE}" subtype="{FP_ALGORITHM}">\n'
    if child_elements(root, "standOff"):
        close = re.compile(r"</(?:[\w.-]+:)?standOff\s*>").search(xml)
        if not close:
            return xml
        indent = _indent_at(xml, close.start())
        i1 = indent + DEFAULT_INDENT_UNIT
        block = f"{i1}{empty}{i1}</listAnnotation>\n"
        line_start = xml.rfind("\n", 0, close.start()) + 1
        if xml[line_start:close.start()].strip() == "":
            return xml[:line_start] + block + xml[line_start:]
        return xml[:close.start()] + "\n" + block + indent + xml[close.start():]
    header_close = re.compile(r"</(?:[\w.-]+:)?teiHeader\s*>").search(xml)
    if not header_close:
        return xml
    indent = _indent_at(xml, header_close.start())
    i1 = indent + DEFAULT_INDENT_UNIT
    block = f"\n{indent}<standOff>\n{i1}{empty}{i1}</listAnnotation>\n{indent}</standOff>"
    return xml[:header_close.end()] + block + xml[header_close.end():]
