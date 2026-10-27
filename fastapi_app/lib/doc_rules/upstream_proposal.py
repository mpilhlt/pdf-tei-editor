"""
Proposing a user's document rules upstream as a patch (#666, phase 4).

A rule category has a human guide section and a machine rules section (two
layers, see interpretation_ref_kind.py). The user's current text of each
selected layer (selected override, else the original) is spliced into the
file on the repository's default branch, by heading anchor, and the changed
files are rendered as one unified diff that `git apply` accepts at the
repository root. A proposed machine section gets a freshly computed sync
marker (without `base=`), so upstream reads it as in sync with the human
section the patch leaves behind.
"""

import difflib
import re
from dataclasses import dataclass

import requests

from fastapi_app.lib.core.git_forge_adapters import BaseGitForgeAdapter, GitForgeAdapterRegistry
from fastapi_app.lib.core.url_cache import UrlCache
from fastapi_app.lib.doc_rules.guide_sync import (
    SyncMarker,
    format_sync_marker,
    human_section_hash,
    section_hash,
    split_sync_marker,
    with_sync_marker,
)
from fastapi_app.lib.doc_rules.guide_update import layer_text
from fastapi_app.lib.doc_rules.interpretation_ref_kind import InterpretationRefKind
from fastapi_app.lib.doc_rules.storage import DocumentRulesStore
from fastapi_app.lib.utils.annotation_rules_utils import (
    RuleFetchError,
    derelativize_markdown_urls,
    fetch_rule_excerpt,
    heading_anchor_at_line,
    is_heading_anchor_fragment,
    line_range_start,
    markdown_section_range,
    splice_heading_section,
)

_NO_NEWLINE = "\\ No newline at end of file\n"
_SLUG_SEPARATOR_RE = re.compile(r"[^a-z0-9]+")
_TRAILING_BLANK_LINES_RE = re.compile(r"(?:\n[ \t]*)+\Z")


class ProposalError(Exception):
    """The selection cannot be proposed; the message is shown to the user (HTTP 422)."""


@dataclass(frozen=True)
class ProposedFile:
    """A changed file in repository form: its path in the repository and its whole text before and after."""
    path: str
    before: str
    after: str


@dataclass(frozen=True)
class UpstreamProposal:
    """The changed files (human first), the patch, its download file name, and the default branch it targets."""
    files: list[ProposedFile]
    patch: str
    filename: str
    branch: str


def _adapter(url: str) -> BaseGitForgeAdapter:
    """The forge adapter for `url`. Raises RuleFetchError if none handles it."""
    adapter = GitForgeAdapterRegistry.get_instance().get_adapter_for(url.partition("#")[0])
    if adapter is None:
        raise RuleFetchError(f"No git forge adapter handles {url}")
    return adapter


def _repo_path(url: str) -> tuple[str, str]:
    """(repo_id, path) of `url`. Raises RuleFetchError if it cannot be parsed."""
    repo_path = _adapter(url).parse_repo_path(url)
    if repo_path is None:
        raise RuleFetchError(f"Cannot determine the repository of {url}")
    return repo_path


def _fetch_raw_file(url: str) -> str:
    """
    The raw text of the file the blob URL `url` (no fragment) points to, as
    stored in the repository: unlike fetch_rule_excerpt() its relative links
    are kept, and it is not cached, since a branch's head moves.

    Raises:
        requests.HTTPError: on an HTTP error.
        RuleFetchError: if a rendered HTML page is returned instead.
    """
    raw_url = _adapter(url).to_raw_url(url)
    response = requests.get(raw_url, timeout=30)
    response.raise_for_status()
    content_type = response.headers.get("Content-Type", "")
    if "text/html" in content_type:
        raise RuleFetchError(f"Expected raw text but got '{content_type}' from {raw_url}")
    return response.text


def section_anchor(url: str, cache: UrlCache) -> str:
    """
    The heading anchor of the section `url` points to: its fragment if that
    is a heading anchor, else (line-range fragment) the anchor of the heading
    on the range's start line in the pinned file.

    Raises:
        ProposalError: if no anchor can be found.
    """
    base_url, _, fragment = url.partition("#")
    if is_heading_anchor_fragment(fragment):
        return fragment
    start = line_range_start(fragment) if fragment else None
    if start is not None:
        anchor = heading_anchor_at_line(fetch_rule_excerpt(base_url, cache), start)
        if anchor is not None:
            return anchor
    raise ProposalError(f"{url} does not point to a section heading.")


def _proposed_text(text: str, url: str) -> str:
    """A layer's text in repository form: `\\n` line endings, same-repository links relative to `url`."""
    return derelativize_markdown_urls(text.replace("\r\n", "\n"), url)


def _splice(before: str, anchor: str, section: str, path: str, branch: str) -> str:
    """
    `before` with the section `anchor` replaced by `section`, which keeps the
    upstream section's trailing blank lines (the ones separating it from the
    next heading), whatever blank lines `section` ends with.

    Raises:
        ProposalError: if the anchor is gone.
    """
    range_ = markdown_section_range(before, anchor)
    if range_ is None:
        raise ProposalError(f'The section "{anchor}" no longer exists in {path} on {branch}.')
    upstream_lines = before.splitlines()[range_[0] - 1:range_[1]]
    trailing_blank_lines = len(upstream_lines) - len("\n".join(upstream_lines).rstrip().splitlines())
    section = _TRAILING_BLANK_LINES_RE.sub("", section) + "\n" * (trailing_blank_lines + 1)
    return splice_heading_section(before, anchor, section)


def _section(text: str, anchor: str, path: str, branch: str) -> str:
    """The section `anchor` of `text`. Raises ProposalError if the anchor is gone."""
    range_ = markdown_section_range(text, anchor)
    if range_ is None:
        raise ProposalError(f'The section "{anchor}" no longer exists in {path} on {branch}.')
    return "\n".join(text.splitlines()[range_[0] - 1:range_[1]])


def _without_sync_markers(text: str) -> str:
    """`text` with every sync marker line removed (see split_sync_marker())."""
    marker_line: str | None = ""
    while marker_line is not None:
        text, marker_line = split_sync_marker(text)
    return text


def patch_filename(label: str) -> str:
    """`<category-slug>-rules.patch`; the slug is `label` lowercased, runs of non-alphanumerics replaced by `-`, trimmed of `-`."""
    slug = _SLUG_SEPARATOR_RE.sub("-", label.lower()).strip("-")
    return f"{slug}-rules.patch" if slug else "rules.patch"


def _includes(include_human: bool, include_machine: bool) -> str:
    if include_human and include_machine:
        return "guide section and machine rules"
    return "guide section" if include_human else "machine rules"


def build_upstream_proposal(
    kind: InterpretationRefKind,
    human_url: str,
    machine_url: str,
    include_human: bool,
    include_machine: bool,
    store: DocumentRulesStore,
    owner: str,
    label: str,
    cache: UrlCache,
) -> UpstreamProposal:
    """
    Build the upstream proposal of `owner`'s current text of the selected
    layers of a rule category labelled `label`: each selected layer's section
    spliced into its file on the default branch, and the patch of the files
    that change. A proposed machine section carries a recomputed sync marker
    whose guide hash is of the human section the patch leaves upstream (the
    proposed one if included, else the default branch's).

    Raises:
        ProposalError: for the 422 cases (no layer selected, different
            repositories, a section gone upstream, nothing changes).
        OriginalUnavailableError, RuleFetchError, requests.RequestException:
            if a text cannot be resolved or fetched.
    """
    if not include_human and not include_machine:
        raise ProposalError("Select at least one of the guide section and the machine rules.")
    human_repo, human_path = _repo_path(human_url)
    machine_path = ""
    if include_machine:
        machine_repo, machine_path = _repo_path(machine_url)
        if machine_repo != human_repo:
            raise ProposalError("The guide and the machine rules are in different repositories; propose them separately.")

    adapter = _adapter(human_url)
    branch = adapter.default_branch(human_url, cache)
    human_anchor = section_anchor(human_url, cache)
    files: list[ProposedFile] = []

    human_before = _fetch_raw_file(adapter.url_at_default_branch(human_url.partition("#")[0], cache))
    if include_human:
        human_section = _proposed_text(layer_text(kind, human_url, store, owner)[0], human_url)
        files.append(ProposedFile(human_path, human_before, _splice(human_before, human_anchor, human_section, human_path, branch)))
    else:
        human_section = _section(human_before, human_anchor, human_path, branch)

    if include_machine:
        machine_anchor = section_anchor(machine_url, cache)
        machine_adapter = _adapter(machine_url)
        machine_before = _fetch_raw_file(machine_adapter.url_at_default_branch(machine_url.partition("#")[0], cache))
        machine_text = _without_sync_markers(_proposed_text(layer_text(kind, machine_url, store, owner)[0], machine_url))
        marker = SyncMarker(guide_hash=human_section_hash(human_section, human_url), llm_hash=section_hash(machine_text), base=None)
        machine_section = with_sync_marker(machine_text, format_sync_marker(marker))
        files.append(ProposedFile(machine_path, machine_before, _splice(machine_before, machine_anchor, machine_section, machine_path, branch)))

    files = [file for file in files if file.after != file.before]
    if not files:
        raise ProposalError("There are no changes to propose.")
    patch = build_patch(files, label, owner, _includes(include_human, include_machine))
    return UpstreamProposal(files=files, patch=patch, filename=patch_filename(label), branch=branch)


def _diff_lines(file: ProposedFile) -> list[str]:
    """The unified diff of `file` with 3 lines of context, a missing final newline marked as git does."""
    lines: list[str] = []
    for line in difflib.unified_diff(
        file.before.splitlines(keepends=True),
        file.after.splitlines(keepends=True),
        fromfile=f"a/{file.path}",
        tofile=f"b/{file.path}",
        n=3,
    ):
        lines.append(line if line.endswith("\n") else f"{line}\n{_NO_NEWLINE}")
    return lines


def build_patch(files: list[ProposedFile], label: str, username: str, includes: str) -> str:
    """
    A patch `git apply` accepts at the repository root: a `# ` preamble
    (ignored by git), then a `diff --git` section per file in the given order.
    """
    parts = [
        f"# Annotation rules update: {label}\n",
        f"# Proposed with the PDF-TEI-Editor by {username}\n",
        f"# Includes: {includes}\n",
        "\n",
    ]
    for file in files:
        parts.append(f"diff --git a/{file.path} b/{file.path}\n")
        parts.extend(_diff_lines(file))
    return "".join(parts)
