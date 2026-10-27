"""
Proposing a user's document rules upstream as a patch (#666, phase 4).

A rule category has a human guide section and a machine rules section (two
layers, see interpretation_ref_kind.py). The user's current text of each
selected layer (selected override, else the original) is spliced into the
file on the repository's default branch, by heading anchor, and the changed
files are rendered as one unified diff that `git apply` accepts at the
repository root. A proposed machine section gets a freshly computed sync
marker (without `base=`) whose guide hash is of the user's current human
text, the guide text the machine rules were derived from.
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
from fastapi_app.lib.doc_rules.guide_update import OriginalUnavailableError, layer_text
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
_LEADING_BLANK_LINES_RE = re.compile(r"\A(?:[ \t]*\n)+")
_CONTROL_CHARS_RE = re.compile(r"[\x00-\x1f\x7f-\x9f]")


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
    """
    The changed files (human first), the patch, its download file name, and
    the default branch it targets. `upstream_changed` lists the repository
    paths (human first) of the included layers whose section on the default
    branch differs from the pinned original, i.e. changes the patch replaces.
    `in_sync` is true iff the machine layer is included and its new marker's
    guide hash matches the human section upstream after the patch.
    """
    files: list[ProposedFile]
    patch: str
    filename: str
    branch: str
    upstream_changed: list[str]
    in_sync: bool


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


def _default_branch(adapter: BaseGitForgeAdapter, url: str, cache: UrlCache) -> tuple[str, str]:
    """
    (default branch name, `url` without fragment at the default branch).

    Raises:
        RuleFetchError: if the adapter cannot resolve the default branch
            (unsupported, unparsable URL, or an unexpected API answer).
    """
    try:
        return adapter.default_branch(url, cache), adapter.url_at_default_branch(url.partition("#")[0], cache)
    except (KeyError, NotImplementedError, ValueError) as e:
        raise RuleFetchError(f"Cannot resolve the default branch of {url}: {e!r}") from e


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
        ProposalError: if the anchor is gone, or `section` does not start
            with the heading of the section `anchor` (leading blank lines
            are dropped).
    """
    range_ = markdown_section_range(before, anchor)
    if range_ is None:
        raise ProposalError(f'The section "{anchor}" no longer exists in {path} on {branch}.')
    upstream_lines = before.splitlines()[range_[0] - 1:range_[1]]
    trailing_blank_lines = len(upstream_lines) - len("\n".join(upstream_lines).rstrip().splitlines())
    section = _LEADING_BLANK_LINES_RE.sub("", section)
    section = _TRAILING_BLANK_LINES_RE.sub("", section) + "\n" * (trailing_blank_lines + 1)
    after = splice_heading_section(before, anchor, section)
    # Anchors are computed on the whole file, so a duplicate heading keeps its "-N" suffix
    if heading_anchor_at_line(after, range_[0]) != anchor:
        raise ProposalError(f'The proposed text for {path} must start with the heading of the section "{anchor}".')
    return after


def _section(text: str, anchor: str, path: str, branch: str) -> str:
    """The section `anchor` of `text`. Raises ProposalError if the anchor is gone."""
    range_ = markdown_section_range(text, anchor)
    if range_ is None:
        raise ProposalError(f'The section "{anchor}" no longer exists in {path} on {branch}.')
    return "\n".join(text.splitlines()[range_[0] - 1:range_[1]])


def _upstream_changed(kind: InterpretationRefKind, url: str, upstream_section: str) -> bool:
    """
    Whether `upstream_section` (default branch, repository form) differs
    from the pinned original section of `url`, compared in relative-link
    form and ignoring sync markers and blank lines (see section_hash()).

    Raises:
        OriginalUnavailableError: if the original cannot be resolved.
    """
    try:
        original = kind.resolve_original(url)
    except Exception as e:
        raise OriginalUnavailableError(str(e)) from e
    return section_hash(_proposed_text(original, url)) != section_hash(_proposed_text(upstream_section, url))


def _one_line(value: str) -> str:
    """`value` with every run of whitespace collapsed to one space and other control characters removed, for a `# ` preamble line."""
    return _CONTROL_CHARS_RE.sub("", " ".join(value.split()))


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
    whose guide hash is of `owner`'s current human text (selected override,
    else the pinned original), whether or not the human layer is included:
    that is the guide text the machine rules were derived from. If the
    human section left upstream differs from it, the machine rules read as
    outdated there (`in_sync` is false).

    Raises:
        ProposalError: for the 422 cases (no layer selected, different
            repositories, a section gone upstream, nothing changes).
        OriginalUnavailableError, RuleFetchError, requests.RequestException:
            if a text cannot be resolved or fetched, or the default branch
            cannot be resolved (RuleFetchError).
    """
    if not include_human and not include_machine:
        raise ProposalError("Select at least one of the guide section and the machine rules.")
    human_repo, human_path = _repo_path(human_url)
    machine_path = ""
    if include_machine:
        machine_repo, machine_path = _repo_path(machine_url)
        if machine_repo != human_repo:
            raise ProposalError("The guide and the machine rules are in different repositories; propose them separately.")

    branch, human_main_url = _default_branch(_adapter(human_url), human_url, cache)
    human_anchor = section_anchor(human_url, cache)
    files: list[ProposedFile] = []
    upstream_changed: list[str] = []

    human_before = _fetch_raw_file(human_main_url)
    upstream_human_section = _section(human_before, human_anchor, human_path, branch)
    # The user's current guide text: proposed if included, and what the machine rules were derived from
    human_section = _proposed_text(layer_text(kind, human_url, store, owner)[0], human_url)
    if include_human:
        files.append(ProposedFile(human_path, human_before, _splice(human_before, human_anchor, human_section, human_path, branch)))
        if _upstream_changed(kind, human_url, upstream_human_section):
            upstream_changed.append(human_path)

    in_sync = False
    if include_machine:
        machine_anchor = section_anchor(machine_url, cache)
        _, machine_main_url = _default_branch(_adapter(machine_url), machine_url, cache)
        machine_before = _fetch_raw_file(machine_main_url)
        machine_text = _without_sync_markers(_proposed_text(layer_text(kind, machine_url, store, owner)[0], machine_url))
        guide_hash = human_section_hash(human_section, human_url)
        marker = SyncMarker(guide_hash=guide_hash, llm_hash=section_hash(machine_text), base=None)
        machine_section = with_sync_marker(machine_text, format_sync_marker(marker))
        files.append(ProposedFile(machine_path, machine_before, _splice(machine_before, machine_anchor, machine_section, machine_path, branch)))
        if _upstream_changed(kind, machine_url, _section(machine_before, machine_anchor, machine_path, branch)):
            upstream_changed.append(machine_path)
        human_after_section = human_section if include_human else upstream_human_section
        in_sync = human_section_hash(human_after_section, human_url) == guide_hash

    files = [file for file in files if file.after != file.before]
    if not files:
        raise ProposalError("There are no changes to propose.")
    patch = build_patch(files, label, owner, _includes(include_human, include_machine))
    return UpstreamProposal(
        files=files,
        patch=patch,
        filename=patch_filename(label),
        branch=branch,
        upstream_changed=upstream_changed,
        in_sync=in_sync,
    )


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
    `label` and `username` are collapsed to one line, so they cannot add
    lines (e.g. a forged `diff --git`) to the patch.
    """
    parts = [
        f"# Annotation rules update: {_one_line(label)}\n",
        f"# Proposed with the PDF-TEI-Editor by {_one_line(username)}\n",
        f"# Includes: {includes}\n",
        "\n",
    ]
    for file in files:
        parts.append(f"diff --git a/{file.path} b/{file.path}\n")
        parts.extend(_diff_lines(file))
    return "".join(parts)
