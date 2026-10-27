"""
Tests for fastapi_app/lib/doc_rules/guide_sync.py: sync-marker parsing and
hashing, checked against real fossil guideline files.
"""

import unittest
from contextlib import ExitStack
from pathlib import Path
from unittest.mock import MagicMock, patch

import requests

from fastapi_app.lib.core.git_forge_adapters import GitHubAdapter
from fastapi_app.lib.doc_rules.guide_sync import (
    SyncMarker,
    find_synced_human_commit,
    format_sync_marker,
    human_section_hash,
    parse_sync_marker,
    section_hash,
    split_sync_marker,
    sync_status,
)
from fastapi_app.lib.utils.annotation_rules_utils import (
    _rewrite_relative_markdown_urls,
    markdown_section_range,
)

FIXTURES = Path(__file__).parent / "fixtures" / "fossil"
FOSSIL_SHA = "eab669d4d093c54dd1990b4a0bf017d00f82d5a8"
HUMAN_URL = f"https://github.com/mpilhlt/fossil/blob/{FOSSIL_SHA}/docs/guidelines.md"
MACHINE_URL = f"https://github.com/mpilhlt/fossil/blob/{FOSSIL_SHA}/docs/guidelines-llm.md"
RAW_DIR_URL = f"https://raw.githubusercontent.com/mpilhlt/fossil/{FOSSIL_SHA}/docs/"
HEX_A, HEX_B, HEX_C = "a" * 64, "b" * 64, "c" * 64


def _slice(text: str, anchor: str) -> str:
    range_ = markdown_section_range(text, anchor)
    assert range_ is not None, anchor
    start, end = range_
    return "\n".join(text.splitlines()[start - 1:end])


def _marked(body: str, guide: str, llm: str, base: str | None = None) -> str:
    return f"## Heading\n{format_sync_marker(SyncMarker(guide, llm, base))}\n{body}\n"


def _synced_pair() -> tuple[str, str]:
    human = "## Heading\nHuman text.\n"
    unmarked = "## Heading\nMachine text.\n"
    return human, _marked("Machine text.", human_section_hash(human, HUMAN_URL), section_hash(unmarked))


class TestSyncStatus(unittest.TestCase):
    def test_golden_fossil_sections_are_in_sync(self) -> None:
        for anchor in ["data-correction", "document-segmentation-model", "reference-segmentation-model", "citation-model"]:
            with self.subTest(anchor=anchor):
                human = _rewrite_relative_markdown_urls(_slice((FIXTURES / "guidelines.md").read_text(encoding="utf-8"), anchor), RAW_DIR_URL)
                machine = _slice((FIXTURES / "guidelines-llm.md").read_text(encoding="utf-8"), anchor)
                self.assertEqual(sync_status(human, machine, HUMAN_URL, MACHINE_URL), "in_sync")

    def test_golden_fossil_sections_with_absolute_links_are_in_sync(self) -> None:
        # As served by core: both sides with their relative links made absolute (see fetch_rule_excerpt())
        for anchor in ["data-correction", "document-segmentation-model", "reference-segmentation-model", "citation-model"]:
            with self.subTest(anchor=anchor):
                human = _rewrite_relative_markdown_urls(_slice((FIXTURES / "guidelines.md").read_text(encoding="utf-8"), anchor), RAW_DIR_URL)
                machine = _rewrite_relative_markdown_urls(_slice((FIXTURES / "guidelines-llm.md").read_text(encoding="utf-8"), anchor), RAW_DIR_URL)
                self.assertEqual(sync_status(human, machine, HUMAN_URL, MACHINE_URL), "in_sync")

    def test_machine_absolute_same_repo_link_is_hashed_in_relative_form(self) -> None:
        human = "## Heading\nHuman text.\n"
        relative = "## Heading\nSee ![img](img/a.png).\n"
        absolute_body = f"See ![img]({RAW_DIR_URL}img/a.png)."
        machine = _marked(absolute_body, human_section_hash(human, HUMAN_URL), section_hash(relative))
        self.assertEqual(sync_status(human, machine, HUMAN_URL, MACHINE_URL), "in_sync")

    def test_synced_pair_is_in_sync(self) -> None:
        human, machine = _synced_pair()
        self.assertEqual(sync_status(human, machine, HUMAN_URL, MACHINE_URL), "in_sync")

    def test_human_change_is_outdated(self) -> None:
        human, machine = _synced_pair()
        self.assertEqual(sync_status(human + "New line.\n", machine, HUMAN_URL, MACHINE_URL), "machine_outdated")

    def test_machine_change_is_edited(self) -> None:
        human, machine = _synced_pair()
        self.assertEqual(sync_status(human, machine + "Edited.\n", HUMAN_URL, MACHINE_URL), "machine_edited")

    def test_both_changed(self) -> None:
        human, machine = _synced_pair()
        self.assertEqual(sync_status(human + "New line.\n", machine + "Edited.\n", HUMAN_URL, MACHINE_URL), "both_changed")

    def test_missing_marker_is_no_marker(self) -> None:
        self.assertEqual(sync_status("## H\nx\n", "## H\ny\n", HUMAN_URL, MACHINE_URL), "no_marker")

    def test_malformed_marker_is_no_marker(self) -> None:
        machine = "## H\n<!-- sync: guide=xyz llm=123 -->\ny\n"
        self.assertIsNone(parse_sync_marker(machine))
        self.assertEqual(sync_status("## H\nx\n", machine, HUMAN_URL, MACHINE_URL), "no_marker")


class TestSyncMarker(unittest.TestCase):
    def test_parse_marker_without_base(self) -> None:
        self.assertEqual(parse_sync_marker(f"## H\n<!-- sync: guide={HEX_A} llm={HEX_B} -->\ntext"), SyncMarker(HEX_A, HEX_B, None))

    def test_parse_marker_with_base(self) -> None:
        self.assertEqual(parse_sync_marker(f"## H\n<!-- sync: guide={HEX_A} llm={HEX_B} base={HEX_C} -->\ntext"), SyncMarker(HEX_A, HEX_B, HEX_C))

    def test_format_marker_round_trip(self) -> None:
        for marker in (SyncMarker(HEX_A, HEX_B, None), SyncMarker(HEX_A, HEX_B, HEX_C)):
            line = format_sync_marker(marker)
            self.assertNotIn("\n", line)
            self.assertEqual("base=" in line, marker.base is not None)
            self.assertEqual(parse_sync_marker(line), marker)

    def test_split_marker_returns_text_without_marker_and_the_line(self) -> None:
        line = format_sync_marker(SyncMarker(HEX_A, HEX_B, HEX_C))
        self.assertEqual(split_sync_marker(f"## H\n\n{line}\n\ntext\n"), ("## H\n\ntext\n", line))

    def test_split_marker_at_the_start(self) -> None:
        line = format_sync_marker(SyncMarker(HEX_A, HEX_B, None))
        self.assertEqual(split_sync_marker(f"{line}\n## H\n\ntext"), ("## H\n\ntext", line))

    def test_split_marker_normalizes_crlf(self) -> None:
        line = format_sync_marker(SyncMarker(HEX_A, HEX_B, None))
        self.assertEqual(split_sync_marker(f"## H\r\n\r\n{line}\r\n\r\ntext\r\n"), ("## H\n\ntext\n", line))

    def test_split_marker_without_marker(self) -> None:
        self.assertEqual(split_sync_marker("## H\n\ntext"), ("## H\n\ntext", None))


class TestSectionHash(unittest.TestCase):
    def test_hash_ignores_crlf_trailing_whitespace_and_blank_lines(self) -> None:
        self.assertEqual(section_hash("## H\r\nline one  \r\n\r\nline two\t\r\n"), section_hash("## H\nline one\nline two"))

    def test_hash_ignores_sync_marker(self) -> None:
        marker = format_sync_marker(SyncMarker(HEX_A, HEX_B, None))
        self.assertEqual(section_hash(f"## H\n{marker}\ntext"), section_hash("## H\ntext"))

    def test_human_hash_derelativizes_links(self) -> None:
        from fastapi_app.lib.utils.annotation_rules_utils import derelativize_markdown_urls
        section = "## H\n![img](img/a.png)\n"
        self.assertEqual(human_section_hash(section, HUMAN_URL), section_hash(derelativize_markdown_urls(section, HUMAN_URL)))


# find_synced_human_commit

SHAS = ["1" * 40, "2" * 40, "3" * 40, "4" * 40]
BLOB_URL = "https://github.com/mpilhlt/fossil/blob/main/docs/guidelines.md#heading"
GUIDE_SYNC_LOGGER = "fastapi_app.lib.doc_rules.guide_sync"


def _file_at(sha: str) -> str:
    return f"# Title\n\n## Heading\nVersion {SHAS.index(sha)}.\n\n## Other\nx\n"


def _file_hash(sha: str) -> str:
    return human_section_hash(f"## Heading\nVersion {SHAS.index(sha)}.", f"https://github.com/mpilhlt/fossil/blob/{sha}/docs/guidelines.md")


def _patched(commits: "list[str] | Exception", files: dict[str, str]) -> ExitStack:
    def fetch(url: str, cache: object, allow_redirects: bool = True) -> str:
        assert "#" not in url
        return files[url.split("/blob/")[1].split("/")[0]]

    stack = ExitStack()
    if isinstance(commits, Exception):
        stack.enter_context(patch.object(GitHubAdapter, "list_file_commits", side_effect=commits))
    else:
        stack.enter_context(patch.object(GitHubAdapter, "list_file_commits", return_value=commits))
    stack.enter_context(patch("fastapi_app.lib.doc_rules.guide_sync.fetch_rule_excerpt", side_effect=fetch))
    return stack


class TestFindSyncedHumanCommit(unittest.TestCase):
    def test_find_synced_commit_matches_second_newest(self) -> None:
        marker = SyncMarker(_file_hash(SHAS[1]), HEX_B, None)
        with _patched(SHAS, {s: _file_at(s) for s in SHAS}):
            self.assertEqual(find_synced_human_commit(BLOB_URL, marker, MagicMock()), SHAS[1])

    def test_find_synced_commit_no_match(self) -> None:
        with _patched(SHAS, {s: _file_at(s) for s in SHAS}):
            self.assertIsNone(find_synced_human_commit(BLOB_URL, SyncMarker(HEX_A, HEX_B, None), MagicMock()))

    def test_find_synced_commit_stops_at_base(self) -> None:
        marker = SyncMarker(_file_hash(SHAS[3]), HEX_B, SHAS[1])
        with _patched(SHAS, {s: _file_at(s) for s in SHAS}):
            self.assertIsNone(find_synced_human_commit(BLOB_URL, marker, MagicMock()))

    def test_find_synced_commit_matches_base_itself(self) -> None:
        marker = SyncMarker(_file_hash(SHAS[1]), HEX_B, SHAS[1])
        with _patched(SHAS, {s: _file_at(s) for s in SHAS}):
            self.assertEqual(find_synced_human_commit(BLOB_URL, marker, MagicMock()), SHAS[1])

    def test_find_synced_commit_listing_error_gives_none(self) -> None:
        with _patched(requests.HTTPError("403"), {}), self.assertLogs(GUIDE_SYNC_LOGGER, level="WARNING"):
            self.assertIsNone(find_synced_human_commit(BLOB_URL, SyncMarker(HEX_A, HEX_B, None), MagicMock()))

    def test_find_synced_commit_skips_commit_without_anchor(self) -> None:
        files = {s: _file_at(s) for s in SHAS}
        files[SHAS[0]] = "# Title\n\nNo such section.\n"
        marker = SyncMarker(_file_hash(SHAS[2]), HEX_B, None)
        with _patched(SHAS, files):
            self.assertEqual(find_synced_human_commit(BLOB_URL, marker, MagicMock()), SHAS[2])

    def test_find_synced_commit_stops_at_deadline(self) -> None:
        marker = SyncMarker(_file_hash(SHAS[2]), HEX_B, None)
        with _patched(SHAS, {s: _file_at(s) for s in SHAS}) as stack:
            stack.enter_context(patch("fastapi_app.lib.doc_rules.guide_sync.time.monotonic", side_effect=[0.0, 0.0, 100.0]))
            fetch = stack.enter_context(patch("fastapi_app.lib.doc_rules.guide_sync.fetch_rule_excerpt", side_effect=lambda url, cache: _file_at(SHAS[0])))
            self.assertIsNone(find_synced_human_commit(BLOB_URL, marker, MagicMock(), deadline_seconds=20.0))
        self.assertEqual(fetch.call_count, 1)

    def test_find_synced_commit_http_error_logs_warning_without_traceback(self) -> None:
        with _patched(requests.HTTPError("403"), {}), self.assertLogs(GUIDE_SYNC_LOGGER, level="WARNING") as logs:
            self.assertIsNone(find_synced_human_commit(BLOB_URL, SyncMarker(HEX_A, HEX_B, None), MagicMock()))
        [record] = logs.records
        self.assertEqual(record.levelname, "WARNING")
        self.assertIsNone(record.exc_info)

    def test_find_synced_commit_unexpected_error_logs_traceback(self) -> None:
        with _patched(KeyError("sha"), {}), self.assertLogs(GUIDE_SYNC_LOGGER, level="WARNING") as logs:
            self.assertIsNone(find_synced_human_commit(BLOB_URL, SyncMarker(HEX_A, HEX_B, None), MagicMock()))
        [record] = logs.records
        self.assertIsNotNone(record.exc_info)
