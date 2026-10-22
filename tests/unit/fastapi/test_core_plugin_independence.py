"""
Guard test: core code must not depend on any plugin.

Nothing outside the plugin directories may import a plugin's code, call its
routes or refer to its files. This keeps every plugin removable, so that it can
be moved out of the core repository without changing core (see
docs/history/plugin-extraction-plan.md, "Removing Plugin Code from Core").
The test fixture plugins in tests/fixtures/plugins/ are exempt.

@testCovers fastapi_app/main.py
"""

import re
import subprocess
import unittest
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[3]
PLUGINS_DIR = PROJECT_ROOT / "fastapi_app" / "plugins"
FIXTURE_PLUGINS_DIR = PROJECT_ROOT / "tests" / "fixtures" / "plugins"

# First-party plugins that live in the pte-plugins repository. Core must not
# refer to them either, also when they are not installed.
EXTERNAL_FIRST_PARTY_PLUGINS = [
    "grobid", "metadata_extraction", "kisski", "llamore_extractor", "anthropic_llm", "google_llm",
    "annotation_review", "annotation_history", "iaa_analyzer", "rng_converter", "update_metadata",
    "webdav_sync", "local_sync", "edit_history", "annotation_progress", "collection_overview",
    "revision_feed", "tei_annotator", "archival_edition",
]

CHECKED_DIRS = ["fastapi_app", "app/src", "bin", "config", "tests"]
EXCLUDED_DIRS = [PLUGINS_DIR, FIXTURE_PLUGINS_DIR, PROJECT_ROOT / "tests" / "pdf-match"]
CHECKED_SUFFIXES = {".py", ".js", ".mjs", ".html", ".json", ".sh"}


def plugin_names() -> set[str]:
    """Directory names of all known plugins except the test fixtures."""
    names = set(EXTERNAL_FIRST_PARTY_PLUGINS)
    if PLUGINS_DIR.is_dir():
        names |= {p.name for p in PLUGINS_DIR.iterdir() if (p / "plugin.py").is_file()}
    if FIXTURE_PLUGINS_DIR.is_dir():
        names -= {p.name for p in FIXTURE_PLUGINS_DIR.iterdir()}
    return names


# Generated or test runtime directories, skipped when git is not available
UNTRACKED_DIR_NAMES = {"__pycache__", "node_modules", "runtime", "test-results"}


def candidate_files() -> list[Path]:
    """Files under the checked directories that git tracks (generated and staged files are ignored).

    Without git (the CI container image has no .git), all files below the checked
    directories are used, except those in generated or test runtime directories.
    """
    try:
        output = subprocess.run(
            ["git", "ls-files", "--", *CHECKED_DIRS], cwd=PROJECT_ROOT, capture_output=True, text=True, check=True
        ).stdout
        return [PROJECT_ROOT / line for line in output.splitlines()]
    except (subprocess.CalledProcessError, FileNotFoundError):
        return [
            path
            for checked in CHECKED_DIRS
            for path in (PROJECT_ROOT / checked).rglob("*")
            if not UNTRACKED_DIR_NAMES & set(path.relative_to(PROJECT_ROOT).parts)
        ]


def tracked_files() -> list[Path]:
    """Files that the guard test checks."""
    files = []
    for path in candidate_files():
        if path.suffix not in CHECKED_SUFFIXES or not path.is_file():
            continue
        if any(path.is_relative_to(excluded) for excluded in EXCLUDED_DIRS):
            continue
        if path == Path(__file__).resolve():
            continue
        files.append(path)
    return files


class TestCorePluginIndependence(unittest.TestCase):
    def test_core_does_not_refer_to_plugins(self):
        names = plugin_names()
        alternatives = "|".join(sorted({re.escape(n) for n in names} | {re.escape(n.replace("_", "-")) for n in names}))
        patterns = [
            # Python imports: fastapi_app.plugins.<dir> and relative ..plugins.<dir>
            re.compile(rf"(?:fastapi_app|\.)\.plugins\.(?:{alternatives})\b"),
            # Plugin routes and static files
            re.compile(rf"/api/plugins/(?:{alternatives})(?![\w-])"),
            # File paths into a plugin directory
            re.compile(rf"fastapi_app/plugins/(?:{alternatives})\b"),
            # Imports of installed plugin packages (pte-plugins monorepo)
            re.compile(r"^\s*(?:from|import)\s+pte_plugin_\w+"),
        ]
        violations = []
        for path in tracked_files():
            try:
                text = path.read_text(encoding="utf-8")
            except UnicodeDecodeError:
                continue
            for number, line in enumerate(text.splitlines(), start=1):
                for pattern in patterns:
                    match = pattern.search(line)
                    if match:
                        violations.append(f"{path.relative_to(PROJECT_ROOT)}:{number}: {match.group(0)}")
        self.assertEqual(violations, [], "Core refers to plugin code:\n" + "\n".join(violations))


if __name__ == "__main__":
    unittest.main()
