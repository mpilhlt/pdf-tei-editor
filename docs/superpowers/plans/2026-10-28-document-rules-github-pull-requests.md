# Document Rules Pull Requests via GitHub Token (Issue #666, Phase 4b) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In the "Propose upstream" dialog, a reviewer can open a GitHub pull request with the proposal directly, using a GitHub token stored in their API keys. The patch download from Phase 4 stays.

**Architecture:**
- A backend module `github_pull_request.py` turns the Phase 4 proposal files into one commit on a new branch, using GitHub's Git Data API, and opens a pull request.
  - With push access to the guide repository, the branch goes there.
  - Without it, the module forks the repository to the token owner's account and opens a cross-repository pull request.
- Before committing, it checks that each file on the base commit still equals the `before` text of the proposal. If not, it refuses, so a pull request never reverts a change the user did not see.
- The token is a per-user secret, service id `github`, registered in core. A missing token goes through the existing 428 key prompt.
- The dialog gains a prefilled, editable title and description, and a "Create pull request" button. Both appear only for guides on GitHub.

**Tech Stack:** FastAPI, `requests`, the per-user secret store (`fastapi_app/lib/secrets/`), Phase 4 `upstream_proposal.py`, vanilla JS + Shoelace, `api-keys.withKeyPrompt`; unittest, `node --experimental-test-module-mocks --test`, Playwright.

**Spec:** GitHub issue mpilhlt/pdf-tei-editor#666, "Proposed design" §5 (transport 2), "Decisions" 2, "Phases" 4.

Planning decisions (2026-10-28, user):
- **Fork policy is automatic.** With push access, the branch goes into the guide repository; otherwise into the user's fork, which is created if needed.
- **PR text is editable and prefilled.** The dialog has title and description fields, prefilled by the backend.
- **GitHub only.** GitLab guides keep the patch download, and the pull-request controls are hidden for them.

APIs to use:
- `fastapi_app/lib/doc_rules/upstream_proposal.py`:
  - `build_upstream_proposal(...) -> UpstreamProposal(files, patch, filename, branch, upstream_changed, in_sync)`;
  - `ProposalError`, `patch_filename`, `_includes`, `_one_line`, `_adapter`.
- `fastapi_app/lib/core/git_forge_adapters.py`: `GitHubAdapter.parse_repo_path(url) -> (repo_id "owner/repo", path)`.
- `fastapi_app/lib/secrets`: `register_secret_service`, `unregister_secret_service`, `require_user_secret(username, service)` (raises `MissingSecretError`), `secret_required_detail`.
- Router: the `propose_patch` route and its error mapping in `fastapi_app/routers/document_rules.py`. The 428 pattern is the one already used by `/update-from-guide`.
- Frontend `app/src/plugins/document-rules.js`:
  - `_openProposeDialog`, `_refreshProposal`, `_refreshProposalSafely`, `_clearProposal`, `_proposal`;
  - the propose sub-dialog template `app/src/templates/document-rules-propose-dialog.html`;
  - `this.getDependency('api-keys').withKeyPrompt(fn)`.

## Global Constraints

- **Branch and PR.**
  - Branch `feat/666-phase4b-github-pr` in the worktree `/Users/cboulanger/Code/pdf-tei-editor/.claude/worktrees/feat+666-two-layer-document-rules`.
  - The PR goes to `devel`.
  - Commits say `Refs #666` and must not close the issue.
- **Secret service.**
  - Registered at startup in `lifespan`, with:
    - id `github`
    - label `GitHub`
    - description `Personal access token used to open pull requests with document rule changes.`
    - help URL `https://github.com/settings/tokens`
  - The token is never logged, returned, or included in exception or response text.
- **GitHub API.**
  - Base `https://api.github.com`.
  - Headers `Authorization: Bearer <token>`, `Accept: application/vnd.github+json`, `X-GitHub-Api-Version: 2022-11-28`.
  - Timeout 15 s.
  - Only the guide's own `owner/repo` and the token owner's fork are touched.
- **Branch name.** `pdf-tei-editor/<slug>-<YYYYMMDD-HHMMSS>`, in UTC. `<slug>` is `patch_filename(label)` without the `-rules.patch` suffix.
- **Commit.**
  - One commit with all changed files, parent = the base commit, file mode `100644`.
  - The message is the PR title, a blank line, then the PR description.
- **PR.** `maintainer_can_modify: true`. The head is `<fork_owner>:<branch>` for a fork, otherwise `<branch>`.
- **Default PR text.**
  - The backend returns both texts in the propose-patch response.
  - Title: `Annotation rules update: <label>`, with the label passed through `_one_line`.
  - Description lines:
    - `Proposed with the PDF-TEI-Editor by <username>.`
    - a blank line;
    - `Includes: <guide section | machine rules | guide section and machine rules>.`
    - only when the machine rules are included: if `in_sync`, `The sync marker of the machine rules is updated; the pair is in sync.`, otherwise `The machine rules are marked as outdated.`
    - for each path in `upstream_changed`: `Note: the section in <path> changed upstream since the proposer's version; this pull request replaces those changes.`
- **Error texts, exact.** Every case is a 422 unless noted.
  - Guide not on GitHub: `Pull requests can only be created for guides on GitHub. Download the patch instead.`
  - Empty title: `The pull request needs a title.`
  - A file changed upstream between preview and creation (409): `The guide changed upstream since the preview. Close and reopen the dialog to see the current changes.`
  - The token is rejected (GitHub 401): `GitHub rejected the token. Update it under "GitHub" in your API keys.`
  - The token has no read access to the repository (GitHub 403/404 on the repository): `The GitHub token has no access to <owner/repo>.`
  - The fork is not ready after 10 s (502): `GitHub did not finish creating the fork of <owner/repo>. Try again in a minute.`
  - Any other GitHub error (502): `GitHub request failed (<status>): <GitHub's "message" field>`.
  - A missing token → 428 via `secret_required_detail`.
- **UI copy, exact.**
  - Title field label: `Pull request title`.
  - Description field label: `Description`.
  - Button: `Create pull request`.
  - Success notice: `Pull request #<number> created.`, followed by a link with the text `Open on GitHub` (`target="_blank"`, `rel="noopener"`).
  - For a fork, an extra sentence after the link: `It was opened from your fork <fork full name>.`
- **Code style.**
  - `api-client-v1.js` is updated in the same commit as the routes.
  - JSDoc `@import` only.
  - Precise Python types.
  - Run `npm run build:ui-types` after template changes.
- **Tests.**
  - Python tests are `unittest.TestCase`, run with `uv run python -m pytest <file> -v`.
  - JS tests run with `node --experimental-test-module-mocks --test <file>`.
  - Before finishing, run `npm run test:unit`, then `npm run test:e2e`, one at a time. The E2E run needs network access, so run it unsandboxed.

## Review Focus

1. **Token hygiene.** The token appears only in the `Authorization` header. A `GitHubError` message, a log line or a response never contains it, even when GitHub echoes request details. Test: a failing call with token `ghp_SECRET` → the `str()` of the error and the captured logs do not contain `ghp_SECRET`. (Task 1)
2. **Upstream moved between preview and creation.** The default branch's head commit has a file whose contents ≠ `before` → 409. No branch, commit or PR is created. (Task 1)
3. **No push access.**
   - The fork path is taken.
   - A fork that already exists is reused: GitHub's create-fork call returns the existing fork.
   - A fork still being created is polled until ready, up to 10 s, and then fails with the exact 502 text.
   - The upstream base commit is used as the parent, not the fork's possibly stale default branch. (Task 1)
4. **Edited PR text survives a refresh.** The user edits the title or description, then toggles a checkbox: their text is kept. Untouched fields take the new default. (Task 3)
5. **A guide not on GitHub.** The propose-patch response has `can_open_pull_request: false` → the pull-request controls are hidden. Calling the route directly → 422 with the exact text. (Tasks 2, 3)

---

### Task 1: `github_pull_request.py`: commit, branch, fork and pull request

**Files:**
- Create: `fastapi_app/lib/doc_rules/github_pull_request.py`
- Modify: `fastapi_app/main.py`, in `lifespan`, next to the other doc-rules startup code. Register the `github` secret service there.
- Test: `tests/unit/fastapi/test_doc_rules_github_pull_request.py`

**Interfaces:**
- Produces:
  - `GITHUB_SECRET_SERVICE: str = "github"`
  - `register_github_secret_service() -> None`, which calls `register_secret_service` with the Global Constraints values.
  - `class GitHubError(Exception)`. Attributes: `status_code: int` (the HTTP status the route returns: 422, 409 or 502) and `message: str` (the exact user text). `str(e) == e.message`.
  - `@dataclass(frozen=True) class PullRequestResult`, with `url: str` (the html_url), `number: int`, `branch: str`, `fork: str | None` (the fork's full name, or None).
  - `pull_request_branch_name(label: str, now: datetime) -> str`
  - `default_pull_request_text(label: str, username: str, include_human: bool, include_machine: bool, in_sync: bool, upstream_changed: list[str]) -> tuple[str, str]` returns `(title, body)` exactly as in Global Constraints.
  - `open_pull_request(token: str, repo_id: str, base_branch: str, files: list[ProposedFile], title: str, body: str, branch: str, *, fork_wait_seconds: float = 10.0) -> PullRequestResult`
- Algorithm of `open_pull_request`:
  1. `GET /repos/{repo_id}`. 401 → token error; 403 or 404 → access error. Read `permissions.push`.
  2. `GET /repos/{repo_id}/git/ref/heads/{base_branch}` gives `base_sha`.
  3. For each file, `GET /repos/{repo_id}/contents/{path}?ref={base_sha}`, base64-decode as UTF-8, and compare with `file.before`. Any difference → 409, before anything is written.
  4. Target repository:
     - with `push`, the target is `repo_id`;
     - otherwise `POST /repos/{repo_id}/forks` with `{"default_branch_only": true}`. The target is the returned `full_name`. Poll `GET /repos/{target}/git/ref/heads/{base_branch}` until it answers 200 or `fork_wait_seconds` pass. Use a `time.monotonic` deadline and a 1 s sleep, both patchable in tests.
  5. `POST /repos/{target}/git/trees` with `{"base_tree": base_sha, "tree": [{"path", "mode": "100644", "type": "blob", "content": after}]}`.
  6. `POST /repos/{target}/git/commits` with `{"message": f"{title}\n\n{body}", "tree", "parents": [base_sha]}`.
  7. `POST /repos/{target}/git/refs` with `{"ref": f"refs/heads/{branch}", "sha"}`.
  8. `POST /repos/{repo_id}/pulls` with `{"title", "body", "head", "base": base_branch, "maintainer_can_modify": true}`.
- All requests go through one private `_request(method, path, token, json=None) -> dict` that maps errors as in Global Constraints. Log the method, the path and the status only.

- [ ] **Step 1: Write the failing tests.** Mock `requests.request` with a fake that routes by `(method, path)` and records calls.
  - Push access: the call sequence is exactly steps 1–3 and 5–8 against `repo_id`. The tree carries the `after` texts, the commit's parent is `base_sha`, the head is the bare branch, and the result has `fork=None`.
  - No push access: a fork is created, the ref poll succeeds on its second try, the tree, commit and ref go to the fork, the PR goes to `repo_id` with head `<forkowner>:<branch>`, and `fork == "forkowner/repo"`.
  - The fork never becomes ready → `GitHubError(502)` with the exact text; the sleep is patched.
  - The contents at `base_sha` differ from `before` → `GitHubError(409)` with the exact text, and no POST was made.
  - 401 → the exact token text; 404 on the repository → the exact access text; 500 with `{"message": "boom"}` → `GitHub request failed (500): boom`.
  - Token hygiene, Review Focus 1.
  - The headers carry Bearer, Accept and API version, and the timeout is 15.
  - `pull_request_branch_name("Data correction", datetime(2026,10,28,9,5,7,tzinfo=UTC)) == "pdf-tei-editor/data-correction-20261028-090507"`.
  - `default_pull_request_text`: human only; both layers with `in_sync` true; machine only with `in_sync` false; one `upstream_changed` path. Compare whole strings.
  - `register_github_secret_service()` registers id, label, description and help URL. Clean up with `unregister_secret_service` in `tearDown`.
- [ ] **Steps 2–4:** run the tests and watch them FAIL; implement; watch them PASS.
- [ ] **Step 5: Commit** `feat(document-rules): open GitHub pull requests for rule proposals (Refs #666)`.

### Task 2: Routes

**Files:**
- Modify:
  - `fastapi_app/routers/document_rules.py`
  - `fastapi_app/lib/models/models_document_rules.py`
  - `app/src/modules/api-client-v1.js`
- Test: `tests/unit/fastapi/test_document_rules_router.py`

**Interfaces:**
- Consumes: Task 1.
- Produces:
  - `ProposePatchResponse` gains three fields:
    - `can_open_pull_request: bool`: true iff the human URL's adapter is the GitHub adapter;
    - `pull_request_title: str`;
    - `pull_request_body: str`.

    The last two come from `default_pull_request_text`, with the current username.
  - `ProposePullRequestRequest(ProposePatchRequest)` adds `title: str` and `body: str`.
  - `ProposePullRequestResponse{url: str, number: int, branch: str, fork: str | None}`.
  - Route `POST /document-rules/propose-pull-request`: plain `def`, gated by `require_reviewer_or_admin`. Order of checks:
    1. Empty title, after `strip()` → 422.
    2. Not GitHub → 422.
    3. `require_user_secret(username, GITHUB_SECRET_SERVICE)` → 428 on `MissingSecretError`.
    4. `build_upstream_proposal(...)`, with the same error mapping as `propose_patch`. Factor that mapping into a shared helper instead of copying it.
    5. `open_pull_request(token, repo_id, proposal.branch, proposal.files, title, body, pull_request_branch_name(label, datetime.now(UTC)))`.
    6. `GitHubError` → `HTTPException(e.status_code, e.message)`.
  - Client: `documentRulesProposePullRequest(requestBody)` plus the typedefs, and the three new fields on the propose-patch typedef.
- [ ] **Step 1: Write the failing tests.**
  - propose-patch returns `can_open_pull_request` true for the github.com fossil fixture URLs, false for a GitLab URL, and the default texts.
  - propose-pull-request:
    - 200 with `open_pull_request` patched; assert that it got the token and that the files come from the proposal;
    - 428 without a stored token, with a detail naming the service `github`;
    - 422 for a GitLab URL and for an empty title;
    - `GitHubError(409)` → 409 with its message;
    - 403 for a non-reviewer.
- [ ] **Steps 2–4:** FAIL, implement, PASS. Then run `npm run test:unit:fastapi`.
- [ ] **Step 5: Commit** `feat(document-rules): propose-pull-request route (Refs #666)`.

### Task 3: Pull-request controls in the "Propose upstream" dialog

**Files:**
- Modify: `app/src/templates/document-rules-propose-dialog.html` (regenerate its `.types.js`), `app/src/plugins/document-rules.js`
- Test: `tests/unit/js/document-rules.test.js`, plus the propose-dialog template test.

**Interfaces:**
- Consumes: `documentRulesProposePullRequest`, and the new propose-patch fields.
- Produces:
  - Template parts, placed between `files` and `hint`, inside a `prSection` div that is hidden by default:
    - `prTitle`: an `<sl-input>` labelled `Pull request title`;
    - `prBody`: an `<sl-textarea rows="5">` labelled `Description`;
    - `prResult`: a div.
  - Footer part `createPrBtn`: an `<sl-button>` `Create pull request`, placed before `downloadBtn`, disabled by default.
  - `_refreshProposal`:
    - on success, show `prSection` and `createPrBtn` iff `can_open_pull_request`, and enable `createPrBtn`;
    - fill `prTitle` and `prBody` with the defaults, unless the user has edited that field since the dialog opened. Track the edits with an `sl-input` listener and two flags, reset in `_resetProposeDialog`;
    - while a request is pending, and after an error, disable `createPrBtn`.
  - `_onCreatePullRequest()`:
    - disables the button and clears `prResult`;
    - calls `withKeyPrompt(() => documentRulesProposePullRequest({...same flags and label..., title, body}))`;
    - on success renders the success notice with the link into `prResult`, built with DOM APIs, not `innerHTML`, and keeps the button disabled, so a second click does not open a duplicate;
    - on error shows `error.message` in `prResult` and re-enables the button.
- [ ] **Step 1: Write the failing tests.**
  - The controls are hidden when `can_open_pull_request` is false and shown when true.
  - The defaults are filled; an edited title survives a checkbox toggle while an untouched description is replaced (Review Focus 4).
  - A click sends the edited title and body through `withKeyPrompt`.
  - Success: the notice text, the link `href`/`target`/`rel`, the fork sentence, and the button stays disabled.
  - An error shows its message and re-enables the button.
  - Template tests check the copy and the parts.
- [ ] **Steps 2–4:** FAIL, implement, PASS. Then run `npm run test:unit:js`.
- [ ] **Step 5: Commit** `feat(document-rules): create pull requests from the "Propose upstream" dialog (Refs #666)`.

### Task 4: E2E, docs, full suite, screenshot

**Files:**
- Modify:
  - `tests/e2e/tests/document-rules.spec.js`: inside the serial `two-layer categories` describe.
  - `docs/user-manual/unit-review.md`
  - `docs/development/tei-header-integrations.md`

**Steps:**

- [ ] **Step 1: E2E test** `creates a pull request from the propose dialog`.
  - Mock `**/api/v1/document-rules/propose-patch` (including `can_open_pull_request: true` and the default texts) and `**/api/v1/document-rules/propose-pull-request`. Explain in a comment that no real GitHub call is possible.
  - Open the dialog. Edit the title, click "Create pull request", and assert:
    - the captured request body carries the edited title;
    - the success notice and the link's `href`.
  - Clean up in `finally`.
- [ ] **Step 2: Run** `npm run test:e2e -- tests/e2e/tests/document-rules.spec.js` unsandboxed, and get PASS.
- [ ] **Step 3: Docs.**
  - User manual:
    - creating a token. A classic token with the `public_repo` scope works with or without push access. A fine-grained token needs "Contents" and "Pull requests" read/write on the guide repository, and with it the fork path may not work.
    - storing it under "GitHub" in the API keys;
    - the direct-versus-fork behaviour;
    - the 409 case.
  - Developer doc: the route, the call sequence, the fork polling, the freshness check, the branch name, and that GitLab keeps the patch only.
- [ ] **Step 4: Screenshot.** Show the dialog with the PR controls and a success notice, using the mocked routes as in Phase 4 via a temporary line in the spec. Save it to the session scratchpad and view it.
- [ ] **Step 5: Run** `npm run test:unit`, then `npm run test:e2e`, one at a time, and get PASS. Commit `docs(document-rules): pull requests via GitHub token (Refs #666)`.
