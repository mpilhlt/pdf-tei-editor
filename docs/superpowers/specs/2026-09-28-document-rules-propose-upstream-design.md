# Document Rules Registry — Propose Upstream Change — Design

Addendum to [2026-09-27-document-rules-registry-design.md](2026-09-27-document-rules-registry-design.md), which deferred "PR creation from an override to the source repo" and stored `base_url`/`base_hash` on each override in anticipation of it. This spec covers only the button that turns a saved override into a pull/merge request against the resource's upstream repo, feeding the frontend built in [2026-09-28-document-rules-frontend.md](../plans/2026-09-28-document-rules-frontend.md).

## Goal

From the resource editor dialog, let a user with a selected override open a pre-populated GitHub "propose new file" page (or, on GitLab, a plain edit page plus a clipboard copy) for the resource's upstream file, so they can turn a local override into a real PR/MR without leaving their own forge session.

## Non-goals

- No server-side git write (no commit, no branch creation, no PR/MR API call) happens on our backend.
- No stored GitHub/GitLab credentials, no OAuth flow, no per-user token management.
- No server-managed confirmation *state* (no "are you sure" persisted anywhere) — the confirm dialog covered below is purely transient, in-page UI.
- No use of the overrides table's `base_url`/`base_hash` fields (they remain reserved for the still-deferred "upstream changed" notice) — this feature only needs the resource's current `url`, already available to the frontend from `documentRulesList()`.

## Mechanism

Both forges are reached by building a URL that lets the *visitor's own, already-authenticated browser session* propose the change — no token, no backend-initiated network write.

- **GitHub**: `https://github.com/{owner}/{repo}/edit/{branch}/{path}?value={content}` prefills GitHub's web file editor with `content`. This is the same route GitHub's own UI uses for editing an existing file, and it's the route this feature actually needs - a resource being proposed upstream always already exists there (an override is layered on top of one). An earlier version of this design used `/new/{branch}?filename={path}&value={content}` instead, on the assumption that pointing `filename` at an existing path would behave as an edit; empirically it does prefill the editor, but commits as a create-blob operation, which GitHub rejects with "A file with the same name already exists" for a path that's already there. `/edit/` performs an update instead and was verified (via a real request) to accept `value` for both top-level and nested paths. If the visitor lacks push access, GitHub auto-forks and walks them into a PR; if they have write access, it offers to commit directly to a new branch and open a PR from there.
- **GitLab**: prefilling content via URL is an open, unimplemented GitLab feature request (gitlab-org/gitlab#337038) — there is no equivalent to `value`. GitLab only gets a plain deep link, `https://{host}/{project}/-/edit/{branch}/{path}`, with no content. The frontend compensates by copying the override text to the clipboard before opening the tab, so the user pastes it in.

Both need `{owner/project, branch, path}` parsed out of the resource's `url`, which may be either a forge "blob" URL (`github.com/.../blob/...`, `.../-/blob/...`) or an already-raw URL (`raw.githubusercontent.com/...`, `.../-/raw/...`) — both shapes occur in practice (an `interpretation`/`schema` resource's `<ref target>` is sometimes stored raw, sometimes as a blob URL pinned to a commit SHA by the extraction-time pinning flow in `annotation_rules_utils.py`).

**Branch resolution:** if the URL's ref segment is a plain name, it's used directly as the target branch. If it's a 40-hex commit SHA (post-pinning), the adapter looks up the repo's default branch via one unauthenticated, `UrlCache`-cached API call (`GET /repos/{owner}/{repo}` on GitHub, `GET /api/v4/projects/{id}` on GitLab) — the same pattern `resolve_ref_to_sha()` already uses for the reverse lookup. A ref that names a tag (rather than a branch or SHA) is not special-cased; the forge's own UI is left to reject it, which is an acceptable, rare edge case.

**Content-length guard:** if the fully-built GitHub URL would exceed 7,600 characters (a conservative margin under common browser/proxy URL limits), the `value` parameter is omitted and the resource is treated like GitLab — unprefilled edit page plus clipboard copy. This only matters for large schema-XML overrides; typical prompt/rule markdown overrides are well under the limit.

**Link derelativization:** a markdown resource's `original_text` has already had its relative links rewritten to this app's own internally-resolved absolute form by `_rewrite_relative_markdown_urls()` (see `fetch_rule_excerpt()` in `annotation_rules_utils.py`) - e.g. `[link](../other.md)` becomes `[link](https://raw.githubusercontent.com/{owner}/{repo}/{sha}/other.md)` - so previews render correctly outside the source repo. If that resolved form were proposed upstream unchanged, a same-repo relative link would end up permanently hardcoded to this app's resolution, including whatever commit SHA it happened to be pinned to at fetch time - visibly wrong in the resulting diff. Before building the propose-change URL, `text` is passed through `derelativize_markdown_urls()`, the inverse operation: any absolute URL that resolves (via the same adapter `parse_repo_path()` used for this) to the *same repository* as the resource's own `url` - regardless of which ref either one is pinned to - is rewritten back to a path relative to the resource's own directory. Absolute URLs into a different repo, or a non-git-forge URL, are left untouched. The endpoint returns this rewritten text in the response (see below) so the frontend's clipboard copy uses it too, not just the URL-embedded content.

## Backend design

### Adapter extension (`fastapi_app/lib/core/git_forge_adapters.py`)

A new method is added to `BaseGitForgeAdapter` rather than widening the existing `matches()`/`to_raw_url()`/`strip_ref()` contracts, which several other call sites (`resolve_forge_permalink`, `fetch_rule_excerpt`, `normalize_resource_key`) already depend on and which assume a blob-shaped URL. Recognizing raw URLs there too would change those call sites' behavior as a side effect. Keeping this as an independent method avoids that risk entirely:

```python
@dataclass(frozen=True)
class ProposeChangeTarget:
    url: str
    content_prefilled: bool

class BaseGitForgeAdapter(ABC):
    ...
    @abstractmethod
    def build_propose_change_url(self, url: str, text: str) -> Optional[ProposeChangeTarget]:
        """
        Build a URL that lets the visitor's own forge session propose `text`
        as the new content of the file `url` points to (blob or raw form,
        any ref). Returns None if `url`'s owner/repo/ref/path can't be
        parsed. May resolve a SHA-pinned ref to the repo's default branch
        via one cached, unauthenticated API call (see "Branch resolution").
        """
```

- `GitHubAdapter.build_propose_change_url()` recognizes both `github.com/.../blob/...` and `raw.githubusercontent.com/...`. Builds `https://github.com/{owner}/{repo}/edit/{branch}/{path}?value={quote(text)}`; applies the length guard (omitting the `?value=...` query entirely, setting `content_prefilled=False`) when the built URL is too long.
- `GitLabAdapter.build_propose_change_url()` recognizes both `.../-/blob/...` and `.../-/raw/...`. Always builds `https://{host}/{project}/-/edit/{branch}/{path}` with `content_prefilled=False`.
- Neither adapter's `matches()` changes; `build_propose_change_url()` does its own URL-shape recognition independently, returning `None` if it doesn't recognize the URL at all.
- A second new method, `parse_repo_path(url) -> Optional[tuple[str, str]]`, parses a blob/raw URL (any ref) into `(repo_id, path)`, where `repo_id` identifies the repository independent of ref - the same URL-shape recognition as `build_propose_change_url()`, just exposing `(owner/repo, path)` (GitHub) or `(origin/project_path, path)` (GitLab) instead of building a target URL. This is what `derelativize_markdown_urls()` (`annotation_rules_utils.py`) uses to tell "same repo, different ref" apart from "a genuinely different URL" without needing forge-specific logic of its own.

### REST endpoint

Stateless — takes the resource's URL and text directly, no DB access, no new tables:

```python
class ProposeChangeUrlRequest(BaseModel):
    url: str
    text: str

class ProposeChangeUrlResponse(BaseModel):
    url: Optional[str]
    content_prefilled: bool
    text: str
```

`POST /api/v1/document-rules/propose-change-url`: first derelativizes `request.text` against `request.url` (see "Link derelativization" above), then iterates every registered adapter, calling `build_propose_change_url()` with the derelativized text on each until one returns non-`None`. Today's `GitForgeAdapterRegistry` only exposes `get_adapter_for()`, which is keyed on `matches()` and therefore not usable here (this endpoint must also handle raw-URL shapes `matches()` doesn't recognize) — add a small `all_adapters() -> list[BaseGitForgeAdapter]` accessor to the registry (mirroring `ResourceKindRegistry.all()`, which already exists for exactly this "iterate every registered implementation" need) rather than reusing `get_adapter_for()`. Returns `{url: null, content_prefilled: false, text}` if no adapter's `build_propose_change_url()` returns non-`None` (host not recognized) — not an error, same "never block the caller" posture as the existing adapter call sites. `text` is always the derelativized text, even when `url` is `None`.

Requires the same session auth as the rest of `/document-rules/*` (any authenticated user — this doesn't need reviewer/admin gating, since proposing an upstream change is not a privileged action).

## Frontend design

New footer button in `document-rules-editor-dialog.html`, in the same visibility group as `saveBtn`/`deleteBtn`/`resetBtn` (shown only when an override, not "Original", is selected):

```html
<sl-button name="proposeUpstreamBtn" size="small" style="display: none;">Propose change upstream</sl-button>
```

`DocumentRulesPlugin._onProposeUpstream()`:

1. Reads the currently shown text via the existing `_currentShownText()` helper (same source Save/New override already use — the live, possibly-unsaved editor/CodeMirror content).
2. Calls `documentRulesProposeChangeUrl({ url: this._currentResource.url, text })`.
3. If `url` is `null`: warning toast, "not hosted on a recognized git forge", stop.
4. Otherwise: shows the shared `dialog.confirm(message, 'Propose change upstream')` dialog, wording depending on `content_prefilled` (prefilled: "this opens a new tab with the upstream editor, prefilled with your override text"; not: "this copies your override text to the clipboard and opens the upstream editor in a new tab — paste the copied text into the file once it opens"). If the user cancels, stop (no clipboard write, no tab).
5. On confirm: best-effort `navigator.clipboard.writeText(response.text)` — the backend's derelativized text, not the frontend's own original `text` (failure ignored — non-fatal whether or not GitHub prefilled the content) — then `window.open(url, '_blank', 'noopener')`.

**Revised from the original "no dialog, open directly" decision** (originally chosen so the forge's own page would be the confirmation step): in practice `window.open()` shifts focus to the new tab immediately, so a toast fired around it — before or after — has no reliable window to be seen, especially the clipboard-paste instruction the user still needs to act on *after* switching back. A blocking confirm dialog shown *before* anything happens fixes this: the instruction is guaranteed to be read before the tab opens, at the cost of one extra click. The dialog explains the outcome rather than asking a yes/no question about intent — the user already expressed intent by clicking the button — so its role is closer to "acknowledge what's about to happen" than "are you sure".

## Error handling

| Condition | Behavior |
| --- | --- |
| Resource host not recognized by any adapter | Warning toast, no tab opens |
| Override content too large for a GitHub URL | Falls back to an unprefilled editor tab + clipboard copy, same as GitLab |
| `navigator.clipboard.writeText()` throws (denied permission, insecure context) | Ignored; harmless when the URL was prefilled, otherwise the user can still copy the text manually from the dialog |
| Backend call itself fails (network/5xx) | Danger toast with the error message, no tab opens |
| Ref segment names a tag rather than a branch/SHA | Not specially handled; the forge's own UI may reject it — accepted as a rare edge case |

## Testing

- **Python unit tests** for `GitHubAdapter.build_propose_change_url()` / `GitLabAdapter.build_propose_change_url()`: blob-shaped input, raw-shaped input, a SHA-pinned ref requiring the default-branch lookup, the length-guard fallback, and a host neither adapter recognizes (returns `None`). Likewise for `parse_repo_path()` and `derelativize_markdown_urls()`: a same-repo sibling link, a same-repo link at a different ref, a parent-directory link, a different-repo link (left unchanged), a non-git-forge absolute link (left unchanged), and a non-markdown resource (left unchanged).
- **Frontend unit tests** for `_onProposeUpstream()`, mocking `apiClient.documentRulesProposeChangeUrl`, `navigator.clipboard.writeText`, and `window.open`, mirroring the existing `_onSave`/`_onDelete` test style already established for this plugin.
- **No new E2E coverage.** Asserting a `window.open` popup and clipboard contents in Playwright is brittle for the value it adds; a manual smoke check (click the button on a resource with a selected override, confirm the new tab lands on the expected GitHub/GitLab page) is sufficient, consistent with how the existing plan's "Refresh document rules" confirm-dialog flow is smoke-checked rather than E2E-tested.

## Deferred

- The "upstream changed" notice/diff (comparing an override's stored `base_hash` against the resource's current upstream content) — `base_url`/`base_hash` remain reserved for this, untouched by the current feature.
- Any actual server-side PR/MR creation via a stored token — deliberately not built; if a future need for a fully automated, no-browser-interaction flow arises, it would be a separate design built alongside real credential storage.
