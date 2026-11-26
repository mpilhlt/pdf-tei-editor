"""
Text-only core of the LLM review of OCR errors (#931): numbered lines cut into windows.

The model sees the plain text of a window's lines, numbered with their line ids, and answers with
line corrections:

    [{"line": "0412", "old": "Regel’).", "new": "Regel12).", "rationale": "..."}]

Implausible corrections are dropped (see :func:`parse_corrections`). The adapters (TEI in
`llm_review`, PDF text layer) map the remaining corrections onto their own documents.

Pure module: no FastAPI imports.
"""

from __future__ import annotations

import difflib
import logging
from dataclasses import dataclass

from fastapi_app.lib.llm.base import LLMProvider
from fastapi_app.lib.llm.json_response import extract_json_list
from fastapi_app.lib.llm.review_call import complete_with_retry
from fastapi_app.lib.tei.zone_lines import DEFAULT_CONTEXT_LINES, line_id, line_id_width

logger = logging.getLogger(__name__)

LOG_PREFIX = "ocr-review"

MIN_LETTERS = 3
"""Corrections where `old` or `new` has fewer letters are not checked for letter similarity."""


@dataclass
class ReviewLines:
    """The lines of a document and the windows they are reviewed in."""

    texts: list[str]
    """`texts[i]` is the plain text of global line `i`."""
    windows: list[range]
    """Each window is a range of line indices."""
    languages: list[str]


@dataclass(frozen=True)
class LineCorrection:
    """A plausible correction of a line (0-based index): `old` occurs exactly once in the line's text."""

    line: int
    old: str
    new: str
    rationale: str


# ── Prompts ──────────────────────────────────────────────────────────


def build_system_prompt() -> str:
    """Instructions for finding the OCR errors of a page window."""
    return (
        "You are proofreading the text of a scanned document that was recognized by OCR. You will be given the "
        "document's languages and the lines of one or two of its pages, each as `<id> | <text>`. Lines under a "
        "\"Context\" heading are only shown for orientation: do not correct them.\n\n"
        "Rules:\n"
        "- Correct only OCR misreadings, i.e. text that differs from what is printed on the page. Do not modernize spelling, fix the author's errors, normalize historical orthography, resolve hyphenation or change punctuation that is plausibly in the original.\n"
        "- Check that footnote numbers are consecutive, both the markers in the body text and the numbers at the start of the footnotes, across the pages of the window. Footnote markers in the body are usually superscript and often misread as punctuation or merged with the preceding word; the numbers at the start of the footnotes are usually recognized reliably. Use the sequence on one side to correct gaps and misreadings on the other. Body markers appear in the order of the footnotes on the page.\n"
        "- `old` must be the verbatim text of a whole word or run of words on that line; `new` the corrected form.\n"
        "- When unsure, don't suggest.\n\n"
        "Known OCR confusions: `rn`/`m`, `li`/`h`, `é`/`ö`, digits read as `?!>\"'®™`.\n\n"
        "Respond with ONLY a JSON array (no prose, no markdown fence) of corrections:\n"
        '[{"line": "0412", "old": "…", "new": "…", "rationale": "…"}]\n\n'
        "`line` is the id of the line, `old` must occur exactly once in that line, and `new` must have the same "
        "number of words as `old`. If there are no OCR errors, respond with an empty JSON array: []"
    )


def build_user_prompt(lines: ReviewLines, window: range, position: tuple[int, int]) -> str:
    """The document's languages and the window's lines, with up to 5 context lines before and after it."""
    texts = lines.texts
    width = line_id_width(len(texts))

    def rows(indices: range) -> str:
        return "\n".join(f"{line_id(i, width)} | {texts[i]}".rstrip() for i in indices)

    before = range(max(0, window.start - DEFAULT_CONTEXT_LINES), window.start)
    after = range(window.stop, min(len(texts), window.stop + DEFAULT_CONTEXT_LINES))
    languages = ", ".join(lines.languages) if lines.languages else "unknown"
    index, total = position
    part = f" (part {index} of {total} of the document)" if total > 1 else ""
    sections = [f"## Languages\n\n{languages}"]
    if before:
        sections.append(f"## Context before (do not correct)\n\n{rows(before)}")
    sections.append(f"## Lines to proofread{part}\n\n{rows(window)}")
    if after:
        sections.append(f"## Context after (do not correct)\n\n{rows(after)}")
    return "\n\n".join(sections)


def build_retry_note(dropped: list[str]) -> str:
    """Appended to the user prompt when every correction of a first attempt was dropped."""
    listed = "\n".join(f"- {d}" for d in dropped[:20])
    return (
        "\n\n## Note on a previous attempt\n\n"
        f"A previous review of these lines proposed corrections that were all dropped:\n\n{listed}\n\n"
        "Review the lines again. Use only line ids of the lines to proofread (not of the context), copy `old` "
        "exactly as it appears in the line (same spaces and quote characters), keep the number of words, and "
        "correct only OCR misreadings."
    )


# ── Answers ──────────────────────────────────────────────────────────


def _letters(text: str) -> str:
    return "".join(char for char in text.casefold() if char.isalpha())


def letters_similar(old: str, new: str, min_letter_similarity: float) -> bool:
    """
    Whether a correction is plausible as an OCR fix: the case-folded letters of `old` and `new`
    have a `difflib` ratio of at least `min_letter_similarity`, or one side has fewer than 3 letters.
    """
    a, b = _letters(old), _letters(new)
    if len(a) < MIN_LETTERS or len(b) < MIN_LETTERS:
        return True
    return difflib.SequenceMatcher(None, a, b).ratio() >= min_letter_similarity


def _line_index(value: object) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value - 1
    if isinstance(value, str) and value.strip().isdigit():
        return int(value.strip()) - 1
    return None


def parse_corrections(
    raw: str, lines: ReviewLines, window: range, min_letter_similarity: float
) -> tuple[list[LineCorrection], list[str]]:
    """
    The plausible corrections of an answer and a description of each dropped one: unreadable
    entries, lines outside the window, `old` not occurring exactly once in the line, a different
    number of words, and letters that differ too much. Corrections that change nothing (or only
    whitespace) are ignored without a description.

    Raises:
        UnusableResponseError: the response contains no JSON list.
    """
    items = extract_json_list(raw, LOG_PREFIX)
    width = line_id_width(len(lines.texts))
    kept: list[LineCorrection] = []
    dropped: list[str] = []
    for item in items:
        if not isinstance(item, dict):
            continue
        old, new, rationale = item.get("old"), item.get("new"), item.get("rationale")
        index = _line_index(item.get("line"))
        if index is None or not isinstance(old, str) or not isinstance(new, str):
            dropped.append(f"unreadable: {item!r}"[:200])
            continue
        old, new = old.strip(), new.strip()
        if old.split() == new.split():
            continue
        label = f'line {line_id(index, width) if index >= 0 else item.get("line")}: "{old}" -> "{new}"'
        reason: str | None = None
        if index not in window:
            reason = "line outside the lines to proofread"
        elif not old:
            reason = "empty old text"
        else:
            count = lines.texts[index].count(old)
            if count == 0:
                reason = "old text does not occur in the line"
            elif count > 1:
                reason = "old text occurs more than once in the line"
            elif len(old.split()) != len(new.split()):
                reason = "different number of words"
            elif not letters_similar(old, new, min_letter_similarity):
                reason = "letters differ too much for an OCR misreading"
        if reason is not None:
            dropped.append(f"{label}: {reason}"[:300])
            continue
        kept.append(LineCorrection(index, old, new, rationale if isinstance(rationale, str) else ""))
    return kept, dropped


# ── Review ───────────────────────────────────────────────────────────


async def review_lines_window(
    lines: ReviewLines, index: int, provider: LLMProvider, model_id: str, min_letter_similarity: float
) -> tuple[list[LineCorrection], int, int]:
    """
    Review one window: `(corrections, window count, discarded)`, where `discarded` counts the
    corrections of the (last) answer that were dropped.

    Raises:
        UnusableResponseError: the model's answer contains no JSON list.
        IndexError: there is no window `index`.
    """
    window = lines.windows[index]

    def parse(raw: str) -> tuple[list[LineCorrection], list[str]]:
        kept, dropped = parse_corrections(raw, lines, window, min_letter_similarity)
        logger.info(f"{LOG_PREFIX}: kept {len(kept)} of {len(kept) + len(dropped)} corrections")
        return kept, dropped

    kept, dropped = await complete_with_retry(
        provider,
        model_id,
        build_system_prompt(),
        build_user_prompt(lines, window, (index + 1, len(lines.windows))),
        parse,
        build_retry_note,
        LOG_PREFIX,
    )
    return kept, len(lines.windows), len(dropped)
