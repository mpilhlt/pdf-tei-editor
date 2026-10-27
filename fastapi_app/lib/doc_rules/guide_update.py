"""
Updating a machine rules section from its human guide section (#666, phase 3).

The inputs are the texts the user currently uses (selected override, else the
original): the human section now, the human section at the commit the machine
section was last synced with (see guide_sync.find_synced_human_commit()), and
the machine section without its sync marker. Without a sync base the update
runs in "align" mode, comparing the whole human section with the machine rules.
"""

import logging
import re
from dataclasses import dataclass
from typing import Literal, Optional

from fastapi_app.lib.core.git_forge_adapters import GitForgeAdapterRegistry
from fastapi_app.lib.core.url_cache import UrlCache
from fastapi_app.lib.doc_rules.condense_prompt import DEFAULT_CONDENSE_PROMPT
from fastapi_app.lib.doc_rules.guide_sync import (
    find_synced_human_commit,
    human_section_hash,
    parse_sync_marker,
    split_sync_marker,
)
from fastapi_app.lib.doc_rules.interpretation_ref_kind import InterpretationRefKind
from fastapi_app.lib.doc_rules.storage import DocumentRulesStore
from fastapi_app.lib.utils.annotation_rules_utils import (
    absolutize_markdown_urls,
    derelativize_markdown_urls,
    fetch_rule_section,
)

logger = logging.getLogger(__name__)

LayerSource = Literal["original", "override"]

DELTA_PROMPT_TEMPLATE = """The guide section below changed. Update the machine rules so that they reflect this change and nothing else. Keep the wording, order and format of every part the change does not affect. Return only the updated machine rules as Markdown, starting with their heading, without explanations and without a code fence.

<guide_before>
{old}
</guide_before>

<guide_after>
{new}
</guide_after>

<machine_rules>
{machine}
</machine_rules>"""

ALIGN_PROMPT_TEMPLATE = """Bring the machine rules in line with the guide section below. Keep the wording, order and format of rules that are already correct. Return only the updated machine rules as Markdown, starting with their heading, without explanations and without a code fence.

<guide>
{new}
</guide>

<machine_rules>
{machine}
</machine_rules>"""

_HEADING_RE = re.compile(r"^#{1,6}\s")
_FENCE_RE = re.compile(r"\A(`{3,})(markdown|md)?[ \t]*\n(.*?)\n?\1[ \t]*\Z", re.DOTALL)
_LEADING_BLANK_LINES_RE = re.compile(r"\A(?:[ \t]*\n)+")


class OriginalUnavailableError(Exception):
    """The original text of a layer could not be resolved; the cause is chained."""


@dataclass(frozen=True)
class GuideChange:
    """
    The inputs of a machine rules update; see the module docstring.

    All texts have `\\n` line endings. The texts given to the model
    (`old_human`, `new_human`, `machine`) have same-repository links in
    relative form (derelativize_markdown_urls()), so the ref a text was
    fetched at does not show up as a change. `machine_full` is the machine
    text as the user has it, marker line included, with its links absolute
    against `machine_url` (absolutize_markdown_urls()), the form originals
    and overrides use, so that it renders in the preview. A proposal from
    clean_model_answer() is in the same form, so their diff shows only the
    model's changes.
    """
    old_human: Optional[str]
    new_human: str
    machine: str  # machine_full without the sync marker line, links relative
    machine_full: str
    machine_url: str
    marker_line: Optional[str]
    base_commit: Optional[str]
    human_source: LayerSource
    machine_source: LayerSource

    @property
    def mode(self) -> Literal["delta", "align"]:
        return "delta" if self.old_human is not None else "align"


def layer_text(kind: InterpretationRefKind, url: str, store: DocumentRulesStore, owner: str) -> tuple[str, LayerSource]:
    """
    The text of `owner`'s selected override of `url`, else its original.
    The key is derived leniently (see InterpretationRefKind.resource_key()).

    Raises:
        OriginalUnavailableError: if resolving the original fails. Store
            errors propagate unchanged.
    """
    override_text = store.get_selected_override_text(kind.name, kind.resource_key(url), owner)
    if override_text is not None:
        return override_text, "override"
    try:
        return kind.resolve_original(url), "original"
    except Exception as e:
        raise OriginalUnavailableError(str(e)) from e


def human_section_at_commit(human_url: str, sha: str, cache: UrlCache) -> Optional[str]:
    """The section `human_url`'s heading anchor selects in the file at commit `sha`, or None on any failure (logged)."""
    base_url, _, anchor = human_url.partition("#")
    if not anchor:
        logger.info(f"No heading anchor in {human_url}, cannot fetch its section at commit {sha}")
        return None
    adapter = GitForgeAdapterRegistry.get_instance().get_adapter_for(base_url)
    if adapter is None:
        logger.info(f"No forge adapter handles {base_url}, cannot fetch it at commit {sha}")
        return None
    try:
        return fetch_rule_section(f"{adapter.url_at_commit(base_url, sha)}#{anchor}", cache)
    except Exception as e:
        logger.warning(f"Could not fetch {human_url} at commit {sha}: {e}")
        return None


def _normalized(text: str, url: str) -> str:
    """`text` with `\\n` line endings and its same-repository links relative to `url` (the ref is ignored)."""
    return derelativize_markdown_urls(text.replace("\r\n", "\n"), url)


def gather_guide_change(
    kind: InterpretationRefKind, human_url: str, machine_url: str, store: DocumentRulesStore, owner: str, cache: UrlCache
) -> GuideChange:
    """Collect the inputs of a machine rules update for `owner`. Raises what layer_text() raises."""
    new_human, human_source = layer_text(kind, human_url, store, owner)
    machine_text, machine_source = layer_text(kind, machine_url, store, owner)
    machine_text = _normalized(machine_text, machine_url)
    machine, marker_line = split_sync_marker(machine_text)
    marker = parse_sync_marker(machine_text)
    old_human: Optional[str] = None
    base_commit: Optional[str] = None
    if marker is not None:
        sha = find_synced_human_commit(human_url, marker, cache)
        if sha is not None:
            old_human = human_section_at_commit(human_url, sha, cache)
            if old_human is not None:
                # derelativize_markdown_urls() ignores the ref, so human_url serves as base for the commit's text
                old_human = _normalized(old_human, human_url)
                base_commit = sha
    return GuideChange(
        old_human=old_human,
        new_human=_normalized(new_human, human_url),
        machine=machine,
        machine_full=absolutize_markdown_urls(machine_text, machine_url),
        machine_url=machine_url,
        marker_line=marker_line,
        base_commit=base_commit,
        human_source=human_source,
        machine_source=machine_source,
    )


def guide_unchanged(change: GuideChange, human_url: str) -> bool:
    """Whether the human section is the one the machine section was synced with; always False in align mode."""
    return change.old_human is not None and human_section_hash(change.old_human, human_url) == human_section_hash(change.new_human, human_url)


def build_update_prompts(change: GuideChange, condense_prompt: str) -> tuple[str, str]:
    """The system prompt (`condense_prompt`, else the default) and the user prompt for `change`'s mode."""
    system_prompt = condense_prompt.strip() or DEFAULT_CONDENSE_PROMPT
    if change.old_human is not None:
        user_prompt = DELTA_PROMPT_TEMPLATE.format(old=change.old_human, new=change.new_human, machine=change.machine)
    else:
        user_prompt = ALIGN_PROMPT_TEMPLATE.format(new=change.new_human, machine=change.machine)
    return system_prompt, user_prompt


def _unfenced(text: str) -> str:
    """
    The content of `text` if it is one fenced code block. A fence tagged
    `markdown`/`md` is always a wrapper; a bare fence is one only if no
    inner line opens another block with it.
    """
    match = _FENCE_RE.match(text)
    if match is None:
        return text
    fence, tag, body = match.groups()
    if tag is None and any(line.startswith(fence) for line in body.splitlines()):
        return text
    return body.strip()


def _first_heading_index(lines: list[str]) -> Optional[int]:
    """The index of the first Markdown heading line outside fenced code blocks, or None."""
    fence: Optional[str] = None
    for index, line in enumerate(lines):
        stripped = line.lstrip()
        if fence is None:
            if stripped.startswith(("```", "~~~")):
                fence = stripped[:3]
            elif _HEADING_RE.match(line):
                return index
        elif stripped.startswith(fence):
            fence = None
    return None


def _heading_level(line: str) -> int:
    """The level of the Markdown heading `line`."""
    return len(line) - len(line.lstrip("#"))


def clean_model_answer(answer: str, change: GuideChange) -> str:
    """
    The model's answer as machine rules: with `\\n` line endings, unwrapped
    from a surrounding code fence, without any sync marker it contains,
    without a preamble before a heading at the machine section's heading
    level or above, else headed by the machine section's heading (an answer
    whose first heading is deeper is the section's body), with the
    original sync marker line inserted after the heading (on top if there is
    no heading), and with relative links made absolute against
    `change.machine_url`, the form of `change.machine_full`.

    Raises:
        ValueError: if nothing is left of the answer.
    """
    text = _unfenced(answer.replace("\r\n", "\n").strip())
    marker_line: Optional[str] = ""
    while marker_line is not None:
        text, marker_line = split_sync_marker(text)
    text = text.strip()
    if not text:
        raise ValueError("The model returned no machine rules")
    lines = text.split("\n")
    heading_index = _first_heading_index(lines)
    machine_heading = next((line for line in change.machine.splitlines() if _HEADING_RE.match(line)), None)
    if heading_index is not None and machine_heading is not None and _heading_level(lines[heading_index]) <= _heading_level(machine_heading):
        # what precedes a heading at the machine section's level (or above) is a preamble
        text = "\n".join(lines[heading_index:])
    elif machine_heading is not None:
        # no heading, or a subsection first: the answer is the section's body
        text = f"{machine_heading}\n\n{text}"
    if change.marker_line is not None:
        if not _HEADING_RE.match(text):
            text = f"{change.marker_line}\n\n{text}"
        else:
            heading_line, _, rest = text.partition("\n")
            rest = _LEADING_BLANK_LINES_RE.sub("", rest)
            text = f"{heading_line}\n\n{change.marker_line}\n\n{rest}" if rest else f"{heading_line}\n\n{change.marker_line}"
    return absolutize_markdown_urls(text, change.machine_url)
