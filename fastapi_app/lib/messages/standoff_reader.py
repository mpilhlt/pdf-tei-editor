"""
Reading of the editor's stand-off lists (`TEI/standOff/listAnnotation[@type]`) on the server.

Mirrors the JS modules `app/src/modules/unit-review.js` (`readReviewData`, `findUnits`,
`canonicalForm`) and `app/src/modules/unit-comments.js` (`readComments`, `buildThreads`,
`threadStatus`). The shared fixtures in `tests/unit/fixtures/standoff/` are read by the unit tests
of both sides, so that they stay in step.

The JS fingerprint is computed from the source text, in which character and entity references
are not resolved. lxml resolves them, so `&` and `<` in text and attribute values are escaped again
here. Other references (`&#x2014;`) give a different fingerprint; fingerprints are only used for
excerpts on the server, so such a unit has no excerpt.
"""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass, field
from typing import Literal

from lxml import etree

TEI_NS = "http://www.tei-c.org/ns/1.0"
XML_NS = "http://www.w3.org/XML/1998/namespace"
XML_ID = f"{{{XML_NS}}}id"

REVIEW_LIST_TYPE = "unit-review"
COMMENT_LIST_TYPE = "unit-comment"
DEFAULT_UNIT_PATH = "auto"

MarkState = Literal["ok", "not-ok"]
ThreadStatus = Literal["open", "resolved"]

_MARK_TYPE = re.compile(r"^(was-|final-)?(ok|not-ok)$")
_STEP_NAME = re.compile(r"^(\*|[A-Za-z_][\w.-]*)$")
_WHITESPACE = re.compile(r"\s+")


# ── Elements ────────────────────────────────────────────────────────────


def local_name(element: etree._Element) -> str | None:  # type: ignore[name-defined]
    """Local name of an element, None for comments and processing instructions."""
    if not isinstance(element.tag, str):
        return None
    return etree.QName(element).localname


def child_elements(element: etree._Element, name: str | None = None) -> list[etree._Element]:  # type: ignore[name-defined]
    """Child elements, optionally only those with the given local name."""
    return [c for c in element if isinstance(c.tag, str) and (name is None or local_name(c) == name)]


def text_content(element: etree._Element) -> str:  # type: ignore[name-defined]
    """All text of an element and its descendants (DOM `textContent`)."""
    return "".join(element.itertext())


def normalize_space(text: str) -> str:
    """Collapses whitespace runs to one space and trims."""
    return _WHITESPACE.sub(" ", text).strip()


def find_standoff_list(root: etree._Element, list_type: str) -> etree._Element | None:  # type: ignore[name-defined]
    """`TEI/standOff/listAnnotation[@type=list_type]` (in the first `standOff`), or None."""
    for stand_off in child_elements(root, "standOff"):
        for lst in child_elements(stand_off, "listAnnotation"):
            if lst.get("type") == list_type:
                return lst
        return None
    return None


def resp_persons(root: etree._Element) -> dict[str, str]:  # type: ignore[name-defined]
    """Persons of `teiHeader//fileDesc//respStmt/persName[@xml:id]`, as display name by id."""
    persons: dict[str, str] = {}
    for pers in root.iterfind(f".//{{{TEI_NS}}}fileDesc//{{{TEI_NS}}}respStmt/{{{TEI_NS}}}persName"):
        pers_id = pers.get(XML_ID)
        if pers_id and pers_id not in persons:
            persons[pers_id] = normalize_space(text_content(pers)) or pers_id
    return persons


def element_by_path(root: etree._Element, path: str) -> etree._Element | None:  # type: ignore[name-defined]
    """The element at an XPath of the form written by the JS `elementPath()` (`/TEI/text/back/listBibl/bibl[3]`)."""
    node: etree._Element | None = None  # type: ignore[name-defined]
    for step in [s for s in path.split("/") if s]:
        match = re.match(r"^([^[\]]+)(?:\[(\d+)\])?$", step)
        if not match:
            return None
        name = match.group(1).split(":")[-1]
        index = int(match.group(2)) - 1 if match.group(2) else 0
        candidates = [root] if node is None else child_elements(node)
        matching = [c for c in candidates if local_name(c) == name]
        if index >= len(matching):
            return None
        node = matching[index]
    return node


def element_excerpt(element: etree._Element, length: int = 120) -> str:  # type: ignore[name-defined]
    """The first characters of an element's text, whitespace collapsed."""
    text = normalize_space(text_content(element))
    return text if len(text) <= length else text[: length - 1].rstrip() + "…"


# ── Fingerprints and units ──────────────────────────────────────────────


def _escape_source(text: str, attribute: bool = False) -> str:
    """Escapes text the way it appears in the source (see the module docstring)."""
    text = text.replace("&", "&amp;").replace("<", "&lt;")
    return text.replace('"', "&quot;") if attribute else text


def _attribute_name(element: etree._Element, name: str) -> str:  # type: ignore[name-defined]
    """Attribute name as written in the source (`xml:id`, `type`)."""
    qname = etree.QName(name)
    if not qname.namespace:
        return qname.localname
    if qname.namespace == XML_NS:
        return f"xml:{qname.localname}"
    for prefix, uri in element.nsmap.items():
        if uri == qname.namespace and prefix:
            return f"{prefix}:{qname.localname}"
    return qname.localname


def canonical_form(element: etree._Element) -> str:  # type: ignore[name-defined]
    """
    Canonical form of an element, as `canonicalForm()` in unit-review.js: local tag names,
    attributes (and namespace declarations made on the element) sorted by name, text with
    whitespace collapsed per text run, comments and processing instructions left out.
    """
    name = local_name(element) or "?"
    attributes: list[tuple[str, str]] = [
        (_attribute_name(element, key), _escape_source(value, attribute=True)) for key, value in element.attrib.items()
    ]
    parent = element.getparent()
    parent_nsmap = parent.nsmap if parent is not None else {}
    for prefix, uri in element.nsmap.items():
        if parent_nsmap.get(prefix) != uri:
            attributes.append(("xmlns" if prefix is None else f"xmlns:{prefix}", uri))
    attributes.sort(key=lambda a: a[0])
    out = "<" + name + "".join(f' {n}="{normalize_space(v)}"' for n, v in attributes) + ">"
    run = element.text or ""
    for child in element:
        if isinstance(child.tag, str):
            normalized = normalize_space(_escape_source(run))
            out += normalized
            run = ""
            out += canonical_form(child)
        run += child.tail or ""
    out += normalize_space(_escape_source(run))
    return out + "</" + name + ">"


def fingerprint_of(canonical: str) -> str:
    """Fingerprint of a canonical form, without the duplicate suffix."""
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()[:8]


@dataclass
class PathStep:
    descendant: bool
    name: str


def parse_unit_path(path: str | None) -> list[PathStep] | None:
    """Parses a unit path relative to `<text>`; `auto` and empty paths return None. Raises ValueError for invalid paths."""
    if not path or path == DEFAULT_UNIT_PATH:
        return None
    rest = path.strip()
    if rest.startswith("."):
        rest = rest[1:]
    if not rest.startswith("/"):
        rest = "/" + rest
    steps: list[PathStep] = []
    consumed = 0
    for match in re.finditer(r"(//?)([^/]+)", rest):
        if match.start() != consumed:
            break
        consumed = match.end()
        name = match.group(2).split(":")[-1]
        if not _STEP_NAME.match(name):
            raise ValueError(f'Invalid unit path step "{match.group(2)}" in "{path}"')
        steps.append(PathStep(descendant=match.group(1) == "//", name=name))
    if consumed != len(rest) or not steps:
        raise ValueError(f'Invalid unit path "{path}"')
    return steps


def _matches_steps(steps: list[PathStep], chain: list[str]) -> bool:
    def match(s: int, c: int) -> bool:
        if s == len(steps):
            return c == len(chain)
        if c == len(chain):
            return False
        step = steps[s]
        if (step.name == "*" or step.name == chain[c]) and match(s + 1, c + 1):
            return True
        return step.descendant and match(s, c + 1)

    return match(0, 0)


def _has_own_text(element: etree._Element) -> bool:  # type: ignore[name-defined]
    if (element.text or "").strip():
        return True
    return any((child.tail or "").strip() for child in element)


def _auto_units(text: etree._Element) -> tuple[list[etree._Element], str]:  # type: ignore[name-defined]
    """Default units: steps down from `<text>` through single non-empty children (see `autoUnits()` in unit-review.js)."""
    current = text
    chain: list[str] = []
    while True:
        children = child_elements(current)
        filled = [c for c in children if child_elements(c) or _has_own_text(c)]
        only = filled[0] if len(filled) == 1 else None
        if only is not None and not _has_own_text(current) and child_elements(only):
            current = only
            chain.append(local_name(current) or "*")
        else:
            return children, "/".join([".", *chain, "*"])


@dataclass
class Unit:
    fingerprint: str
    element: etree._Element  # type: ignore[name-defined]


def find_units(root: etree._Element, unit_path: str | None) -> list[Unit]:  # type: ignore[name-defined]
    """The review units of a document in document order (see `findUnits()` in unit-review.js)."""
    text = next(iter(child_elements(root, "text")), None)
    if text is None:
        return []
    steps = parse_unit_path(unit_path)
    if steps is None:
        nodes, _ = _auto_units(text)
    else:
        nodes = []

        def walk(element: etree._Element, chain: list[str]) -> None:  # type: ignore[name-defined]
            for child in child_elements(element):
                child_chain = [*chain, local_name(child) or ""]
                if _matches_steps(steps, child_chain):
                    nodes.append(child)
                else:
                    walk(child, child_chain)

        walk(text, [])
    units: list[Unit] = []
    seen: dict[str, int] = {}
    for node in nodes:
        base = fingerprint_of(canonical_form(node))
        count = seen.get(base, 0) + 1
        seen[base] = count
        units.append(Unit(fingerprint=base if count == 1 else f"{base}.{count}", element=node))
    return units


# ── Unit review data ────────────────────────────────────────────────────


@dataclass
class Mark:
    state: MarkState
    comment: str
    final: bool


@dataclass
class Reviewer:
    id: str
    name: str | None
    is_llm: bool
    when: str | None
    marks: dict[str, Mark] = field(default_factory=dict)
    was: dict[str, Mark] = field(default_factory=dict)


@dataclass
class ReviewData:
    unit_path: str | None
    reviewers: dict[str, Reviewer]


def read_review_data(list_annotation: etree._Element | None) -> ReviewData:  # type: ignore[name-defined]
    """Reads a `listAnnotation[@type="unit-review"]` element (see `readReviewData()` in unit-review.js)."""
    data = ReviewData(unit_path=None, reviewers={})
    if list_annotation is None:
        return data
    for note in child_elements(list_annotation, "note"):
        if note.get("type") == "unit-xpath":
            data.unit_path = text_content(note).strip() or None
    for annotation in child_elements(list_annotation, "annotation"):
        xml_id = annotation.get(XML_ID) or ""
        resp = annotation.get("resp")
        resp_stmts = child_elements(annotation, "respStmt")
        software_name = None
        if resp_stmts:
            names = child_elements(resp_stmts[0], "name")
            software_name = text_content(names[0]).strip() if names else None
        reviewer_id = resp.lstrip("#") if resp else re.sub(r"^ur-", "", xml_id)
        if not reviewer_id:
            continue
        revision_descs = child_elements(annotation, "revisionDesc")
        changes = child_elements(revision_descs[0], "change") if revision_descs else []
        reviewer = Reviewer(
            id=reviewer_id,
            name=software_name,
            is_llm=not resp and reviewer_id.startswith("llm-"),
            when=changes[0].get("when") if changes else None,
        )
        for note in child_elements(annotation, "note"):
            match = _MARK_TYPE.match(note.get("type") or "")
            if not match:
                continue
            state: MarkState = "ok" if match.group(2) == "ok" else "not-ok"
            target = reviewer.was if match.group(1) == "was-" else reviewer.marks
            final = match.group(1) == "final-"
            n = note.get("n")
            if n:
                target[n] = Mark(state=state, comment=text_content(note).strip(), final=final)
            else:
                for fp in text_content(note).split():
                    target[fp] = Mark(state=state, comment="", final=final)
        data.reviewers[reviewer_id] = reviewer
    return data


# ── Unit comments ───────────────────────────────────────────────────────


@dataclass
class CommentChange:
    who: str
    when: str
    status: Literal["open", "resolved", "edited"] | None


@dataclass
class UnitComment:
    id: str
    reply_to: str | None
    author: str
    text: str
    path: str | None
    fingerprint: str | None
    changes: list[CommentChange]


@dataclass
class CommentThread:
    root: UnitComment
    replies: list[UnitComment]
    status: ThreadStatus


def read_comments(list_annotation: etree._Element | None) -> list[UnitComment]:  # type: ignore[name-defined]
    """Reads a `listAnnotation[@type="unit-comment"]` element (see `readComments()` in unit-comments.js)."""
    if list_annotation is None:
        return []
    comments: list[UnitComment] = []
    for annotation in child_elements(list_annotation, "annotation"):
        comment_id = annotation.get(XML_ID) or ""
        if not comment_id:
            continue
        target = annotation.get("target") or ""
        replying = annotation.get("motivation") == "replying"
        xpath = re.match(r"^#xpath\((.*)\)$", target)
        revision_descs = child_elements(annotation, "revisionDesc")
        changes: list[CommentChange] = []
        for change in child_elements(revision_descs[0], "change") if revision_descs else []:
            status = change.get("status")
            changes.append(CommentChange(
                who=(change.get("who") or "").lstrip("#"),
                when=change.get("when") or "",
                status=status if status in ("open", "resolved", "edited") else None,  # type: ignore[arg-type]
            ))
        notes = {n.get("type"): n for n in reversed(child_elements(annotation, "note"))}
        comment_note = notes.get("comment")
        fingerprint_note = notes.get("fingerprint")
        author = annotation.get("resp") or (changes[0].who if changes else "")
        comments.append(UnitComment(
            id=comment_id,
            reply_to=target.lstrip("#") if replying else None,
            author=author.lstrip("#"),
            text=text_content(comment_note).strip() if comment_note is not None else "",
            path=xpath.group(1) if not replying and xpath else None,
            fingerprint=(text_content(fingerprint_note).strip() or None) if not replying and fingerprint_note is not None else None,
            changes=changes,
        ))
    return comments


def thread_status(root: UnitComment) -> ThreadStatus:
    """Status of a thread from its first comment's changes."""
    for change in reversed(root.changes):
        if change.status == "open" or change.status == "resolved":
            return change.status
    return "open"


def build_threads(comments: list[UnitComment]) -> list[CommentThread]:
    """Groups comments into threads in the order of their first comments; replies to a missing comment are left out."""
    threads: dict[str, CommentThread] = {}
    for comment in comments:
        if not comment.reply_to:
            threads[comment.id] = CommentThread(root=comment, replies=[], status=thread_status(comment))
    for comment in comments:
        if comment.reply_to and comment.reply_to in threads:
            threads[comment.reply_to].replies.append(comment)
    return list(threads.values())
