"""
Opening a GitHub pull request of a document rules upstream proposal (#666, phase 4b).

The changed files of an UpstreamProposal (see upstream_proposal.py) are
committed in one commit on top of the default branch's head commit, on a new
branch, and proposed as a pull request against the default branch, with the
user's own GitHub token. Without push access to the repository, the branch is
created in the token owner's fork (created, or reused if it exists).
"""

import base64
import logging
import time
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any
from urllib.parse import quote

import requests

from fastapi_app.lib.doc_rules.upstream_proposal import ProposedFile, includes_text, one_line, patch_filename
from fastapi_app.lib.secrets import register_secret_service

logger = logging.getLogger(__name__)

GITHUB_SECRET_SERVICE: str = "github"

_API = "https://api.github.com"
_TIMEOUT = 15
_FORK_POLL_INTERVAL = 1
_BRANCH_PREFIX = "pdf-tei-editor"
_PATCH_SUFFIX = "-rules.patch"
_CHANGED_UPSTREAM = "The guide changed upstream since the preview. Close and reopen the dialog to see the current changes."
_TOKEN_REJECTED = 'GitHub rejected the token. Update it under "GitHub" in your API keys.'


class GitHubError(Exception):
    """
    A pull request cannot be created. `status_code` is the HTTP status the
    route returns (422, 409 or 502), `message` the text shown to the user,
    which never contains the token. `github_status` is the status GitHub
    answered with, if any.
    """

    def __init__(self, status_code: int, message: str, github_status: int | None = None):
        super().__init__(message)
        self.status_code = status_code
        self.message = message
        self.github_status = github_status

    def __str__(self) -> str:
        return self.message


@dataclass(frozen=True)
class PullRequestResult:
    """The created pull request: its web URL and number, the branch, and the fork's full name if it was opened from a fork."""
    url: str
    number: int
    branch: str
    fork: str | None


def register_github_secret_service() -> None:
    """Register the `github` secret service, whose token opens pull requests of rule proposals."""
    register_secret_service(
        GITHUB_SECRET_SERVICE,
        "GitHub",
        "Personal access token used to open pull requests with document rule changes.",
        "https://github.com/settings/tokens",
    )


def pull_request_branch_name(label: str, now: datetime) -> str:
    """`pdf-tei-editor/<slug>-<YYYYMMDD-HHMMSS>` in UTC; the slug is the one of patch_filename()."""
    filename = patch_filename(label)
    slug = filename.removesuffix(_PATCH_SUFFIX) if filename.endswith(_PATCH_SUFFIX) else "rules"
    return f"{_BRANCH_PREFIX}/{slug}-{now.astimezone(UTC).strftime('%Y%m%d-%H%M%S')}"


def default_pull_request_text(
    label: str,
    username: str,
    include_human: bool,
    include_machine: bool,
    in_sync: bool,
    upstream_changed: list[str],
) -> tuple[str, str]:
    """The default (title, description) of the pull request of a proposal, see UpstreamProposal for `in_sync` and `upstream_changed`."""
    title = f"Annotation rules update: {one_line(label)}"
    lines = [
        f"Proposed with the PDF-TEI-Editor by {one_line(username)}.",
        "",
        f"Includes: {includes_text(include_human, include_machine)}.",
    ]
    if include_machine:
        lines.append("The sync marker of the machine rules is updated; the pair is in sync." if in_sync else "The machine rules are marked as outdated.")
    for path in upstream_changed:
        lines.append(f"Note: the section in {path} changed upstream since the proposer's version; this pull request replaces those changes.")
    return title, "\n".join(lines)


def _request(method: str, path: str, token: str, json: dict[str, Any] | None = None) -> dict[str, Any]:
    """
    The JSON answer of the GitHub REST API to `method path` (path from the
    API root) with `token`. Logs the method, path and status only.

    Raises:
        GitHubError: 422 if GitHub rejects the token (401), else 502 with
            GitHub's message, with any occurrence of the token removed.
    """
    headers = {
        "Authorization": f"Bearer {token}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
    }
    try:
        response = requests.request(method, f"{_API}{path}", headers=headers, json=json, timeout=_TIMEOUT)
    except requests.RequestException as e:
        # The exception text may carry request details; only its type is reported
        logger.warning(f"GitHub {method} {path} failed: {type(e).__name__}")
        raise GitHubError(502, f"GitHub request failed: {type(e).__name__}") from None
    logger.info(f"GitHub {method} {path} -> {response.status_code}")
    try:
        body = response.json()
    except ValueError:
        body = {}
    if not isinstance(body, dict):
        body = {}
    if response.status_code == 401:
        raise GitHubError(422, _TOKEN_REJECTED, 401)
    if response.status_code >= 400:
        message = str(body.get("message") or response.reason or "")
        if token:
            message = message.replace(token, "***")
        raise GitHubError(502, f"GitHub request failed ({response.status_code}): {message}", response.status_code)
    return body


def _ref_sha(token: str, repo_id: str, branch: str) -> str:
    """The commit SHA of `branch` in `repo_id`."""
    return str(_request("GET", f"/repos/{repo_id}/git/ref/heads/{quote(branch)}", token)["object"]["sha"])


def _check_unchanged(token: str, repo_id: str, base_sha: str, files: list[ProposedFile]) -> None:
    """Raises GitHubError (409) if a file at `base_sha` is gone or differs from its `before` text."""
    for file in files:
        try:
            contents = _request("GET", f"/repos/{repo_id}/contents/{quote(file.path)}?ref={base_sha}", token)
        except GitHubError as e:
            if e.github_status == 404:
                raise GitHubError(409, _CHANGED_UPSTREAM) from None
            raise
        text = base64.b64decode(str(contents.get("content", ""))).decode("utf-8")
        if text != file.before:
            raise GitHubError(409, _CHANGED_UPSTREAM)


def _fork(token: str, repo_id: str, base_branch: str, fork_wait_seconds: float) -> tuple[str, str]:
    """
    (full name, owner) of the token owner's fork of `repo_id`, created or
    reused, once its `base_branch` ref answers.

    Raises:
        GitHubError: 502 if the fork is not ready after `fork_wait_seconds`.
    """
    fork = _request("POST", f"/repos/{repo_id}/forks", token, {"default_branch_only": True})
    full_name = str(fork["full_name"])
    owner = str(fork.get("owner", {}).get("login") or full_name.split("/")[0])
    deadline = time.monotonic() + fork_wait_seconds
    while True:
        try:
            _ref_sha(token, full_name, base_branch)
            return full_name, owner
        except GitHubError as e:
            # A fork being created answers 404 (or 409 while still empty)
            if e.github_status not in (404, 409):
                raise
        if time.monotonic() >= deadline:
            raise GitHubError(502, f"GitHub did not finish creating the fork of {repo_id}. Try again in a minute.")
        time.sleep(_FORK_POLL_INTERVAL)


def open_pull_request(
    token: str,
    repo_id: str,
    base_branch: str,
    files: list[ProposedFile],
    title: str,
    body: str,
    branch: str,
    *,
    fork_wait_seconds: float = 10.0,
) -> PullRequestResult:
    """
    Commit the `after` texts of `files` on top of the head of `base_branch`
    of `repo_id` (`owner/repo`), on the new `branch`, and open a pull request
    with `title` and `body` against `base_branch`. Without push access, the
    branch is created in the token owner's fork; its parent is still the
    upstream head commit. Nothing is written if a file's text on
    `base_branch` differs from its `before` text.

    Raises:
        GitHubError: see the class; 409 if the files changed upstream.
    """
    try:
        repo = _request("GET", f"/repos/{repo_id}", token)
    except GitHubError as e:
        if e.github_status in (403, 404):
            raise GitHubError(422, f"The GitHub token has no access to {repo_id}.") from None
        raise
    can_push = bool(repo.get("permissions", {}).get("push"))
    base_sha = _ref_sha(token, repo_id, base_branch)
    _check_unchanged(token, repo_id, base_sha, files)

    fork: str | None = None
    head = branch
    target = repo_id
    if not can_push:
        fork, fork_owner = _fork(token, repo_id, base_branch, fork_wait_seconds)
        target = fork
        head = f"{fork_owner}:{branch}"

    tree = _request("POST", f"/repos/{target}/git/trees", token, {
        "base_tree": base_sha,
        "tree": [{"path": file.path, "mode": "100644", "type": "blob", "content": file.after} for file in files],
    })
    commit = _request("POST", f"/repos/{target}/git/commits", token, {
        "message": f"{title}\n\n{body}",
        "tree": tree["sha"],
        "parents": [base_sha],
    })
    _request("POST", f"/repos/{target}/git/refs", token, {"ref": f"refs/heads/{branch}", "sha": commit["sha"]})
    pull = _request("POST", f"/repos/{repo_id}/pulls", token, {
        "title": title,
        "body": body,
        "head": head,
        "base": base_branch,
        "maintainer_can_modify": True,
    })
    return PullRequestResult(url=str(pull["html_url"]), number=int(pull["number"]), branch=branch, fork=fork)
