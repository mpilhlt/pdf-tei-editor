"""
Tests for fastapi_app/lib/doc_rules/github_pull_request.py: opening a GitHub
pull request of a document rules proposal, against a fake GitHub REST API.

@testCovers fastapi_app/lib/doc_rules/github_pull_request.py
"""

import itertools
import json
import logging
import unittest
from datetime import UTC, datetime
from typing import Any
from unittest.mock import patch

from fastapi_app.lib.doc_rules.github_pull_request import (
    GITHUB_SECRET_SERVICE,
    GitHubError,
    PullRequestResult,
    default_pull_request_text,
    open_pull_request,
    pull_request_branch_name,
    register_github_secret_service,
)
from fastapi_app.lib.doc_rules.upstream_proposal import ProposedFile
from fastapi_app.lib.secrets import SecretServiceRegistry, unregister_secret_service

MODULE = "fastapi_app.lib.doc_rules.github_pull_request"
API = "https://api.github.com"
TOKEN = "ghp_SECRET"
REPO = "owner/repo"
BASE_SHA = "a" * 40
BASE_TREE = "t" * 40
FILES = [
    ProposedFile("docs/guide.md", "# Guide\n\nold\n", "# Guide\n\nnew\n"),
    ProposedFile("docs/guide-llm.md", "# LLM\n\nold\n", "# LLM\n\nnew\n"),
]
BRANCH = "pdf-tei-editor/data-correction-20261028-090507"


class FakeResponse:
    """A requests.Response stand-in with a status code and a JSON body, or a raw body (`bytes`)."""

    def __init__(self, status_code: int, body: dict[str, Any] | bytes):
        self.status_code = status_code
        self._body = body
        self.reason = "Reason"
        self.ok = status_code < 400
        self.content = body if isinstance(body, bytes) else json.dumps(body).encode("utf-8")

    def json(self) -> dict[str, Any]:
        if isinstance(self._body, bytes):
            raise ValueError("not JSON")
        return self._body


def _contents(text: str) -> bytes:
    """The raw body GitHub answers for `Accept: application/vnd.github.raw+json`."""
    return text.encode("utf-8")


class FakeGitHub:
    """Routes `requests.request` calls by (method, path) and records them."""

    def __init__(self, push: bool = True):
        self.calls: list[tuple[str, str, dict[str, Any] | None]] = []
        self.kwargs: list[dict[str, Any]] = []
        self.routes: dict[tuple[str, str], list[FakeResponse]] = {}
        self.route("GET", f"/repos/{REPO}", 200, {"full_name": REPO, "permissions": {"push": push, "pull": True}})
        self.route("GET", f"/repos/{REPO}/git/ref/heads/main", 200, {"object": {"sha": BASE_SHA}})
        self.route("GET", f"/repos/{REPO}/git/commits/{BASE_SHA}", 200, {"sha": BASE_SHA, "tree": {"sha": BASE_TREE}})
        for file in FILES:
            self.route("GET", f"/repos/{REPO}/contents/{file.path}?ref={BASE_SHA}", 200, _contents(file.before))

    def route(self, method: str, path: str, status: int, body: dict[str, Any] | bytes) -> None:
        """Answer `method path` with `status` and `body`; several routes for one path answer in turn, the last repeatedly."""
        self.routes.setdefault((method, path), []).append(FakeResponse(status, body))

    def set_route(self, method: str, path: str, status: int, body: dict[str, Any] | bytes) -> None:
        self.routes[(method, path)] = [FakeResponse(status, body)]

    def target_routes(self, target: str) -> None:
        self.route("POST", f"/repos/{target}/git/trees", 201, {"sha": "tree-sha"})
        self.route("POST", f"/repos/{target}/git/commits", 201, {"sha": "commit-sha"})
        self.route("POST", f"/repos/{target}/git/refs", 201, {"ref": f"refs/heads/{BRANCH}"})
        self.route("POST", f"/repos/{REPO}/pulls", 201, {"html_url": "https://github.com/owner/repo/pull/7", "number": 7})

    def __call__(self, method: str, url: str, **kwargs: Any) -> FakeResponse:
        self.assert_url(url)
        path = url[len(API):]
        self.calls.append((method, path, kwargs.get("json")))
        self.kwargs.append(kwargs)
        responses = self.routes.get((method, path))
        if not responses:
            return FakeResponse(404, {"message": "Not Found"})
        return responses.pop(0) if len(responses) > 1 else responses[0]

    @staticmethod
    def assert_url(url: str) -> None:
        if not url.startswith(API + "/"):
            raise AssertionError(f"unexpected URL {url}")

    def body(self, method: str, path: str) -> dict[str, Any]:
        for call in self.calls:
            if call[0] == method and call[1] == path:
                assert call[2] is not None
                return call[2]
        raise AssertionError(f"no call {method} {path}")


def _open(fake: FakeGitHub, **kwargs: Any) -> PullRequestResult:
    with patch(f"{MODULE}.requests.request", side_effect=fake):
        return open_pull_request(TOKEN, REPO, "main", FILES, "Title", "Body", BRANCH, **kwargs)


class OpenPullRequestTest(unittest.TestCase):

    def test_push_access(self):
        fake = FakeGitHub(push=True)
        fake.target_routes(REPO)
        result = _open(fake)
        self.assertEqual([(m, p) for m, p, _ in fake.calls], [
            ("GET", f"/repos/{REPO}"),
            ("GET", f"/repos/{REPO}/git/ref/heads/main"),
            ("GET", f"/repos/{REPO}/git/commits/{BASE_SHA}"),
            ("GET", f"/repos/{REPO}/contents/docs/guide.md?ref={BASE_SHA}"),
            ("GET", f"/repos/{REPO}/contents/docs/guide-llm.md?ref={BASE_SHA}"),
            ("POST", f"/repos/{REPO}/git/trees"),
            ("POST", f"/repos/{REPO}/git/commits"),
            ("POST", f"/repos/{REPO}/git/refs"),
            ("POST", f"/repos/{REPO}/pulls"),
        ])
        # The base tree is the base commit's tree, not the commit itself
        self.assertEqual(fake.body("POST", f"/repos/{REPO}/git/trees"), {
            "base_tree": BASE_TREE,
            "tree": [
                {"path": "docs/guide.md", "mode": "100644", "type": "blob", "content": "# Guide\n\nnew\n"},
                {"path": "docs/guide-llm.md", "mode": "100644", "type": "blob", "content": "# LLM\n\nnew\n"},
            ],
        })
        self.assertEqual(fake.body("POST", f"/repos/{REPO}/git/commits"), {"message": "Title\n\nBody", "tree": "tree-sha", "parents": [BASE_SHA]})
        self.assertEqual(fake.body("POST", f"/repos/{REPO}/git/refs"), {"ref": f"refs/heads/{BRANCH}", "sha": "commit-sha"})
        self.assertEqual(fake.body("POST", f"/repos/{REPO}/pulls"), {"title": "Title", "body": "Body", "head": BRANCH, "base": "main", "maintainer_can_modify": True})
        self.assertEqual(result, PullRequestResult(url="https://github.com/owner/repo/pull/7", number=7, branch=BRANCH, fork=None))

    def test_no_push_access_forks(self):
        fork = "forkowner/repo"
        fake = FakeGitHub(push=False)
        fake.route("POST", f"/repos/{REPO}/forks", 202, {"full_name": fork, "owner": {"login": "forkowner"}})
        fake.route("GET", f"/repos/{fork}/git/ref/heads/main", 404, {"message": "Not Found"})
        fake.route("GET", f"/repos/{fork}/git/ref/heads/main", 200, {"object": {"sha": "stale-sha"}})
        fake.target_routes(fork)
        with patch(f"{MODULE}.time.sleep") as sleep:
            result = _open(fake)
        sleep.assert_called_once_with(1)
        self.assertEqual(fake.body("POST", f"/repos/{REPO}/forks"), {"default_branch_only": True})
        self.assertEqual([(m, p) for m, p, _ in fake.calls][5:], [
            ("POST", f"/repos/{REPO}/forks"),
            ("GET", f"/repos/{fork}/git/ref/heads/main"),
            ("GET", f"/repos/{fork}/git/ref/heads/main"),
            ("POST", f"/repos/{fork}/git/trees"),
            ("POST", f"/repos/{fork}/git/commits"),
            ("POST", f"/repos/{fork}/git/refs"),
            ("POST", f"/repos/{REPO}/pulls"),
        ])
        # The upstream base commit is the parent, not the fork's default branch
        self.assertEqual(fake.body("POST", f"/repos/{fork}/git/commits")["parents"], [BASE_SHA])
        self.assertEqual(fake.body("POST", f"/repos/{fork}/git/trees")["base_tree"], BASE_TREE)
        self.assertEqual(fake.body("POST", f"/repos/{REPO}/pulls")["head"], f"forkowner:{BRANCH}")
        self.assertEqual(result.fork, fork)
        self.assertEqual(result.number, 7)

    def test_fork_never_ready(self):
        fork = "forkowner/repo"
        fake = FakeGitHub(push=False)
        fake.route("POST", f"/repos/{REPO}/forks", 202, {"full_name": fork, "owner": {"login": "forkowner"}})
        with patch(f"{MODULE}.time.sleep") as sleep, patch(f"{MODULE}.time.monotonic", side_effect=itertools.count(0, 4)):
            with self.assertRaises(GitHubError) as ctx:
                _open(fake)
        self.assertEqual(ctx.exception.status_code, 502)
        self.assertEqual(str(ctx.exception), "GitHub did not finish creating the fork of owner/repo. Try again in a minute.")
        self.assertGreater(sleep.call_count, 0)
        self.assertFalse(any(m == "POST" and "git/" in p for m, p, _ in fake.calls))

    def test_upstream_changed_since_preview(self):
        fake = FakeGitHub(push=True)
        fake.set_route("GET", f"/repos/{REPO}/contents/docs/guide-llm.md?ref={BASE_SHA}", 200, _contents("# LLM\n\nmoved on\n"))
        fake.target_routes(REPO)
        with self.assertRaises(GitHubError) as ctx:
            _open(fake)
        self.assertEqual(ctx.exception.status_code, 409)
        self.assertEqual(ctx.exception.message, "The guide changed upstream since the preview. Close and reopen the dialog to see the current changes.")
        self.assertFalse(any(m == "POST" for m, _, _ in fake.calls))

    def test_file_deleted_upstream_is_a_conflict(self):
        fake = FakeGitHub(push=True)
        fake.set_route("GET", f"/repos/{REPO}/contents/docs/guide.md?ref={BASE_SHA}", 404, {"message": "Not Found"})
        with self.assertRaises(GitHubError) as ctx:
            _open(fake)
        self.assertEqual(ctx.exception.status_code, 409)
        self.assertFalse(any(m == "POST" for m, _, _ in fake.calls))

    def test_token_rejected(self):
        fake = FakeGitHub()
        fake.set_route("GET", f"/repos/{REPO}", 401, {"message": "Bad credentials"})
        with self.assertRaises(GitHubError) as ctx:
            _open(fake)
        self.assertEqual(ctx.exception.status_code, 422)
        self.assertEqual(str(ctx.exception), 'GitHub rejected the token. Update it under "GitHub" in your API keys.')

    def test_no_access_to_repository(self):
        for status in (403, 404):
            fake = FakeGitHub()
            fake.set_route("GET", f"/repos/{REPO}", status, {"message": "Not Found"})
            with self.assertRaises(GitHubError) as ctx:
                _open(fake)
            self.assertEqual(ctx.exception.status_code, 422)
            self.assertEqual(str(ctx.exception), "The GitHub token has no access to owner/repo.")

    def test_other_github_error(self):
        fake = FakeGitHub(push=True)
        fake.route("POST", f"/repos/{REPO}/git/trees", 500, {"message": "boom"})
        with self.assertRaises(GitHubError) as ctx:
            _open(fake)
        self.assertEqual(ctx.exception.status_code, 502)
        self.assertEqual(str(ctx.exception), "GitHub request failed (500): boom")

    def test_token_hygiene(self):
        fake = FakeGitHub(push=True)
        fake.route("POST", f"/repos/{REPO}/git/trees", 500, {"message": f"Bad header Authorization: Bearer {TOKEN}"})
        with self.assertLogs(MODULE, level=logging.DEBUG) as logs, self.assertRaises(GitHubError) as ctx:
            _open(fake)
        self.assertNotIn(TOKEN, str(ctx.exception))
        self.assertNotIn(TOKEN, ctx.exception.message)
        self.assertNotIn(TOKEN, "\n".join(logs.output))
        self.assertTrue(logs.output)
        # The token is only in the Authorization header
        for kwargs in fake.kwargs:
            without_headers = {k: v for k, v in kwargs.items() if k != "headers"}
            self.assertNotIn(TOKEN, json.dumps(without_headers, default=str))

    def test_network_error_does_not_leak(self):
        import requests
        with patch(f"{MODULE}.requests.request", side_effect=requests.ConnectionError(f"failed {TOKEN}")), self.assertLogs(MODULE, level=logging.WARNING) as logs:
            with self.assertRaises(GitHubError) as ctx:
                open_pull_request(TOKEN, REPO, "main", FILES, "Title", "Body", BRANCH)
        self.assertEqual(ctx.exception.status_code, 502)
        self.assertEqual(str(ctx.exception), "GitHub request failed: ConnectionError")
        self.assertNotIn(TOKEN, str(ctx.exception))
        self.assertNotIn(TOKEN, "\n".join(logs.output))
        # No chained exception refers to the failed request (and its headers)
        self.assertIsNone(ctx.exception.__context__)
        self.assertIsNone(ctx.exception.__cause__)

    def test_headers_and_timeout(self):
        fake = FakeGitHub(push=True)
        fake.target_routes(REPO)
        _open(fake)
        for (_, path, _), kwargs in zip(fake.calls, fake.kwargs):
            # File contents are fetched as the raw body (no base64, no 1 MB limit)
            accept = "application/vnd.github.raw+json" if "/contents/" in path else "application/vnd.github+json"
            self.assertEqual(kwargs["headers"], {
                "Authorization": f"Bearer {TOKEN}",
                "Accept": accept,
                "X-GitHub-Api-Version": "2022-11-28",
            }, path)
            self.assertEqual(kwargs["timeout"], 15)

    def test_undecodable_contents_are_502(self):
        fake = FakeGitHub(push=True)
        fake.set_route("GET", f"/repos/{REPO}/contents/docs/guide.md?ref={BASE_SHA}", 200, b"\xff\xfe")
        with self.assertRaises(GitHubError) as ctx:
            _open(fake)
        self.assertEqual(ctx.exception.status_code, 502)
        self.assertEqual(str(ctx.exception), "GitHub request failed: UnicodeDecodeError")
        self.assertIsNone(ctx.exception.__context__)
        self.assertFalse(any(m == "POST" for m, _, _ in fake.calls))

    def test_percent_encoded_path(self):
        # ProposedFile.path comes from the blob URL and may be percent-encoded
        files = [ProposedFile("docs/guide%20rules.md", "# Guide\n\nold\n", "# Guide\n\nnew\n")]
        fake = FakeGitHub(push=True)
        fake.route("GET", f"/repos/{REPO}/contents/docs/guide%20rules.md?ref={BASE_SHA}", 200, _contents(files[0].before))
        fake.target_routes(REPO)
        with patch(f"{MODULE}.requests.request", side_effect=fake):
            open_pull_request(TOKEN, REPO, "main", files, "Title", "Body", BRANCH)
        self.assertIn(("GET", f"/repos/{REPO}/contents/docs/guide%20rules.md?ref={BASE_SHA}"), [(m, p) for m, p, _ in fake.calls])
        self.assertEqual(fake.body("POST", f"/repos/{REPO}/git/trees")["tree"][0]["path"], "docs/guide rules.md")

    def test_failed_pull_request_deletes_the_branch(self):
        for push, target in ((True, REPO), (False, "forkowner/repo")):
            with self.subTest(push=push):
                fake = FakeGitHub(push=push)
                if not push:
                    fake.route("POST", f"/repos/{REPO}/forks", 202, {"full_name": target, "owner": {"login": "forkowner"}})
                    fake.route("GET", f"/repos/{target}/git/ref/heads/main", 200, {"object": {"sha": "stale-sha"}})
                fake.route("POST", f"/repos/{target}/git/trees", 201, {"sha": "tree-sha"})
                fake.route("POST", f"/repos/{target}/git/commits", 201, {"sha": "commit-sha"})
                fake.route("POST", f"/repos/{target}/git/refs", 201, {"ref": f"refs/heads/{BRANCH}"})
                fake.route("POST", f"/repos/{REPO}/pulls", 422, {"message": "Validation Failed"})
                # The cleanup's own failure is ignored
                fake.route("DELETE", f"/repos/{target}/git/refs/heads/{BRANCH}", 500, {"message": "boom"})
                with self.assertRaises(GitHubError) as ctx:
                    _open(fake)
                self.assertEqual(str(ctx.exception), "GitHub request failed (422): Validation Failed")
                self.assertEqual(fake.calls[-1][:2], ("DELETE", f"/repos/{target}/git/refs/heads/{BRANCH}"))

    def test_invalid_repo_id_makes_no_request(self):
        for repo_id in ("owner/repo/extra", "owner", "../repo", "owner/..", "./repo", "owner/re po", "owner/repo?x=1", ""):
            with self.subTest(repo_id=repo_id), patch(f"{MODULE}.requests.request") as request:
                with self.assertRaises(GitHubError) as ctx:
                    open_pull_request(TOKEN, repo_id, "main", FILES, "Title", "Body", BRANCH)
                self.assertEqual(ctx.exception.status_code, 422)
                self.assertEqual(str(ctx.exception), f"The GitHub token has no access to {repo_id}.")
                request.assert_not_called()

    def test_invalid_fork_name(self):
        fake = FakeGitHub(push=False)
        fake.route("POST", f"/repos/{REPO}/forks", 202, {"full_name": "forkowner/../x", "owner": {"login": "forkowner"}})
        with self.assertRaises(GitHubError) as ctx:
            _open(fake)
        self.assertEqual(ctx.exception.status_code, 422)
        self.assertEqual(str(ctx.exception), "The GitHub token has no access to forkowner/../x.")
        self.assertEqual(fake.calls[-1][:2], ("POST", f"/repos/{REPO}/forks"))

    def test_fork_without_owner(self):
        fork = "forkowner/repo"
        fake = FakeGitHub(push=False)
        fake.route("POST", f"/repos/{REPO}/forks", 202, {"full_name": fork, "owner": None})
        fake.route("GET", f"/repos/{fork}/git/ref/heads/main", 200, {"object": {"sha": "stale-sha"}})
        fake.target_routes(fork)
        result = _open(fake)
        self.assertEqual(fake.body("POST", f"/repos/{REPO}/pulls")["head"], f"forkowner:{BRANCH}")
        self.assertEqual(result.fork, fork)


class BranchNameTest(unittest.TestCase):

    def test_branch_name(self):
        self.assertEqual(pull_request_branch_name("Data correction", datetime(2026, 10, 28, 9, 5, 7, tzinfo=UTC)), "pdf-tei-editor/data-correction-20261028-090507")

    def test_branch_name_in_utc(self):
        from datetime import timedelta, timezone
        now = datetime(2026, 10, 28, 11, 5, 7, tzinfo=timezone(timedelta(hours=2)))
        self.assertEqual(pull_request_branch_name("Data correction", now), "pdf-tei-editor/data-correction-20261028-090507")


class DefaultTextTest(unittest.TestCase):

    def test_human_only(self):
        self.assertEqual(
            default_pull_request_text("Data\ncorrection", "alice", True, False, False, []),
            ("Annotation rules update: Data correction", "Proposed with the PDF-TEI-Editor by alice.\n\nIncludes: guide section."),
        )

    def test_both_in_sync(self):
        self.assertEqual(
            default_pull_request_text("Data correction", "alice", True, True, True, []),
            ("Annotation rules update: Data correction", "Proposed with the PDF-TEI-Editor by alice.\n\nIncludes: guide section and machine rules.\nThe sync marker of the machine rules is updated; the pair is in sync."),
        )

    def test_machine_only_outdated_with_upstream_change(self):
        self.assertEqual(
            default_pull_request_text("Data correction", "alice", False, True, False, ["docs/guidelines-llm.md"]),
            ("Annotation rules update: Data correction", "Proposed with the PDF-TEI-Editor by alice.\n\nIncludes: machine rules.\nThe machine rules are marked as outdated.\nNote: the section in docs/guidelines-llm.md changed upstream since the proposer's version; this pull request replaces those changes."),
        )


class SecretServiceTest(unittest.TestCase):

    def tearDown(self):
        unregister_secret_service(GITHUB_SECRET_SERVICE)

    def test_register(self):
        register_github_secret_service()
        service = SecretServiceRegistry.get("github")
        assert service is not None
        self.assertEqual(service.id, "github")
        self.assertEqual(service.label, "GitHub")
        self.assertIn("classic token with the public_repo scope", service.description)
        self.assertEqual(service.help_url, "https://github.com/settings/tokens/new?scopes=public_repo&description=PDF-TEI%20Editor%20document%20rules")


if __name__ == "__main__":
    unittest.main()
