"""
Prompt building and response validation for the annotation-review LLM call.

Pure functions only — no HTTP, no file I/O — so the anti-hallucination
validation (the most important logic in this plugin) can be unit-tested
without any of the surrounding plugin/route machinery.

See docs/superpowers/specs/2026-09-24-llm-annotation-review-design.md
(Part C) for the design rationale.
"""

import json
import logging
import re
from typing import TypedDict

from lxml import etree

logger = logging.getLogger(__name__)

_REQUIRED_KEYS = ("old", "new", "rationale")


class UnusableResponseError(Exception):
    """The LLM's response contained no JSON list of findings (empty, prose only, wrong shape)."""


class Finding(TypedDict):
    id: int
    old: str
    new: str
    rationale: str


def build_system_prompt() -> str:
    """Instructions for the review LLM call: task, response contract, anti-hallucination rule."""
    return (
        "You are reviewing a TEI-encoded document's annotations against a set "
        "of annotation rules. You will be given one or more rule excerpts, "
        "each labeled with its category, followed by the document's <text> "
        "content (as XML).\n\n"
        "Check whether the document's annotations follow the given rules. "
        "For every place where an annotation is missing, wrong, or could be "
        "improved per the rules, propose a fix.\n\n"
        "Respond with ONLY a JSON array (no prose, no markdown fence) of "
        "objects, each with exactly these keys:\n"
        '  "old": the verbatim original XML snippet to replace\n'
        '  "new": the suggested replacement XML snippet\n'
        '  "rationale": a short explanation of why this change is suggested\n\n'
        'Example: [{"old": "<persName>J. Doe</persName>", '
        '"new": "<persName ref=\\"#p1\\">J. Doe</persName>", '
        '"rationale": "..."}]\n\n'
        "CRITICAL: \"old\" must be copied character for character from the "
        "given text (do not reformat, re-indent or normalize anything) and "
        "must occur exactly once in it. A finding whose \"old\" is missing or "
        "ambiguous will be discarded.\n\n"
        "Use the SMALLEST snippet that fixes the problem and is still unique: "
        "the single element or attribute that must change, plus only as much "
        "adjacent text as is needed to make it unique. Do not copy a whole "
        "enclosing element when only a part of it changes. Report every "
        "distinct problem as its own finding with its own snippet; if one "
        "element has several problems, give one finding per problem, each "
        "with a non-overlapping \"old\". Never wrap text in an element it is "
        "already enclosed in (for example, do not wrap the content of an "
        "<author> in another <author>). If there is nothing to fix, respond "
        "with an empty JSON array: []"
    )


def build_user_prompt(
    rule_excerpts: list[tuple[str, str]],
    text_content: str,
    chunk_position: tuple[int, int] | None = None,
    scoped: bool = False,
) -> str:
    """
    Combine every (category, excerpt) pair with the document text into a
    single prompt. chunk_position is (1-based index, total) when text_content
    is only one fragment of a longer document. scoped is True when
    text_content is (part of) a single element the user selected rather than
    the document's <text>.
    """
    sections = []
    for category, excerpt in rule_excerpts:
        sections.append(f"## Rule category: {category}\n\n{excerpt}")
    rules_block = "\n\n".join(sections)
    return (
        f"{rules_block}\n\n"
        f"{_document_heading(chunk_position, scoped)}\n\n{text_content}"
    )


def _document_heading(chunk_position: tuple[int, int] | None, scoped: bool = False) -> str:
    subject = "a single element of a longer document" if scoped else "a longer document"
    if chunk_position is None or chunk_position[1] == 1:
        return f"## Document text ({subject}; review only this element)" if scoped else "## Document text"
    index, total = chunk_position
    return (
        f"## Document text (fragment {index} of {total} of {subject}; "
        f"review only this fragment, and its tags may be unbalanced at the edges)"
    )


def _salvage_truncated_list(raw_response: str) -> list[object]:
    """
    Recover the complete objects from a JSON array that was cut off mid-way (an LLM hitting its
    output token limit). Returns [] if the response has no array start or no complete object.
    """
    decoder = json.JSONDecoder()
    for match in re.finditer(r"\[", raw_response):
        objects: list[object] = []
        index = match.end()
        while True:
            while index < len(raw_response) and raw_response[index] in " \t\r\n,":
                index += 1
            try:
                value, index = decoder.raw_decode(raw_response, index)
            except json.JSONDecodeError:
                break
            if not isinstance(value, dict):
                objects = []
                break
            objects.append(value)
        if objects:
            return objects
    return []


def _extract_json_list(raw_response: str) -> list[object]:
    """
    Find the JSON array of findings in an LLM response. Models often wrap the array in a
    markdown fence or surround it with prose despite being told not to, so every "[" is tried
    as the start of a JSON value and the first one that decodes to a list of objects (or an
    empty list) wins.

    Raises:
        UnusableResponseError: if the response contains no such array. The start of the
            response is logged, since it is the only way to tell why.
    """
    decoder = json.JSONDecoder()
    for match in re.finditer(r"\[", raw_response):
        try:
            value, _ = decoder.raw_decode(raw_response[match.start():])
        except json.JSONDecodeError:
            continue
        if isinstance(value, list) and all(isinstance(item, dict) for item in value):
            return value
    salvaged = _salvage_truncated_list(raw_response)
    if salvaged:
        logger.warning(
            f"annotation-review: LLM response looks truncated (length {len(raw_response)}, probably hit the "
            f"output token limit); using its {len(salvaged)} complete finding(s)"
        )
        return salvaged
    snippet = raw_response.strip()[:300]
    logger.warning(
        f"annotation-review: no JSON list of findings in LLM response "
        f"(length {len(raw_response)}), starts with: {snippet!r}"
    )
    raise UnusableResponseError(
        f"The model did not return a JSON list of findings (response starts with: {snippet[:120]!r})"
        if snippet else "The model returned an empty response"
    )


def build_retry_note(unmatched: list[str]) -> str:
    """
    Appended to the user prompt when every finding of a first attempt was
    discarded because its "old" did not occur exactly once in the document.
    """
    quoted = "\n".join(f"- {json.dumps(old, ensure_ascii=False)}" for old in unmatched)
    return (
        "\n\n## Note on a previous attempt\n\n"
        "A previous review of this text proposed fixes whose \"old\" snippets do not occur exactly once in the document, so all of them were discarded:\n\n"
        f"{quoted}\n\n"
        "Review the text again. Copy every \"old\" character for character from the document text above, including attribute quotes, entities and whitespace, and include just enough context to make it unique."
    )


def parse_and_validate_findings(raw_response: str, source_text: str) -> list[Finding]:
    """
    Parse the LLM's JSON array response and keep only findings whose "old"
    occurs exactly once in source_text - the primary defense against
    hallucinated or under-specified findings. A finding missing a required
    key, or one whose "old", "new" or "rationale" is not a string, is dropped
    (logged): a partially-bad response still yields whatever findings are
    trustworthy. Kept findings are assigned a sequential integer "id"
    (0-based, over the kept findings only, in response order).

    Raises:
        UnusableResponseError: if the response contains no JSON list at all.
            That is not "no findings" but a failed review.
    """
    return validate_findings(raw_response, source_text)[0]


def _anchor_in_scope(old: str, new: str, scope: str, document: str) -> tuple[str, str] | None:
    """
    Widen a finding whose "old" occurs exactly once in scope by the scope's own
    surrounding characters until it occurs exactly once in document, so the
    client can locate it. The scope may repeat text found elsewhere in the
    document (the same reference cited twice), which the model cannot see.
    Returns the widened (old, new), or None if even the whole scope is not
    unique in the document.
    """
    start = scope.index(old)
    end = start + len(old)

    def widen(grow_left: bool, grow_right: bool) -> tuple[int, int] | None:
        left, right = start, end
        while document.count(scope[left:right]) != 1:
            if (not grow_left or left == 0) and (not grow_right or right == len(scope)):
                return None
            left = max(0, left - 1) if grow_left else left
            right = min(len(scope), right + 1) if grow_right else right
        return left, right

    # Prefer the shortest widening: towards the text that differs from the other occurrences
    candidates = [span for span in (widen(False, True), widen(True, False), widen(True, True)) if span is not None]
    if not candidates:
        return None
    left, right = min(candidates, key=lambda span: span[1] - span[0])
    return scope[left:right], scope[left:start] + new + scope[end:right]


def _count_redundant_wraps(xml: str) -> int | None:
    """
    Number of elements whose only content is a single child element of the
    same name (e.g. <author><author>X</author></author>), or None if xml is
    not well-formed on its own.
    """
    try:
        root = etree.fromstring(xml.encode("utf-8"))
    except etree.XMLSyntaxError:
        return None
    count = 0
    for element in root.iter(tag=etree.Element):
        children = [child for child in element if isinstance(child.tag, str)]
        if (
            len(children) == 1
            and children[0].tag == element.tag
            and not (element.text or "").strip()
            and not (children[0].tail or "").strip()
        ):
            count += 1
    return count


def _adds_redundant_wrap(old: str, new: str, source_text: str, before: int | None) -> bool:
    """
    True if replacing the (unique) old in source_text with new wraps the whole
    content of an element in another element of the same name. Models
    reviewing already-annotated text sometimes propose to "add" an element
    that is already there, which would nest it in itself.
    """
    if before is None:
        return False
    start = source_text.index(old)
    after = _count_redundant_wraps(source_text[:start] + new + source_text[start + len(old):])
    return after is not None and after > before


def validate_findings(
    raw_response: str, source_text: str, scope: str | None = None
) -> tuple[list[Finding], list[str]]:
    """
    Like parse_and_validate_findings(), but also returns the "old" snippets of
    the findings dropped because they do not occur exactly once in source_text.

    With a scope (the single element that was reviewed, part of source_text),
    "old" must instead occur exactly once in the scope, and a finding whose
    "old" is not unique in source_text is widened with context from the scope
    (see _anchor_in_scope()). Without this, text the scope shares with
    another element would be discarded, and text that occurs only outside
    the scope would be applied there.

    Raises:
        UnusableResponseError: see parse_and_validate_findings().
    """
    parsed = _extract_json_list(raw_response)

    kept: list[Finding] = []
    unmatched: list[str] = []
    wraps_before: int | None = None
    wraps_counted = False
    for item in parsed:
        if not isinstance(item, dict) or not all(k in item for k in _REQUIRED_KEYS):
            logger.warning(f"annotation-review: dropping finding missing required keys: {item!r}")
            continue
        old = item["old"]
        new = item["new"]
        rationale = item["rationale"]
        if not isinstance(old, str):
            logger.warning(f"annotation-review: dropping finding with non-string 'old': {item!r}")
            continue
        if not isinstance(new, str):
            logger.warning(f"annotation-review: dropping finding with non-string 'new': {item!r}")
            continue
        if not isinstance(rationale, str):
            logger.warning(f"annotation-review: dropping finding with non-string 'rationale': {item!r}")
            continue
        occurrences = (scope if scope is not None else source_text).count(old)
        if occurrences != 1:
            logger.warning(
                f"annotation-review: dropping finding, 'old' occurs {occurrences} times "
                f"in the {'reviewed element' if scope is not None else 'document'} (expected exactly 1): {old!r}"
            )
            unmatched.append(old)
            continue
        if scope is not None and source_text.count(old) != 1:
            anchored = _anchor_in_scope(old, new, scope, source_text)
            if anchored is None:
                logger.warning(
                    f"annotation-review: dropping finding, the reviewed element is not unique in the document: {old!r}"
                )
                unmatched.append(old)
                continue
            old, new = anchored
        if not wraps_counted:
            wraps_before = _count_redundant_wraps(source_text)
            wraps_counted = True
        if _adds_redundant_wrap(old, new, source_text, wraps_before):
            logger.warning(
                f"annotation-review: dropping finding that wraps an element's content in another element of the same name: {old!r} -> {new!r}"
            )
            continue
        kept.append({
            "id": len(kept),
            "old": old,
            "new": new,
            "rationale": rationale,
        })
    logger.info(f"annotation-review: kept {len(kept)} of {len(parsed)} findings")
    return kept, unmatched
