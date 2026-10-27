"""
Tests for fastapi_app/lib/doc_rules/guide_update.py: gathering the guide
change of a human/machine pair, the update prompts, and the cleanup of the
model's answer.
"""

import unittest
from typing import Optional
from unittest.mock import MagicMock, patch

from fastapi_app.lib.doc_rules.condense_prompt import DEFAULT_CONDENSE_PROMPT
from fastapi_app.lib.doc_rules.guide_sync import SyncMarker
from fastapi_app.lib.doc_rules.guide_update import (
    GuideChange,
    build_update_prompts,
    clean_model_answer,
    gather_guide_change,
    human_section_at_commit,
    layer_text,
)

HUMAN_URL = "https://github.com/o/r/blob/main/docs/guide.md#dates"
MACHINE_URL = "https://github.com/o/r/blob/main/docs/guide-llm.md#dates"
MARKER = "<!-- sync: guide=" + "a" * 64 + " llm=" + "b" * 64 + " base=abc123 -->"
MACHINE_FULL = f"## Dates\n\n{MARKER}\n\n- Tag dates with `date`.\n"
MACHINE = "## Dates\n\n- Tag dates with `date`.\n"
OLD_HUMAN = "## Dates\n\nDates are tagged.\n"
NEW_HUMAN = "## Dates\n\nDates are tagged with `@when`.\n"

DELTA_TEMPLATE = """The guide section below changed. Update the machine rules so that they reflect this change and nothing else. Keep the wording, order and format of every part the change does not affect. Return only the updated machine rules as Markdown, starting with their heading, without explanations and without a code fence.

<guide_before>
{old}
</guide_before>

<guide_after>
{new}
</guide_after>

<machine_rules>
{machine}
</machine_rules>"""

ALIGN_TEMPLATE = """Bring the machine rules in line with the guide section below. Keep the wording, order and format of rules that are already correct. Return only the updated machine rules as Markdown, starting with their heading, without explanations and without a code fence.

<guide>
{new}
</guide>

<machine_rules>
{machine}
</machine_rules>"""

MODULE = "fastapi_app.lib.doc_rules.guide_update"


def _change(old_human: Optional[str] = OLD_HUMAN, machine: str = MACHINE, marker_line: Optional[str] = MARKER) -> GuideChange:
    return GuideChange(
        old_human=old_human,
        new_human=NEW_HUMAN,
        machine=machine,
        machine_full=MACHINE_FULL,
        marker_line=marker_line,
        base_commit="abc123" if old_human is not None else None,
        human_source="original",
        machine_source="original",
    )


def _layer_texts(texts: dict[str, tuple[str, str]]):
    return lambda kind, url, store, owner: texts[url]


# ---------------------------------------------------------------------------
# layer_text


class TestLayerText(unittest.TestCase):
    def test_returns_selected_override(self):
        kind = MagicMock()
        kind.resource_key.return_value = "key"
        store = MagicMock()
        store.get_selected_override_text.return_value = "override text"
        assert layer_text(kind, HUMAN_URL, store, "alice") == ("override text", "override")
        store.get_selected_override_text.assert_called_once_with(kind.name, "key", "alice")
        kind.resolve_original.assert_not_called()

    def test_falls_back_to_original(self):
        kind = MagicMock()
        store = MagicMock()
        store.get_selected_override_text.return_value = None
        kind.resolve_original.return_value = "original text"
        assert layer_text(kind, HUMAN_URL, store, "alice") == ("original text", "original")

    def test_propagates_resolve_original_errors(self):
        kind = MagicMock()
        store = MagicMock()
        store.get_selected_override_text.return_value = None
        kind.resolve_original.side_effect = RuntimeError("boom")
        with self.assertRaisesRegex(RuntimeError, "boom"):
            layer_text(kind, HUMAN_URL, store, "alice")


# ---------------------------------------------------------------------------
# human_section_at_commit


class TestHumanSectionAtCommit(unittest.TestCase):
    def test_slices_the_anchor_section_of_the_file_at_the_commit(self):
        file_text = "# Guide\n\n## Dates\n\nOld rule.\n\n## Names\n\nOther.\n"
        with patch(f"{MODULE}.fetch_rule_excerpt", return_value=file_text) as fetch:
            section = human_section_at_commit(HUMAN_URL, "abc123", MagicMock())
        assert section == "## Dates\n\nOld rule.\n"
        assert fetch.call_args.args[0] == "https://github.com/o/r/blob/abc123/docs/guide.md"

    def test_returns_none_when_the_anchor_is_missing(self):
        with patch(f"{MODULE}.fetch_rule_excerpt", return_value="# Guide\n\nNothing.\n"), \
             self.assertLogs(MODULE, level="WARNING"):
            assert human_section_at_commit(HUMAN_URL, "abc123", MagicMock()) is None

    def test_returns_none_when_the_fetch_fails(self):
        with patch(f"{MODULE}.fetch_rule_excerpt", side_effect=RuntimeError("down")), \
             self.assertLogs(MODULE, level="WARNING"):
            assert human_section_at_commit(HUMAN_URL, "abc123", MagicMock()) is None

    def test_returns_none_for_an_unknown_host(self):
        assert human_section_at_commit("https://example.org/guide.md#dates", "abc123", MagicMock()) is None


# ---------------------------------------------------------------------------
# gather_guide_change


class TestGatherGuideChange(unittest.TestCase):
    def _gather(self, texts: dict[str, tuple[str, str]], synced_commit: Optional[str] = "abc123", old_section: Optional[str] = OLD_HUMAN):
        with patch(f"{MODULE}.layer_text", side_effect=_layer_texts(texts)), \
             patch(f"{MODULE}.find_synced_human_commit", return_value=synced_commit) as find, \
             patch(f"{MODULE}.human_section_at_commit", return_value=old_section) as at_commit:
            change = gather_guide_change(HUMAN_URL, MACHINE_URL, MagicMock(), "alice", MagicMock())
        return change, find, at_commit

    def test_delta_mode(self):
        texts = {HUMAN_URL: (NEW_HUMAN, "original"), MACHINE_URL: (MACHINE_FULL, "original")}
        change, find, at_commit = self._gather(texts)
        assert change.mode == "delta"
        assert change.old_human == OLD_HUMAN
        assert change.new_human == NEW_HUMAN
        assert change.base_commit == "abc123"
        assert find.call_args.args[1] == SyncMarker("a" * 64, "b" * 64, "abc123")
        assert at_commit.call_args.args[:2] == (HUMAN_URL, "abc123")

    def test_machine_is_stripped_of_the_marker_and_the_marker_kept_verbatim(self):
        texts = {HUMAN_URL: (NEW_HUMAN, "original"), MACHINE_URL: (MACHINE_FULL, "original")}
        change, _, _ = self._gather(texts)
        assert change.machine == MACHINE
        assert change.machine_full == MACHINE_FULL
        assert change.marker_line == MARKER

    def test_align_mode_without_marker(self):
        texts = {HUMAN_URL: (NEW_HUMAN, "original"), MACHINE_URL: (MACHINE, "original")}
        change, find, at_commit = self._gather(texts)
        assert change.mode == "align"
        assert change.old_human is None
        assert change.marker_line is None
        assert change.base_commit is None
        assert change.machine == MACHINE
        find.assert_not_called()
        at_commit.assert_not_called()

    def test_align_mode_when_no_commit_is_found(self):
        texts = {HUMAN_URL: (NEW_HUMAN, "original"), MACHINE_URL: (MACHINE_FULL, "original")}
        change, _, at_commit = self._gather(texts, synced_commit=None)
        assert change.mode == "align"
        assert change.base_commit is None
        assert change.marker_line == MARKER
        at_commit.assert_not_called()

    def test_align_mode_when_the_section_at_the_commit_is_unavailable(self):
        texts = {HUMAN_URL: (NEW_HUMAN, "original"), MACHINE_URL: (MACHINE_FULL, "original")}
        change, _, _ = self._gather(texts, old_section=None)
        assert change.mode == "align"
        assert change.base_commit is None

    def test_human_override_is_the_new_section(self):
        texts = {HUMAN_URL: ("## Dates\n\nOverridden.\n", "override"), MACHINE_URL: (MACHINE_FULL, "override")}
        change, _, _ = self._gather(texts)
        assert change.new_human == "## Dates\n\nOverridden.\n"
        assert change.human_source == "override"
        assert change.machine_source == "override"


# ---------------------------------------------------------------------------
# build_update_prompts


class TestBuildUpdatePrompts(unittest.TestCase):
    def test_delta_prompt(self):
        system, user = build_update_prompts(_change(), "  Condense.\n")
        assert system == "Condense."
        assert user == DELTA_TEMPLATE.format(old=OLD_HUMAN, new=NEW_HUMAN, machine=MACHINE)

    def test_align_prompt(self):
        _system, user = build_update_prompts(_change(old_human=None), "Condense.")
        assert user == ALIGN_TEMPLATE.format(new=NEW_HUMAN, machine=MACHINE)

    def test_whitespace_condense_prompt_falls_back_to_default(self):
        system, _user = build_update_prompts(_change(), " \n ")
        assert system == DEFAULT_CONDENSE_PROMPT

    def test_braces_in_texts_are_kept(self):
        change = GuideChange(
            old_human=None, new_human="{x}", machine="## M\n\n{y}", machine_full="## M\n\n{y}",
            marker_line=None, base_commit=None, human_source="original", machine_source="original",
        )
        _system, user = build_update_prompts(change, "Condense.")
        assert "<guide>\n{x}\n</guide>" in user
        assert "{y}" in user


# ---------------------------------------------------------------------------
# clean_model_answer


class TestCleanModelAnswer(unittest.TestCase):
    def test_plain_answer_without_marker(self):
        answer = "\n## Dates\n\n- Tag dates with `date` and `@when`.\n\n"
        assert clean_model_answer(answer, _change(marker_line=None)) == "## Dates\n\n- Tag dates with `date` and `@when`."

    def test_marker_is_reinserted_after_the_heading(self):
        answer = "## Dates\n\n\n\n- Tag dates with `date` and `@when`."
        assert clean_model_answer(answer, _change()) == f"## Dates\n\n{MARKER}\n\n- Tag dates with `date` and `@when`."

    def test_marker_with_a_heading_only_answer(self):
        assert clean_model_answer("## Dates", _change()) == f"## Dates\n\n{MARKER}"

    def test_markdown_fence_is_removed(self):
        answer = "```markdown\n## Dates\n\n- New rule.\n```"
        assert clean_model_answer(answer, _change(marker_line=None)) == "## Dates\n\n- New rule."

    def test_bare_fence_is_removed(self):
        answer = "```\n## Dates\n\n- New rule.\n```\n"
        assert clean_model_answer(answer, _change(marker_line=None)) == "## Dates\n\n- New rule."

    def test_inner_code_blocks_are_kept(self):
        answer = "## Dates\n\n```xml\n<date/>\n```"
        assert clean_model_answer(answer, _change(marker_line=None)) == answer

    def test_answer_that_is_not_one_fenced_block_is_kept(self):
        answer = "```\na\n```\n\ntext\n\n```\nb\n```"
        assert clean_model_answer(answer, _change(marker_line=None)) == "## Dates\n\n" + answer

    def test_heading_is_prepended_when_missing(self):
        answer = "- New rule."
        assert clean_model_answer(answer, _change()) == f"## Dates\n\n{MARKER}\n\n- New rule."

    def test_empty_answer_raises(self):
        for answer in ["", "  \n ", "```\n```", "```markdown\n\n```"]:
            with self.subTest(answer=answer), self.assertRaisesRegex(ValueError, "The model returned no machine rules"):
                clean_model_answer(answer, _change())
