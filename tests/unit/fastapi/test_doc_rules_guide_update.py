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
    OriginalUnavailableError,
    build_update_prompts,
    clean_model_answer,
    gather_guide_change,
    human_section_at_commit,
    layer_text,
)

HUMAN_URL = "https://github.com/o/r/blob/main/docs/guide.md#dates"
MACHINE_URL = "https://github.com/o/r/blob/main/docs/guide-llm.md#dates"
MARKER = "<!-- sync: guide=" + "a" * 64 + " llm=" + "b" * 64 + " base=abc123 -->"
STALE_MARKER = "<!-- sync: guide=" + "c" * 64 + " llm=" + "d" * 64 + " -->"
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
        machine_url=MACHINE_URL,
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
        self.assertEqual(layer_text(kind, HUMAN_URL, store, "alice"), ("override text", "override"))
        store.get_selected_override_text.assert_called_once_with(kind.name, "key", "alice")
        kind.resolve_original.assert_not_called()

    def test_falls_back_to_original(self):
        kind = MagicMock()
        store = MagicMock()
        store.get_selected_override_text.return_value = None
        kind.resolve_original.return_value = "original text"
        self.assertEqual(layer_text(kind, HUMAN_URL, store, "alice"), ("original text", "original"))

    def test_wraps_resolve_original_errors(self):
        kind = MagicMock()
        store = MagicMock()
        store.get_selected_override_text.return_value = None
        kind.resolve_original.side_effect = RuntimeError("boom")
        with self.assertRaisesRegex(OriginalUnavailableError, "boom") as cm:
            layer_text(kind, HUMAN_URL, store, "alice")
        self.assertIsInstance(cm.exception.__cause__, RuntimeError)

    def test_store_errors_are_not_wrapped(self):
        kind = MagicMock()
        store = MagicMock()
        store.get_selected_override_text.side_effect = RuntimeError("db down")
        with self.assertRaises(RuntimeError):
            layer_text(kind, HUMAN_URL, store, "alice")


# ---------------------------------------------------------------------------
# human_section_at_commit


class TestHumanSectionAtCommit(unittest.TestCase):
    def test_fetches_the_anchor_section_at_the_commit(self):
        with patch(f"{MODULE}.fetch_rule_section", return_value="## Dates\n\nOld rule.") as fetch:
            section = human_section_at_commit(HUMAN_URL, "abc123", MagicMock())
        self.assertEqual(section, "## Dates\n\nOld rule.")
        self.assertEqual(fetch.call_args.args[0], "https://github.com/o/r/blob/abc123/docs/guide.md#dates")

    def test_returns_none_when_the_fetch_or_anchor_fails(self):
        with patch(f"{MODULE}.fetch_rule_section", side_effect=RuntimeError("Heading #dates not found")), \
             self.assertLogs(MODULE, level="WARNING"):
            self.assertIsNone(human_section_at_commit(HUMAN_URL, "abc123", MagicMock()))

    def test_returns_none_for_an_unknown_host(self):
        with self.assertLogs(MODULE, level="INFO"):
            self.assertIsNone(human_section_at_commit("https://example.org/guide.md#dates", "abc123", MagicMock()))

    def test_returns_none_without_anchor(self):
        with self.assertLogs(MODULE, level="INFO"):
            self.assertIsNone(human_section_at_commit("https://github.com/o/r/blob/main/docs/guide.md", "abc123", MagicMock()))


# ---------------------------------------------------------------------------
# gather_guide_change


class TestGatherGuideChange(unittest.TestCase):
    def _gather(self, texts: dict[str, tuple[str, str]], synced_commit: Optional[str] = "abc123", old_section: Optional[str] = OLD_HUMAN):
        with patch(f"{MODULE}.layer_text", side_effect=_layer_texts(texts)), \
             patch(f"{MODULE}.find_synced_human_commit", return_value=synced_commit) as find, \
             patch(f"{MODULE}.human_section_at_commit", return_value=old_section) as at_commit:
            change = gather_guide_change(MagicMock(), HUMAN_URL, MACHINE_URL, MagicMock(), "alice", MagicMock())
        return change, find, at_commit

    def test_delta_mode(self):
        texts = {HUMAN_URL: (NEW_HUMAN, "original"), MACHINE_URL: (MACHINE_FULL, "original")}
        change, find, at_commit = self._gather(texts)
        self.assertEqual(change.mode, "delta")
        self.assertEqual(change.old_human, OLD_HUMAN)
        self.assertEqual(change.new_human, NEW_HUMAN)
        self.assertEqual(change.base_commit, "abc123")
        self.assertEqual(find.call_args.args[1], SyncMarker("a" * 64, "b" * 64, "abc123"))
        self.assertEqual(at_commit.call_args.args[:2], (HUMAN_URL, "abc123"))

    def test_machine_is_stripped_of_the_marker_and_the_marker_kept_verbatim(self):
        texts = {HUMAN_URL: (NEW_HUMAN, "original"), MACHINE_URL: (MACHINE_FULL, "original")}
        change, _, _ = self._gather(texts)
        self.assertEqual(change.machine, MACHINE)
        self.assertEqual(change.machine_full, MACHINE_FULL)
        self.assertEqual(change.marker_line, MARKER)

    def test_crlf_machine_text(self):
        texts = {HUMAN_URL: (NEW_HUMAN, "original"), MACHINE_URL: (MACHINE_FULL.replace("\n", "\r\n"), "override")}
        change, _, _ = self._gather(texts)
        self.assertEqual(change.machine, MACHINE)
        self.assertEqual(change.machine_full, MACHINE_FULL)
        self.assertEqual(change.marker_line, MARKER)

    def test_links_are_relative_for_the_prompt_and_absolute_in_machine_full(self):
        absolute = "![i](https://raw.githubusercontent.com/o/r/{ref}/docs/img/a.png)"
        texts = {
            HUMAN_URL: (f"## Dates\n\n{absolute.format(ref='main')}\n", "original"),
            MACHINE_URL: (f"## Dates\n\n{MARKER}\n\n{absolute.format(ref='xyz')}\n", "override"),
        }
        change, _, _ = self._gather(texts, old_section=f"## Dates\n\n{absolute.format(ref='abc123')}\n")
        self.assertEqual(change.old_human, "## Dates\n\n![i](img/a.png)\n")
        self.assertEqual(change.new_human, "## Dates\n\n![i](img/a.png)\n")
        self.assertEqual(change.machine, "## Dates\n\n![i](img/a.png)\n")
        # the form originals and overrides use: absolute against the machine URL's raw directory
        self.assertEqual(change.machine_full, f"## Dates\n\n{MARKER}\n\n{absolute.format(ref='main')}\n")
        self.assertEqual(change.machine_url, MACHINE_URL)

    def test_align_mode_without_marker(self):
        texts = {HUMAN_URL: (NEW_HUMAN, "original"), MACHINE_URL: (MACHINE, "original")}
        change, find, at_commit = self._gather(texts)
        self.assertEqual(change.mode, "align")
        self.assertIsNone(change.old_human)
        self.assertIsNone(change.marker_line)
        self.assertIsNone(change.base_commit)
        self.assertEqual(change.machine, MACHINE)
        find.assert_not_called()
        at_commit.assert_not_called()

    def test_align_mode_when_no_commit_is_found(self):
        texts = {HUMAN_URL: (NEW_HUMAN, "original"), MACHINE_URL: (MACHINE_FULL, "original")}
        change, _, at_commit = self._gather(texts, synced_commit=None)
        self.assertEqual(change.mode, "align")
        self.assertIsNone(change.base_commit)
        self.assertEqual(change.marker_line, MARKER)
        at_commit.assert_not_called()

    def test_align_mode_when_the_section_at_the_commit_is_unavailable(self):
        texts = {HUMAN_URL: (NEW_HUMAN, "original"), MACHINE_URL: (MACHINE_FULL, "original")}
        change, _, _ = self._gather(texts, old_section=None)
        self.assertEqual(change.mode, "align")
        self.assertIsNone(change.base_commit)

    def test_human_override_is_the_new_section(self):
        texts = {HUMAN_URL: ("## Dates\n\nOverridden.\n", "override"), MACHINE_URL: (MACHINE_FULL, "override")}
        change, _, _ = self._gather(texts)
        self.assertEqual(change.new_human, "## Dates\n\nOverridden.\n")
        self.assertEqual(change.human_source, "override")
        self.assertEqual(change.machine_source, "override")


# ---------------------------------------------------------------------------
# build_update_prompts


class TestBuildUpdatePrompts(unittest.TestCase):
    def test_delta_prompt(self):
        system, user = build_update_prompts(_change(), "  Condense.\n")
        self.assertEqual(system, "Condense.")
        self.assertEqual(user, DELTA_TEMPLATE.format(old=OLD_HUMAN, new=NEW_HUMAN, machine=MACHINE))

    def test_align_prompt(self):
        _system, user = build_update_prompts(_change(old_human=None), "Condense.")
        self.assertEqual(user, ALIGN_TEMPLATE.format(new=NEW_HUMAN, machine=MACHINE))

    def test_whitespace_condense_prompt_falls_back_to_default(self):
        system, _user = build_update_prompts(_change(), " \n ")
        self.assertEqual(system, DEFAULT_CONDENSE_PROMPT)

    def test_braces_in_texts_are_kept(self):
        change = GuideChange(
            old_human=None, new_human="{x}", machine="## M\n\n{y}", machine_full="## M\n\n{y}", machine_url=MACHINE_URL,
            marker_line=None, base_commit=None, human_source="original", machine_source="original",
        )
        _system, user = build_update_prompts(change, "Condense.")
        self.assertIn("<guide>\n{x}\n</guide>", user)
        self.assertIn("{y}", user)


# ---------------------------------------------------------------------------
# clean_model_answer


class TestCleanModelAnswer(unittest.TestCase):
    def test_plain_answer_without_marker(self):
        answer = "\n## Dates\n\n- Tag dates with `date` and `@when`.\n\n"
        self.assertEqual(clean_model_answer(answer, _change(marker_line=None)), "## Dates\n\n- Tag dates with `date` and `@when`.")

    def test_marker_is_reinserted_after_the_heading(self):
        answer = "## Dates\n\n\n\n- Tag dates with `date` and `@when`."
        self.assertEqual(clean_model_answer(answer, _change()), f"## Dates\n\n{MARKER}\n\n- Tag dates with `date` and `@when`.")

    def test_marker_with_a_heading_only_answer(self):
        self.assertEqual(clean_model_answer("## Dates", _change()), f"## Dates\n\n{MARKER}")

    def test_echoed_marker_is_not_duplicated(self):
        answer = f"## Dates\n\n{MARKER}\n\n- r"
        self.assertEqual(clean_model_answer(answer, _change()), f"## Dates\n\n{MARKER}\n\n- r")

    def test_stale_markers_are_removed(self):
        answer = f"## Dates\n{STALE_MARKER}\n- r\n\n{STALE_MARKER}\n- s"
        self.assertEqual(clean_model_answer(answer, _change()), f"## Dates\n\n{MARKER}\n\n- r\n\n- s")
        self.assertEqual(clean_model_answer(answer, _change(marker_line=None)), "## Dates\n\n- r\n\n- s")

    def test_markdown_fence_is_removed(self):
        answer = "```markdown\n## Dates\n\n- New rule.\n```"
        self.assertEqual(clean_model_answer(answer, _change(marker_line=None)), "## Dates\n\n- New rule.")

    def test_md_fence_is_removed(self):
        answer = "```md\n## Dates\n\n- New rule.\n```"
        self.assertEqual(clean_model_answer(answer, _change(marker_line=None)), "## Dates\n\n- New rule.")

    def test_bare_fence_is_removed(self):
        answer = "```\n## Dates\n\n- New rule.\n```\n"
        self.assertEqual(clean_model_answer(answer, _change(marker_line=None)), "## Dates\n\n- New rule.")

    def test_markdown_fence_around_inner_code_blocks_is_removed(self):
        answer = "```markdown\n## Dates\n\n```xml\n<date/>\n```\n```"
        self.assertEqual(clean_model_answer(answer, _change(marker_line=None)), "## Dates\n\n```xml\n<date/>\n```")

    def test_crlf_fence_is_removed(self):
        answer = "```markdown\r\n## Dates\r\n\r\n- r\r\n```"
        self.assertEqual(clean_model_answer(answer, _change()), f"## Dates\n\n{MARKER}\n\n- r")

    def test_crlf_plain_answer(self):
        answer = "## Dates\r\n\r\n\r\n- r\r\n- s\r\n"
        self.assertEqual(clean_model_answer(answer, _change()), f"## Dates\n\n{MARKER}\n\n- r\n- s")

    def test_inner_code_blocks_are_kept(self):
        answer = "## Dates\n\n```xml\n<date/>\n```"
        self.assertEqual(clean_model_answer(answer, _change(marker_line=None)), answer)

    def test_bare_fenced_answer_with_inner_fences_is_kept(self):
        answer = "```\na\n```\n\ntext\n\n```\nb\n```"
        self.assertEqual(clean_model_answer(answer, _change(marker_line=None)), "## Dates\n\n" + answer)

    def test_heading_is_prepended_when_missing(self):
        self.assertEqual(clean_model_answer("- New rule.", _change()), f"## Dates\n\n{MARKER}\n\n- New rule.")

    def test_preamble_before_a_later_heading_is_dropped(self):
        answer = "Here are the updated machine rules:\n\n## Dates\n\n- b"
        self.assertEqual(clean_model_answer(answer, _change(marker_line=None)), "## Dates\n\n- b")
        self.assertEqual(clean_model_answer(answer, _change()), f"## Dates\n\n{MARKER}\n\n- b")

    def test_rules_before_a_subsection_are_kept_under_the_machine_heading(self):
        answer = "- rule a\n- rule b\n\n### Sub\n\n- c"
        self.assertEqual(clean_model_answer(answer, _change(marker_line=None)), "## Dates\n\n" + answer)
        self.assertEqual(clean_model_answer(answer, _change()), f"## Dates\n\n{MARKER}\n\n" + answer)

    def test_an_answer_starting_with_a_subsection_gets_the_machine_heading(self):
        answer = "### Sub\n\n- c"
        self.assertEqual(clean_model_answer(answer, _change()), f"## Dates\n\n{MARKER}\n\n" + answer)

    def test_preamble_before_a_shallower_heading_is_dropped(self):
        answer = "Here you go:\n\n# Rules\n\n- b"
        self.assertEqual(clean_model_answer(answer, _change(marker_line=None)), "# Rules\n\n- b")

    def test_heading_like_lines_in_code_blocks_are_not_headings(self):
        answer = "- r\n\n```bash\n# a comment\n```"
        self.assertEqual(clean_model_answer(answer, _change(marker_line=None)), "## Dates\n\n" + answer)

    def test_marker_goes_on_top_without_any_heading(self):
        self.assertEqual(clean_model_answer("- r", _change(machine="- old")), f"{MARKER}\n\n- r")

    def test_relative_links_in_the_proposal_become_absolute(self):
        answer = "## Dates\n\n- See ![i](img/a.png) and [g](../README.md)."
        self.assertEqual(
            clean_model_answer(answer, _change()),
            f"## Dates\n\n{MARKER}\n\n- See ![i](https://raw.githubusercontent.com/o/r/main/docs/img/a.png) and [g](https://raw.githubusercontent.com/o/r/main/README.md).",
        )

    def test_empty_answer_raises(self):
        for answer in ["", "  \n ", "```\n```", "```markdown\n\n```", MARKER, f"```md\n{MARKER}\n```"]:
            with self.subTest(answer=answer), self.assertRaisesRegex(ValueError, "The model returned no machine rules"):
                clean_model_answer(answer, _change())
