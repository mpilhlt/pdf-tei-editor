"""
Merging of the stand-off lists of the editor (unit review marks and unit comments) between two
versions of the same TEI file, as text edits that leave the rest of the file byte for byte as it is.

Every `annotation` of the two lists belongs to a user: a comment to its author (`@resp`), a review
annotation to its reviewer (`@resp`; LLM reviewers have none and belong to nobody). Two uses:

- `apply_contribution()`: a user who cannot edit a file adds review marks and comments to it (the
  stand-off endpoint in `fastapi_app/routers/files_comments.py`). The user's own annotations are
  taken from the text the user's editor sends, everything else from the stored file. Status changes
  (resolve, reopen) the user made on other users' threads are added to them.
- `merge_foreign_standoff()`: when a file is saved over, the annotations of other users are taken
  from the stored file where they are newer (they were added, changed or removed in place while the
  saving user had the file open), and their status changes on the saver's threads are kept.

Replies to a thread that the merge removes go with it, as in the editor when a thread is deleted.
"""

from __future__ import annotations

import re
from collections.abc import Callable
from dataclasses import dataclass

from lxml import etree

from .comment_edit import (
    DEFAULT_INDENT_UNIT,
    _element_span,
    _ensure_resp_stmt,
    _indent_at,
    _reindent,
    escape_xml,
)
from .standoff_reader import (
    COMMENT_LIST_TYPE,
    REVIEW_LIST_TYPE,
    XML_ID,
    child_elements,
    find_standoff_list,
    read_comments,
    resp_persons,
    text_content,
)


@dataclass
class _Item:
    id: str
    author: str | None
    reply_to: str | None
    when: str
    changes: list[tuple[str, str, str | None]]


def _items(root: etree._Element, list_type: str) -> list[_Item]:  # type: ignore[name-defined]
    """The annotations of a stand-off list, in document order."""
    lst = find_standoff_list(root, list_type)
    if lst is None:
        return []
    if list_type == COMMENT_LIST_TYPE:
        return [
            _Item(
                id=c.id, author=c.author or None, reply_to=c.reply_to,
                when=max((ch.when for ch in c.changes), default=""),
                changes=[(ch.who, ch.when, ch.status) for ch in c.changes],
            )
            for c in read_comments(lst)
        ]
    items: list[_Item] = []
    for annotation in child_elements(lst, "annotation"):
        item_id = annotation.get(XML_ID)
        if not item_id:
            continue
        resp = annotation.get("resp")
        whens = [c.get("when") or "" for rd in child_elements(annotation, "revisionDesc") for c in child_elements(rd, "change")]
        items.append(_Item(id=item_id, author=resp.lstrip("#") if resp else None, reply_to=None, when=max(whens, default=""), changes=[]))
    return items


def _parse(xml: str) -> etree._Element:  # type: ignore[name-defined]
    return etree.fromstring(xml.encode("utf-8"))


def _list_span(xml: str, list_type: str) -> tuple[int, int, int] | None:
    """Start, end of the open tag, and end of the `listAnnotation[@type]` element."""
    open_tag = re.compile(rf'<(?:[\w.-]+:)?listAnnotation\b[^>]*\btype=(["\']){re.escape(list_type)}\1[^>]*>').search(xml)
    if not open_tag:
        return None
    if open_tag.group(0).endswith("/>"):
        return open_tag.start(), open_tag.end(), open_tag.end()
    close = re.compile(r"</(?:[\w.-]+:)?listAnnotation\s*>").search(xml, open_tag.end())
    if not close:
        return None
    return open_tag.start(), open_tag.end(), close.end()


def _block(xml: str, item_id: str) -> tuple[int, int, str]:
    start, end = _element_span(xml, "annotation", item_id)
    return start, end, xml[start:end]


def _normalized(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


def _remove(xml: str, item_id: str) -> str:
    start, end, _ = _block(xml, item_id)
    line_start = xml.rfind("\n", 0, start) + 1
    if xml[line_start:start].strip() == "":
        start = line_start - 1 if line_start > 0 else line_start
    return xml[:start] + xml[end:]


def _list_skeleton(xml: str, list_type: str) -> tuple[str, list[str]] | None:
    """The open tag and the leading `note` children of a list (the review list's unit path and summary)."""
    span = _list_span(xml, list_type)
    if span is None:
        return None
    start, open_end, end = span
    inner = xml[open_end:end]
    first = re.search(r"<(?:[\w.-]+:)?annotation\b", inner)
    head = inner[: first.start()] if first else inner
    notes = re.findall(r"<(?:[\w.-]+:)?note\b[^>]*?(?:/>|>.*?</(?:[\w.-]+:)?note\s*>)", head, re.S)
    open_tag = xml[start:open_end]
    if open_tag.endswith("/>"):
        open_tag = open_tag[:-2].rstrip() + ">"
    return open_tag, notes


def _add_list(xml: str, open_tag: str, children: list[str]) -> str:
    """Adds a list with the given open tag and children, in the `standOff` or a new one after the `teiHeader`."""
    root = _parse(xml)
    local = re.match(r"<((?:[\w.-]+:)?listAnnotation)", open_tag)
    close_tag = f"</{local.group(1) if local else 'listAnnotation'}>"

    def block(indent: str) -> str:
        i1 = indent + DEFAULT_INDENT_UNIT
        lines = [f"{i1}{open_tag}"] + [f"{i1}{DEFAULT_INDENT_UNIT}{c}" for c in children] + [f"{i1}{close_tag}"]
        return "\n".join(lines)

    if child_elements(root, "standOff"):
        close = re.compile(r"</(?:[\w.-]+:)?standOff\s*>").search(xml)
        if not close:
            return xml
        indent = _indent_at(xml, close.start())
        line_start = xml.rfind("\n", 0, close.start()) + 1
        if xml[line_start:close.start()].strip() == "":
            return xml[:line_start] + block(indent) + "\n" + xml[line_start:]
        return xml[:close.start()] + "\n" + block(indent) + "\n" + indent + xml[close.start():]
    header_close = re.compile(r"</(?:[\w.-]+:)?teiHeader\s*>").search(xml)
    if not header_close:
        return xml
    indent = _indent_at(xml, header_close.start())
    return xml[:header_close.end()] + f"\n{indent}<standOff>\n{block(indent)}\n{indent}</standOff>" + xml[header_close.end():]


def _insert(xml: str, list_type: str, block: str, block_indent: str, after: str | None) -> str:
    """Inserts an annotation block after the annotation `after`, or before the list's first annotation."""
    if after:
        start, end = _element_span(xml, "annotation", after)
        return xml[:end] + "\n" + _reindent(block, block_indent, _indent_at(xml, start)) + xml[end:]
    span = _list_span(xml, list_type)
    assert span is not None
    list_start, open_end, list_end = span
    first = re.compile(r"<(?:[\w.-]+:)?annotation\b").search(xml, open_end, list_end)
    if first:
        line_start = xml.rfind("\n", 0, first.start()) + 1
        indent = _indent_at(xml, first.start())
        if xml[line_start:first.start()].strip() == "":
            return xml[:line_start] + _reindent(block, block_indent, indent) + "\n" + xml[line_start:]
        return xml[:first.start()] + _reindent(block, block_indent, "").lstrip() + "\n" + indent + xml[first.start():]
    close = re.compile(r"</(?:[\w.-]+:)?listAnnotation\s*>").search(xml, open_end)
    assert close is not None
    outer = _indent_at(xml, list_start)
    indent = outer + DEFAULT_INDENT_UNIT
    line_start = xml.rfind("\n", 0, close.start()) + 1
    if xml[line_start:close.start()].strip() == "":
        return xml[:line_start] + _reindent(block, block_indent, indent) + "\n" + xml[line_start:]
    return xml[:close.start()] + "\n" + _reindent(block, block_indent, indent) + "\n" + outer + xml[close.start():]


def _sync_items(
    base: str,
    source: str,
    list_type: str,
    owns: Callable[[_Item], bool],
    take: Callable[[_Item | None, _Item | None], bool],
) -> str:
    """
    Brings the annotations of `base` that `owns()` selects in line with `source`: adds, replaces and
    removes them where `take(base_item, source_item)` says the source version wins (an item missing
    on one side is None).
    """
    source_items = _items(_parse(source), list_type)
    base_items = {i.id: i for i in _items(_parse(base), list_type)}
    source_by_id = {i.id: i for i in source_items}
    if not any(owns(i) for i in source_items) and not any(owns(i) for i in base_items.values()):
        return base

    xml = base
    for item in list(base_items.values()):
        if owns(item) and item.id not in source_by_id and take(item, None):
            xml = _remove(xml, item.id)
            del base_items[item.id]
    for item in source_items:
        old = base_items.get(item.id)
        if old is None or not owns(item) or not take(old, item):
            continue
        s_start, _, s_block = _block(source, item.id)
        b_start, b_end, b_block = _block(xml, item.id)
        if _normalized(s_block) != _normalized(b_block):
            xml = xml[:b_start] + _reindent(s_block, _indent_at(source, s_start), _indent_at(xml, b_start)).lstrip() + xml[b_end:]

    missing = [i for i in source_items if i.id not in base_items and owns(i) and take(None, i)]
    if not missing:
        return xml
    if _list_span(xml, list_type) is None:
        skeleton = _list_skeleton(source, list_type)
        if skeleton is None:
            return xml
        xml = _add_list(xml, *skeleton)
        if _list_span(xml, list_type) is None:
            return xml
    present = set(base_items)
    order = [i.id for i in source_items]
    for item in missing:
        s_start, _, s_block = _block(source, item.id)
        previous = next((pid for pid in reversed(order[: order.index(item.id)]) if pid in present), None)
        xml = _insert(xml, list_type, s_block, _indent_at(source, s_start), previous)
        present.add(item.id)
    return xml


def _append_change(xml: str, comment_id: str, change: str) -> str:
    """Adds a `change` element at the end of a comment's `revisionDesc`."""
    start, end = _element_span(xml, "annotation", comment_id)
    close = re.compile(r"</(?:[\w.-]+:)?revisionDesc\s*>").search(xml, start, end)
    if not close:
        return xml
    change_indent = _indent_at(xml, close.start()) + DEFAULT_INDENT_UNIT
    for m in re.finditer(r"\n([ \t]*)<(?:[\w.-]+:)?change\b", xml[start:close.start()]):
        change_indent = m.group(1)
    line_start = xml.rfind("\n", 0, close.start()) + 1
    if xml[line_start:close.start()].strip() == "":
        return xml[:line_start] + change_indent + change + "\n" + xml[line_start:]
    return xml[:close.start()] + change + xml[close.start():]


def _add_status_changes(base: str, source: str, by: Callable[[str], bool]) -> str:
    """Adds the resolve and reopen changes of `source` made by users that `by()` selects to the threads of `base`."""
    source_roots = {i.id: i for i in _items(_parse(source), COMMENT_LIST_TYPE) if not i.reply_to}
    xml = base
    for item in _items(_parse(base), COMMENT_LIST_TYPE):
        other = source_roots.get(item.id)
        if item.reply_to or other is None:
            continue
        known = set(item.changes)
        new = sorted(
            (c for c in other.changes if c not in known and c[2] in ("open", "resolved") and by(c[0])),
            key=lambda c: c[1],
        )
        for who, when, status in new:
            xml = _append_change(xml, item.id, f'<change when="{escape_xml(when)}" who="#{escape_xml(who)}" status="{status}"/>')
    return xml


def _remove_orphan_replies(xml: str, *texts: str) -> str:
    """Removes the replies to threads that one of `texts` has and `xml` no longer has (deleted threads)."""
    items = _items(_parse(xml), COMMENT_LIST_TYPE)
    roots = {i.id for i in items if not i.reply_to}
    gone = {i.id for t in texts for i in _items(_parse(t), COMMENT_LIST_TYPE) if not i.reply_to} - roots
    for item in items:
        if item.reply_to in gone:
            xml = _remove(xml, item.id)
    return xml


def _replace_summary(base: str, source: str) -> str:
    """Takes the review list's `note[@type="summary"]` (the combined counts) from `source`."""
    pattern = re.compile(r'<(?:[\w.-]+:)?note\b[^>]*\btype=(["\'])summary\1[^>]*>.*?</(?:[\w.-]+:)?note\s*>', re.S)
    s_span, b_span = _list_span(source, REVIEW_LIST_TYPE), _list_span(base, REVIEW_LIST_TYPE)
    if s_span is None or b_span is None:
        return base
    s_note = pattern.search(source, s_span[1], s_span[2])
    b_note = pattern.search(base, b_span[1], b_span[2])
    if s_note and b_note:
        return base[:b_note.start()] + s_note.group(0) + base[b_note.end():]
    return base


def _ensure_resp_stmts(xml: str, source: str, authors: set[str], resp: str) -> str:
    """Adds respStmts for annotation authors that `xml` lacks, with the name `source` gives them."""
    persons = resp_persons(_parse(source))
    for author in sorted(authors):
        root = _parse(xml)
        if author not in resp_persons(root):
            xml = _ensure_resp_stmt(xml, root, author, persons.get(author) or author, resp)
    return xml


def _resp_of(source: str, username: str, fallback: str) -> str:
    """The `resp` of the user's respStmt in `source`, e.g. `Reviewer`."""
    root = _parse(source)
    for pers in root.iter("{http://www.tei-c.org/ns/1.0}persName"):
        parent = pers.getparent()
        if pers.get(XML_ID) == username and parent is not None and etree.QName(parent).localname == "respStmt":
            for resp in child_elements(parent, "resp"):
                return text_content(resp).strip() or fallback
    return fallback


def apply_contribution(stored: str, incoming: str, username: str, fullname: str, reviews: bool, comments: bool) -> str:
    """
    Applies a user's changes to the stand-off lists of `incoming` to `stored`: the user's own review
    annotation (if `reviews`) and comments (if `comments`), and the user's status changes on other
    threads. Everything else of `incoming` is ignored.

    Args:
        stored: The file as stored
        incoming: The text of the user's editor
        username: The contributing user
        fullname: The user's name for a new respStmt
        reviews: Whether the user may set review marks
        comments: Whether the user may comment

    Raises:
        etree.XMLSyntaxError: If one of the texts is not well-formed
    """
    _parse(stored)
    _parse(incoming)

    def own(item: _Item) -> bool:
        return item.author == username

    def always(_base: _Item | None, _source: _Item | None) -> bool:
        return True

    xml = stored
    if comments:
        xml = _sync_items(xml, incoming, COMMENT_LIST_TYPE, own, always)
        xml = _add_status_changes(xml, incoming, lambda who: who == username)
        xml = _remove_orphan_replies(xml, stored)
    if reviews:
        before = xml
        xml = _sync_items(xml, incoming, REVIEW_LIST_TYPE, own, always)
        if xml != before:
            xml = _replace_summary(xml, incoming)
    if xml != stored:
        root = _parse(xml)
        authored = any(i.author == username for t in (COMMENT_LIST_TYPE, REVIEW_LIST_TYPE) for i in _items(root, t))
        if authored and username not in resp_persons(root):
            default = "Reviewer" if any(i.author == username for i in _items(root, REVIEW_LIST_TYPE)) else "Commenter"
            xml = _ensure_resp_stmt(xml, root, username, fullname or username, _resp_of(incoming, username, default))
    return xml


def comment_list(xml: str) -> str | None:
    """The markup of the unit comment list (`listAnnotation[@type="unit-comment"]`), or None."""
    span = _list_span(xml, COMMENT_LIST_TYPE)
    return xml[span[0]:span[2]] if span else None


def review_annotation(xml: str, username: str) -> str | None:
    """
    The markup of a user's review annotation (`annotation[@resp="#username"]` of the unit review
    list), or None if the user has not reviewed the file.

    Raises:
        etree.XMLSyntaxError: If the text is not well-formed
    """
    item = next((i for i in _items(_parse(xml), REVIEW_LIST_TYPE) if i.author == username), None)
    return _block(xml, item.id)[2] if item else None


def merge_foreign_standoff(stored: str, incoming: str, username: str) -> str:
    """
    Keeps, in the text `incoming` that `username` saves over `stored`, what other users changed in
    the stand-off lists in the meantime: their comments and review annotations as stored where
    the stored version is newer or the item is missing on one side, and their status changes on
    `username`'s threads. LLM review annotations follow `incoming`. Authors of the result's comments
    and reviews that have a respStmt in `stored` but not in `incoming` get it back.

    Returns:
        `incoming` with the merged lists; unchanged if a text is not well-formed
    """
    try:
        _parse(stored)
        _parse(incoming)
    except etree.XMLSyntaxError:
        return incoming

    def foreign(item: _Item) -> bool:
        return item.author is not None and item.author != username

    def stored_wins(base: _Item | None, source: _Item | None) -> bool:
        if base is None or source is None:
            return True
        return source.when > base.when

    xml = _sync_items(incoming, stored, COMMENT_LIST_TYPE, foreign, stored_wins)
    xml = _add_status_changes(xml, stored, lambda who: who != username)
    xml = _remove_orphan_replies(xml, incoming, stored)
    xml = _sync_items(xml, stored, REVIEW_LIST_TYPE, foreign, stored_wins)

    root = _parse(xml)
    comment_authors = {i.author for i in _items(root, COMMENT_LIST_TYPE) if i.author}
    review_authors = {i.author for i in _items(root, REVIEW_LIST_TYPE) if i.author}
    stored_persons = resp_persons(_parse(stored))
    xml = _ensure_resp_stmts(xml, stored, {a for a in comment_authors if a in stored_persons}, "Commenter")
    xml = _ensure_resp_stmts(xml, stored, {a for a in review_authors if a in stored_persons}, "Reviewer")
    return xml
