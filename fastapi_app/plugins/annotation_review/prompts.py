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

_CODE_FENCE_RE = re.compile(r"^```(?:json)?\s*\n?(.*?)\n?```$", re.DOTALL)

_REQUIRED_KEYS = ("old", "new", "rationale")


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


def build_user_prompt(rule_excerpts: list[tuple[str, str]], text_content: str) -> str:
    """
    Combine every (category, excerpt) pair with the document's <text> content
    into a single prompt.
    """
    sections = []
    for category, excerpt in rule_excerpts:
        sections.append(f"## Rule category: {category}\n\n{excerpt}")
    rules_block = "\n\n".join(sections)
    return (
        f"{rules_block}\n\n"
        f"## Document text\n\n{text_content}"
    )


def parse_and_validate_findings(raw_response: str, source_text: str) -> list[Finding]:
    """
    Parse the LLM's JSON array response and keep only findings whose "old"
    occurs exactly once in source_text — the primary defense against
    hallucinated or under-specified findings. Malformed JSON, a non-list
    response, a finding missing a required key, or a finding whose "old",
    "new", or "rationale" is not a string is dropped (logged), never raised:
    a partially-bad response still yields whatever findings are trustworthy.
    Kept findings are assigned a sequential integer "id" (0-based, over the
    kept findings only, in response order).
    """
    text = raw_response.strip()
    fence_match = _CODE_FENCE_RE.match(text)
    if fence_match:
        text = fence_match.group(1).strip()

    try:
        parsed = json.loads(text)
    except json.JSONDecodeError as e:
        logger.warning(f"annotation-review: could not parse LLM response as JSON: {e}")
        return []

    if not isinstance(parsed, list):
        logger.warning("annotation-review: LLM response JSON was not a list, dropping")
        return []

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
