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
        "CRITICAL: \"old\" must be copied verbatim from the given text and "
        "must occur exactly once in it. Include enough surrounding context "
        "in \"old\" to make it uniquely identifying — a finding whose \"old\" "
        "is missing or ambiguous will be discarded. If there is nothing to "
        "fix, respond with an empty JSON array: []"
    )


def build_user_prompt(
    rule_excerpts: list[tuple[str, str]],
    text_content: str,
    chunk_position: tuple[int, int] | None = None,
) -> str:
    """
    Combine every (category, excerpt) pair with the document text into a
    single prompt. chunk_position is (1-based index, total) when text_content
    is only one fragment of a longer document.
    """
    sections = []
    for category, excerpt in rule_excerpts:
        sections.append(f"## Rule category: {category}\n\n{excerpt}")
    rules_block = "\n\n".join(sections)
    return (
        f"{rules_block}\n\n"
        f"{_document_heading(chunk_position)}\n\n{text_content}"
    )


def _document_heading(chunk_position: tuple[int, int] | None) -> str:
    if chunk_position is None or chunk_position[1] == 1:
        return "## Document text"
    index, total = chunk_position
    return (
        f"## Document text (fragment {index} of {total} of a longer document; "
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
    parsed = _extract_json_list(raw_response)

    kept: list[Finding] = []
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
        occurrences = source_text.count(old)
        if occurrences != 1:
            logger.warning(
                f"annotation-review: dropping finding, 'old' occurs {occurrences} times "
                f"(expected exactly 1): {old!r}"
            )
            continue
        kept.append({
            "id": len(kept),
            "old": old,
            "new": new,
            "rationale": rationale,
        })
    return kept
