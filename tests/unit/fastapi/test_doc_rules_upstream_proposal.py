"""
Tests for fastapi_app/lib/doc_rules/upstream_proposal.py: building the
upstream patch of a user's document rules, against real fossil guideline
files as the default-branch files.

@testCovers fastapi_app/lib/doc_rules/upstream_proposal.py
"""

import difflib
import hashlib
import shutil
import subprocess
import tempfile
import unittest
from contextlib import ExitStack
from pathlib import Path
from typing import Optional
from unittest.mock import MagicMock, patch

from fastapi_app.lib.core.git_forge_adapters import GitHubAdapter
from fastapi_app.lib.doc_rules.guide_sync import parse_sync_marker, sync_status
from fastapi_app.lib.doc_rules.upstream_proposal import (
    ProposalError,
    ProposedFile,
    UpstreamProposal,
    build_patch,
    build_upstream_proposal,
    patch_filename,
    section_anchor,
)
from fastapi_app.lib.utils.annotation_rules_utils import (
    RuleFetchError,
    _rewrite_relative_markdown_urls,
    markdown_section_range,
)

MODULE = "fastapi_app.lib.doc_rules.upstream_proposal"
FIXTURES = Path(__file__).parent / "fixtures" / "fossil"
HUMAN_FILE = (FIXTURES / "guidelines.md").read_text(encoding="utf-8")
MACHINE_FILE = (FIXTURES / "guidelines-llm.md").read_text(encoding="utf-8")
SHA = "eab669d4d093c54dd1990b4a0bf017d00f82d5a8"
REPO = "https://github.com/mpilhlt/fossil/blob"
HUMAN_URL = f"{REPO}/{SHA}/docs/guidelines.md#data-correction"
MACHINE_URL = f"{REPO}/{SHA}/docs/guidelines-llm.md#L17-L25"  # the "Data correction" machine section
HUMAN_MAIN = f"{REPO}/main/docs/guidelines.md"
MACHINE_MAIN = f"{REPO}/main/docs/guidelines-llm.md"
RAW_DIR_URL = f"https://raw.githubusercontent.com/mpilhlt/fossil/{SHA}/docs/"


def _slice(text: str, anchor: str) -> str:
    range_ = markdown_section_range(text, anchor)
    assert range_ is not None, anchor
    return "\n".join(text.splitlines()[range_[0] - 1:range_[1]])


def _served(text: str) -> str:
    """`text` as core serves it: relative links made absolute (see fetch_rule_excerpt())."""
    return _rewrite_relative_markdown_urls(text, RAW_DIR_URL)


def _edited(section: str, old: str, new: str) -> str:
    assert old in section, old
    return section.replace(old, new, 1)


class _Fixture:
    """Patches the fetches and builds a proposal from overrides keyed by URL."""

    def __init__(self, human_main: str = HUMAN_FILE, machine_main: str = MACHINE_FILE) -> None:
        self.main_files = {HUMAN_MAIN: human_main, MACHINE_MAIN: machine_main}
        self.fetched: list[str] = []
        self.default_branch_effect: Optional[BaseException] = None

    def _fetch_raw(self, url: str) -> str:
        self.fetched.append(url)
        return self.main_files[url]

    def build(
        self,
        overrides: dict[str, str],
        include_human: bool = True,
        include_machine: bool = True,
        human_url: str = HUMAN_URL,
        machine_url: str = MACHINE_URL,
        label: str = "Data correction",
    ) -> UpstreamProposal:
        originals = {
            human_url: _served(_slice(HUMAN_FILE, "data-correction")),
            machine_url: _served(_slice(MACHINE_FILE, "data-correction")),
        }
        kind = MagicMock()
        kind.name = "interpretation-ref"
        kind.resource_key.side_effect = lambda url: url
        kind.resolve_original.side_effect = lambda url: originals[url]
        store = MagicMock()

        def selected(kind_name: str, key: str, owner: str) -> Optional[str]:
            assert owner == "alice"
            return overrides.get(key)

        store.get_selected_override_text.side_effect = selected
        with ExitStack() as stack:
            stack.enter_context(patch(f"{MODULE}._fetch_raw_file", side_effect=self._fetch_raw))
            stack.enter_context(patch(f"{MODULE}.fetch_rule_excerpt", return_value=_served(MACHINE_FILE)))
            if self.default_branch_effect is None:
                stack.enter_context(patch.object(GitHubAdapter, "_default_branch", return_value="main"))
            else:
                stack.enter_context(patch.object(GitHubAdapter, "_default_branch", side_effect=self.default_branch_effect))
            return build_upstream_proposal(kind, human_url, machine_url, include_human, include_machine, store, "alice", label, MagicMock())


def _changed_lines(before: str, after: str) -> list[str]:
    return sorted(line for line in difflib.ndiff(before.splitlines(), after.splitlines()) if line[:2] in ("- ", "+ "))


HUMAN_SECTION = _served(_slice(HUMAN_FILE, "data-correction"))
MACHINE_SECTION = _served(_slice(MACHINE_FILE, "data-correction"))
HUMAN_EDIT = _edited(HUMAN_SECTION, "## Data correction\n", "## Data correction\n\nA new guide rule.\n")
MACHINE_LINES = MACHINE_SECTION.splitlines()
MACHINE_EDIT = "\n".join(MACHINE_LINES[:4] + ["- A new machine rule."] + MACHINE_LINES[4:])


class TestBuildUpstreamProposal(unittest.TestCase):
    def _assert_in_sync(self, human_after: str, machine_after: str) -> None:
        human = _slice(human_after, "data-correction")
        machine = _slice(machine_after, "data-correction")
        self.assertEqual(sync_status(human, machine, HUMAN_URL, MACHINE_URL), "in_sync")

    def test_human_only(self) -> None:
        fixture = _Fixture()
        proposal = fixture.build({HUMAN_URL: HUMAN_EDIT}, include_machine=False)
        self.assertEqual([f.path for f in proposal.files], ["docs/guidelines.md"])
        self.assertEqual(_changed_lines(HUMAN_FILE, proposal.files[0].after), ["+ ", "+ A new guide rule."])
        self.assertNotIn(MACHINE_MAIN, fixture.fetched)
        self.assertNotIn("guidelines-llm.md", proposal.patch)
        self.assertEqual(proposal.branch, "main")
        self.assertIn("# Includes: guide section\n", proposal.patch)

    def test_machine_only_recomputes_the_marker(self) -> None:
        proposal = _Fixture().build({MACHINE_URL: MACHINE_EDIT}, include_human=False)
        self.assertEqual([f.path for f in proposal.files], ["docs/guidelines-llm.md"])
        after = proposal.files[0].after
        section = _slice(after, "data-correction").split("\n")
        self.assertEqual(section[0], "## Data correction")
        self.assertEqual(section[1], "")
        self.assertIsNotNone(parse_sync_marker(section[2]))
        self.assertEqual(section[3], "")
        self.assertEqual(after.count("<!-- sync:"), MACHINE_FILE.count("<!-- sync:"))
        self._assert_in_sync(HUMAN_FILE, after)
        self.assertIn("# Includes: machine rules\n", proposal.patch)

    def test_both_layers(self) -> None:
        proposal = _Fixture().build({HUMAN_URL: HUMAN_EDIT, MACHINE_URL: MACHINE_EDIT})
        self.assertEqual([f.path for f in proposal.files], ["docs/guidelines.md", "docs/guidelines-llm.md"])
        self._assert_in_sync(proposal.files[0].after, proposal.files[1].after)
        patch_text = proposal.patch
        self.assertLess(patch_text.index("diff --git a/docs/guidelines.md"), patch_text.index("diff --git a/docs/guidelines-llm.md"))
        self.assertTrue(patch_text.startswith(
            "# Annotation rules update: Data correction\n# Proposed with the PDF-TEI-Editor by alice\n# Includes: guide section and machine rules\n"
        ))
        self.assertEqual(proposal.filename, "data-correction-rules.patch")

    def test_human_only_change_with_machine_selected_marks_machine_in_sync(self) -> None:
        # The machine text is unchanged, but its marker must now record the new guide hash
        proposal = _Fixture().build({HUMAN_URL: HUMAN_EDIT})
        self.assertEqual(len(proposal.files), 2)
        self._assert_in_sync(proposal.files[0].after, proposal.files[1].after)

    def test_absolute_same_repo_links_become_relative(self) -> None:
        anchor = "document-segmentation-model"
        human_url = f"{REPO}/{SHA}/docs/guidelines.md#{anchor}"
        section = _served(_slice(HUMAN_FILE, anchor))
        self.assertIn(f"{RAW_DIR_URL}img/note-place-headnote.png", section)
        override = _edited(section, "### Tags\n", "### Tags\n\nA new guide rule.\n")
        proposal = _Fixture().build({human_url: override}, include_machine=False, human_url=human_url)
        after = proposal.files[0].after
        self.assertIn("](img/note-place-headnote.png)", after)
        self.assertNotIn("raw.githubusercontent.com", after)
        self.assertEqual(_changed_lines(HUMAN_FILE, after), ["+ ", "+ A new guide rule."])

    def test_moved_upstream_sections_are_found_by_anchor(self) -> None:
        extra = "Inserted upstream.\n\nAnother inserted line.\n\n"
        human_main = HUMAN_FILE.replace("## General strategy\n", f"{extra}## General strategy\n", 1)
        machine_main = MACHINE_FILE.replace("## Data correction\n", f"## Preface\n\n{extra}## Data correction\n", 1)
        proposal = _Fixture(human_main, machine_main).build({HUMAN_URL: HUMAN_EDIT, MACHINE_URL: MACHINE_EDIT})
        human_after, machine_after = proposal.files[0].after, proposal.files[1].after
        self.assertEqual(_changed_lines(human_main, human_after), ["+ ", "+ A new guide rule."])
        self.assertIn(f"## Preface\n\n{extra}## Data correction\n\n<!-- sync:", machine_after)
        self.assertIn("- A new machine rule.", _slice(machine_after, "data-correction"))
        self._assert_in_sync(human_after, machine_after)

    def test_line_range_not_at_a_heading_raises(self) -> None:
        machine_url = f"{REPO}/{SHA}/docs/guidelines-llm.md#L18-L25"
        with self.assertRaises(ProposalError):
            _Fixture().build({machine_url: MACHINE_EDIT}, machine_url=machine_url)

    def test_different_repositories(self) -> None:
        machine_url = f"https://github.com/other/repo/blob/{SHA}/docs/guidelines-llm.md#L17-L25"
        with self.assertRaises(ProposalError) as raised:
            _Fixture().build({}, machine_url=machine_url)
        self.assertEqual(str(raised.exception), "The guide and the machine rules are in different repositories; propose them separately.")

    def test_same_repo_id_on_another_forge_is_a_different_repository(self) -> None:
        machine_url = f"https://gitlab.com/mpilhlt/fossil/-/blob/{SHA}/docs/guidelines-llm.md#L17-L25"
        with self.assertRaises(ProposalError) as raised:
            _Fixture().build({}, machine_url=machine_url)
        self.assertEqual(str(raised.exception), "The guide and the machine rules are in different repositories; propose them separately.")

    def test_base_hashes_are_of_the_default_branch_files(self) -> None:
        proposal = _Fixture().build({HUMAN_URL: HUMAN_EDIT, MACHINE_URL: MACHINE_EDIT})
        self.assertEqual(proposal.base_hashes, {
            "docs/guidelines.md": hashlib.sha256(HUMAN_FILE.encode("utf-8")).hexdigest(),
            "docs/guidelines-llm.md": hashlib.sha256(MACHINE_FILE.encode("utf-8")).hexdigest(),
        })

    def test_different_repositories_do_not_matter_for_human_only(self) -> None:
        machine_url = f"https://github.com/other/repo/blob/{SHA}/docs/guidelines-llm.md#L17-L25"
        proposal = _Fixture().build({HUMAN_URL: HUMAN_EDIT}, include_machine=False, machine_url=machine_url)
        self.assertEqual(len(proposal.files), 1)

    def test_no_selection(self) -> None:
        with self.assertRaises(ProposalError) as raised:
            _Fixture().build({}, include_human=False, include_machine=False)
        self.assertEqual(str(raised.exception), "Select at least one of the guide section and the machine rules.")

    def test_no_changes(self) -> None:
        for include_human, include_machine in [(True, False), (False, True), (True, True)]:
            with self.subTest(include_human=include_human, include_machine=include_machine), self.assertRaises(ProposalError) as raised:
                _Fixture().build({}, include_human=include_human, include_machine=include_machine)
            self.assertEqual(str(raised.exception), "There are no changes to propose.")

    def test_missing_anchor_upstream(self) -> None:
        human_main = HUMAN_FILE.replace("## Data correction\n", "## Correcting data\n", 1)
        for include_human, include_machine in [(True, False), (False, True)]:
            with self.subTest(include_human=include_human), self.assertRaises(ProposalError) as raised:
                _Fixture(human_main=human_main).build({HUMAN_URL: HUMAN_EDIT, MACHINE_URL: MACHINE_EDIT}, include_human, include_machine)
            self.assertEqual(str(raised.exception), 'The section "data-correction" no longer exists in docs/guidelines.md on main.')
        machine_main = MACHINE_FILE.replace("## Data correction\n", "## Correcting data\n", 1)
        with self.assertRaises(ProposalError) as raised:
            _Fixture(machine_main=machine_main).build({MACHINE_URL: MACHINE_EDIT}, include_human=False)
        self.assertEqual(str(raised.exception), 'The section "data-correction" no longer exists in docs/guidelines-llm.md on main.')

    @unittest.skipIf(shutil.which("git") is None, "git is not on PATH")
    def test_golden_patch_applies_with_git(self) -> None:
        proposal = _Fixture().build({HUMAN_URL: HUMAN_EDIT, MACHINE_URL: MACHINE_EDIT})
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            subprocess.run(["git", "init", "-q"], cwd=root, check=True)
            (root / "docs").mkdir()
            (root / "docs" / "guidelines.md").write_text(HUMAN_FILE, encoding="utf-8", newline="")
            (root / "docs" / "guidelines-llm.md").write_text(MACHINE_FILE, encoding="utf-8", newline="")
            (root / "rules.patch").write_text(proposal.patch, encoding="utf-8", newline="")
            subprocess.run(["git", "apply", "--check", "rules.patch"], cwd=root, check=True, capture_output=True)
            subprocess.run(["git", "apply", "rules.patch"], cwd=root, check=True, capture_output=True)
            for file in proposal.files:
                self.assertEqual((root / file.path).read_text(encoding="utf-8"), file.after)


HUMAN_SENTENCE = "etc. Therefore, **never** correct mistakes in the text — leave everything as it is."
MACHINE_RULE = "- `<lb/>` is part of the text stream: never move or remove it."


class TestUpstreamChanged(unittest.TestCase):
    def _upstream(self) -> _Fixture:
        human_main = HUMAN_FILE.replace(HUMAN_SENTENCE, f"{HUMAN_SENTENCE} Changed upstream.", 1)
        machine_main = MACHINE_FILE.replace(MACHINE_RULE, f"{MACHINE_RULE} Changed upstream.", 1)
        return _Fixture(human_main, machine_main)

    def test_unchanged_upstream(self) -> None:
        proposal = _Fixture().build({HUMAN_URL: HUMAN_EDIT, MACHINE_URL: MACHINE_EDIT})
        self.assertEqual(proposal.upstream_changed, [])

    def test_changed_upstream_sections_of_included_layers(self) -> None:
        proposal = self._upstream().build({HUMAN_URL: HUMAN_EDIT, MACHINE_URL: MACHINE_EDIT})
        self.assertEqual(proposal.upstream_changed, ["docs/guidelines.md", "docs/guidelines-llm.md"])
        self.assertNotIn("Changed upstream.", proposal.files[0].after)
        self.assertEqual(self._upstream().build({HUMAN_URL: HUMAN_EDIT}, include_machine=False).upstream_changed, ["docs/guidelines.md"])
        self.assertEqual(self._upstream().build({MACHINE_URL: MACHINE_EDIT}, include_human=False).upstream_changed, ["docs/guidelines-llm.md"])

    def test_changes_outside_the_section_or_of_the_marker_do_not_count(self) -> None:
        human_main = HUMAN_FILE.replace("## General strategy\n", "## General strategy\n\nChanged upstream.\n", 1)
        machine_main = MACHINE_FILE.replace("<!-- sync: guide=cd65", "<!-- sync: guide=0000", 1)
        proposal = _Fixture(human_main, machine_main).build({HUMAN_URL: HUMAN_EDIT, MACHINE_URL: MACHINE_EDIT})
        self.assertEqual(proposal.upstream_changed, [])


class TestInSync(unittest.TestCase):
    def test_machine_only_with_a_different_guide_override_is_not_in_sync(self) -> None:
        proposal = _Fixture().build({HUMAN_URL: HUMAN_EDIT, MACHINE_URL: MACHINE_EDIT}, include_human=False)
        self.assertFalse(proposal.in_sync)
        self.assertEqual([f.path for f in proposal.files], ["docs/guidelines-llm.md"])
        machine = _slice(proposal.files[0].after, "data-correction")
        self.assertNotEqual(sync_status(_slice(HUMAN_FILE, "data-correction"), machine, HUMAN_URL, MACHINE_URL), "in_sync")
        self.assertEqual(sync_status(_slice(HUMAN_EDIT, "data-correction"), machine, HUMAN_URL, MACHINE_URL), "in_sync")

    def test_machine_only_with_the_guide_as_upstream_is_in_sync(self) -> None:
        self.assertTrue(_Fixture().build({MACHINE_URL: MACHINE_EDIT}, include_human=False).in_sync)

    def test_machine_only_with_the_guide_changed_upstream_is_not_in_sync(self) -> None:
        human_main = HUMAN_FILE.replace(HUMAN_SENTENCE, f"{HUMAN_SENTENCE} Changed upstream.", 1)
        self.assertFalse(_Fixture(human_main).build({MACHINE_URL: MACHINE_EDIT}, include_human=False).in_sync)

    def test_both_layers_are_in_sync(self) -> None:
        self.assertTrue(_Fixture().build({HUMAN_URL: HUMAN_EDIT, MACHINE_URL: MACHINE_EDIT}).in_sync)

    def test_human_only_is_not_in_sync(self) -> None:
        self.assertFalse(_Fixture().build({HUMAN_URL: HUMAN_EDIT}, include_machine=False).in_sync)


class TestHeadingCheck(unittest.TestCase):
    def test_renamed_human_heading(self) -> None:
        override = HUMAN_EDIT.replace("## Data correction\n", "## Correcting data\n", 1)
        with self.assertRaises(ProposalError) as raised:
            _Fixture().build({HUMAN_URL: override}, include_machine=False)
        self.assertEqual(str(raised.exception), 'The proposed text for docs/guidelines.md must start with the heading of the section "data-correction".')

    def test_removed_machine_heading(self) -> None:
        override = MACHINE_EDIT.replace("## Data correction\n", "", 1)
        with self.assertRaises(ProposalError) as raised:
            _Fixture().build({MACHINE_URL: override}, include_human=False)
        self.assertEqual(str(raised.exception), 'The proposed text for docs/guidelines-llm.md must start with the heading of the section "data-correction".')

    def test_leading_blank_lines_are_dropped(self) -> None:
        proposal = _Fixture().build({HUMAN_URL: f"\n\n{HUMAN_EDIT}"}, include_machine=False)
        self.assertEqual(_changed_lines(HUMAN_FILE, proposal.files[0].after), ["+ ", "+ A new guide rule."])


class TestDefaultBranchErrors(unittest.TestCase):
    def test_resolve_errors_become_rule_fetch_errors(self) -> None:
        for error in (KeyError("default_branch"), NotImplementedError("no default branches"), ValueError("bad JSON")):
            fixture = _Fixture()
            fixture.default_branch_effect = error
            with self.subTest(error=type(error).__name__), self.assertRaises(RuleFetchError):
                fixture.build({HUMAN_URL: HUMAN_EDIT})


class TestSectionAnchor(unittest.TestCase):
    def test_heading_anchor(self) -> None:
        self.assertEqual(section_anchor(HUMAN_URL, MagicMock()), "data-correction")

    def test_line_range_at_a_heading(self) -> None:
        with patch(f"{MODULE}.fetch_rule_excerpt", return_value=MACHINE_FILE) as fetch:
            self.assertEqual(section_anchor(MACHINE_URL, MagicMock()), "data-correction")
        self.assertEqual(fetch.call_args.args[0], MACHINE_URL.partition("#")[0])

    def test_line_range_not_at_a_heading(self) -> None:
        with patch(f"{MODULE}.fetch_rule_excerpt", return_value=MACHINE_FILE), self.assertRaises(ProposalError):
            section_anchor(MACHINE_URL.replace("#L17", "#L18"), MagicMock())

    def test_no_fragment(self) -> None:
        with self.assertRaises(ProposalError):
            section_anchor(HUMAN_MAIN, MagicMock())


class TestBuildPatch(unittest.TestCase):
    def test_no_newline_at_end_of_file(self) -> None:
        files = [ProposedFile("a.md", "one\ntwo", "one\nthree"), ProposedFile("b.md", "x\n", "y\n")]
        patch_text = build_patch(files, "L", "bob", "guide section")
        self.assertEqual(
            patch_text,
            "# Annotation rules update: L\n# Proposed with the PDF-TEI-Editor by bob\n# Includes: guide section\n\n"
            "diff --git a/a.md b/a.md\n--- a/a.md\n+++ b/a.md\n@@ -1,2 +1,2 @@\n one\n-two\n\\ No newline at end of file\n+three\n\\ No newline at end of file\n"
            "diff --git a/b.md b/b.md\n--- a/b.md\n+++ b/b.md\n@@ -1 +1 @@\n-x\n+y\n",
        )

    @unittest.skipIf(shutil.which("git") is None, "git is not on PATH")
    def test_patch_without_final_newline_applies_with_git(self) -> None:
        files = [ProposedFile("a.md", "one\ntwo", "one\nthree\nfour"), ProposedFile("b.md", "x\ny", "x\ny\n")]
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            subprocess.run(["git", "init", "-q"], cwd=root, check=True)
            for file in files:
                (root / file.path).write_text(file.before, encoding="utf-8", newline="")
            (root / "p.patch").write_text(build_patch(files, "L", "bob", "guide section"), encoding="utf-8", newline="")
            subprocess.run(["git", "apply", "p.patch"], cwd=root, check=True, capture_output=True)
            for file in files:
                self.assertEqual((root / file.path).read_text(encoding="utf-8"), file.after)

    def test_label_and_username_cannot_add_preamble_lines(self) -> None:
        label = "Data\ncorrection\n\ndiff --git a/x b/x\r\n+++ b/x\x00"
        patch_text = build_patch([ProposedFile("a.md", "x\n", "y\n")], label, "bob\n# Includes: x", "guide section")
        preamble = patch_text.split("diff --git a/a.md")[0]
        self.assertEqual(
            preamble,
            "# Annotation rules update: Data correction diff --git a/x b/x +++ b/x\n# Proposed with the PDF-TEI-Editor by bob # Includes: x\n# Includes: guide section\n\n",
        )

    @unittest.skipIf(shutil.which("git") is None, "git is not on PATH")
    def test_injected_label_does_not_add_files_for_git(self) -> None:
        label = "Data correction\ndiff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -0,0 +1 @@\n+evil"
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            subprocess.run(["git", "init", "-q"], cwd=root, check=True)
            (root / "a.md").write_text("x\n", encoding="utf-8", newline="")
            (root / "p.patch").write_text(build_patch([ProposedFile("a.md", "x\n", "y\n")], label, "bob", "guide section"), encoding="utf-8", newline="")
            subprocess.run(["git", "apply", "--check", "p.patch"], cwd=root, check=True, capture_output=True)
            numstat = subprocess.run(["git", "apply", "--numstat", "p.patch"], cwd=root, check=True, capture_output=True, text=True).stdout
            self.assertEqual([line.split("\t")[-1] for line in numstat.splitlines()], ["a.md"])

    def test_filename(self) -> None:
        self.assertEqual(patch_filename("Data correction"), "data-correction-rules.patch")
        self.assertEqual(patch_filename("Citation model (v2)"), "citation-model-v2-rules.patch")
        self.assertEqual(patch_filename("Ünïcode / dates"), "n-code-dates-rules.patch")


if __name__ == "__main__":
    unittest.main()
