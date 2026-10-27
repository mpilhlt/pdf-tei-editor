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
from fastapi_app.lib.doc_rules.guide_sync import _SYNC_RE, find_synced_human_commit, parse_sync_marker
from fastapi_app.lib.doc_rules.interpretation_ref_kind import InterpretationRefKind
from fastapi_app.lib.doc_rules.storage import DocumentRulesStore
from fastapi_app.lib.utils.annotation_rules_utils import fetch_rule_excerpt, markdown_section_range

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
_FENCE_RE = re.compile(r"\A```(?:markdown)?[ \t]*\n(.*?)\n?```\Z", re.DOTALL)
_LEADING_BLANK_LINES_RE = re.compile(r"\A(?:[ \t]*\n)+")


@dataclass(frozen=True)
class GuideChange:
    """The inputs of a machine rules update; see the module docstring."""
    old_human: Optional[str]
    new_human: str
    machine: str  # without the sync marker line
    machine_full: str  # as the user has it, marker line included
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
    Raises whatever `kind.resolve_original()` raises.
    """
    override_text = store.get_selected_override_text(kind.name, kind.resource_key(url), owner)
    if override_text is not None:
        return override_text, "override"
    return kind.resolve_original(url), "original"


def human_section_at_commit(human_url: str, sha: str, cache: UrlCache) -> Optional[str]:
    """The section `human_url`'s heading anchor selects in the file at commit `sha`, or None on any failure (logged)."""
    base_url, _, anchor = human_url.partition("#")
    adapter = GitForgeAdapterRegistry.get_instance().get_adapter_for(base_url)
    if adapter is None or not anchor:
        return None
    try:
        text = fetch_rule_excerpt(adapter.url_at_commit(base_url, sha), cache)
    except Exception as e:
        logger.warning(f"Could not fetch {human_url} at commit {sha}: {e}")
        return None
    range_ = markdown_section_range(text, anchor)
    if range_ is None:
        logger.warning(f"Heading #{anchor} not found in {base_url} at commit {sha}")
        return None
    return "\n".join(text.splitlines()[range_[0] - 1:range_[1]])


def _split_marker(machine_text: str) -> tuple[str, Optional[str]]:
    """`machine_text` without its sync marker line (blank lines at the seam collapsed), and that line verbatim."""
    match = _SYNC_RE.search(machine_text)
    if match is None:
        return machine_text, None
    before = machine_text[:match.start()].rstrip("\n")
    after = _LEADING_BLANK_LINES_RE.sub("", machine_text[match.end():])
    stripped = f"{before}\n\n{after}" if before and after else before or after
    return stripped, match.group(0).rstrip("\n")


def gather_guide_change(
    human_url: str, machine_url: str, store: DocumentRulesStore, owner: str, cache: UrlCache
) -> GuideChange:
    """Collect the inputs of a machine rules update for `owner`. Raises what layer_text() raises."""
    kind = InterpretationRefKind()
    new_human, human_source = layer_text(kind, human_url, store, owner)
    machine_full, machine_source = layer_text(kind, machine_url, store, owner)
    machine, marker_line = _split_marker(machine_full)
    marker = parse_sync_marker(machine_full)
    old_human: Optional[str] = None
    base_commit: Optional[str] = None
    if marker is not None:
        sha = find_synced_human_commit(human_url, marker, cache)
        if sha is not None:
            old_human = human_section_at_commit(human_url, sha, cache)
            if old_human is not None:
                base_commit = sha
    return GuideChange(
        old_human=old_human,
        new_human=new_human,
        machine=machine,
        machine_full=machine_full,
        marker_line=marker_line,
        base_commit=base_commit,
        human_source=human_source,
        machine_source=machine_source,
    )


def build_update_prompts(change: GuideChange, condense_prompt: str) -> tuple[str, str]:
    """The system prompt (`condense_prompt`, else the default) and the user prompt for `change`'s mode."""
    system_prompt = condense_prompt.strip() or DEFAULT_CONDENSE_PROMPT
    if change.old_human is not None:
        user_prompt = DELTA_PROMPT_TEMPLATE.format(old=change.old_human, new=change.new_human, machine=change.machine)
    else:
        user_prompt = ALIGN_PROMPT_TEMPLATE.format(new=change.new_human, machine=change.machine)
    return system_prompt, user_prompt


def clean_model_answer(answer: str, change: GuideChange) -> str:
    """
    The model's answer as machine rules: unwrapped from a surrounding code
    fence, headed by the machine section's heading if it has none, and with
    the original sync marker line re-inserted after the heading.

    Raises:
        ValueError: if nothing is left of the answer.
    """
    text = answer.strip()
    fenced = _FENCE_RE.match(text)
    if fenced is not None and "\n```" not in "\n" + fenced.group(1):
        text = fenced.group(1).strip()
    if not text:
        raise ValueError("The model returned no machine rules")
    if not _HEADING_RE.match(text):
        heading = next((line for line in change.machine.splitlines() if _HEADING_RE.match(line)), None)
        if heading is not None:
            text = f"{heading}\n\n{text}"
    if change.marker_line is None:
        return text
    heading_line, _, rest = text.partition("\n")
    rest = _LEADING_BLANK_LINES_RE.sub("", rest)
    return f"{heading_line}\n\n{change.marker_line}\n\n{rest}" if rest else f"{heading_line}\n\n{change.marker_line}"
