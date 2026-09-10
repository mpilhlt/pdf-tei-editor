# semantic-release: one-time setup

These are repository-admin actions, done once. Day-to-day releasing needs none of
them (see [contributing.md](contributing.md#release-process)).

## 1. `main` ruleset and the release-bot deploy key

`main` is governed by a repository **ruleset** named `main` (the old *classic*
branch protection was removed). The ruleset:

- requires a pull request before merging (0 approvals required),
- requires the `test` status check to pass (strict),
- blocks force-pushes and branch deletion,
- allows only **merge** and **rebase** merges (**no squash**) for `devel -> main`,
- does **not** require linear history.

`semantic-release` must push the `chore(release): X.Y.Z` commit and the `vX.Y.Z`
tag straight to `main`, which the ruleset blocks for any actor not on its
**Bypass list**. Neither the built-in **GitHub Actions** actor (the default
`GITHUB_TOKEN`) nor a GitHub App is available here, so a repo **write deploy key**
(`release-bot`) is used as the bypass actor. `actions/checkout` is given
`ssh-key: ${{ secrets.RELEASE_DEPLOY_KEY }}`, which configures `origin` as an SSH
remote; `@semantic-release/git` and semantic-release's tag push then go over that
key and bypass the ruleset.

One-time setup (all doable by a repository admin - no org owner needed):

1. Generate the key pair:
   `ssh-keygen -t ed25519 -C "pdf-tei-editor release bot" -f ./release-bot-key -N ""`
   (no passphrase).
2. Add `release-bot-key.pub` as a repo **deploy key** (Settings -> Deploy keys ->
   Add deploy key), title `release-bot`, with **Allow write access** checked.
3. Add the private key `release-bot-key` as repo secret **`RELEASE_DEPLOY_KEY`**
   (Settings -> Secrets and variables -> Actions) - the full file contents,
   including the `BEGIN`/`END` lines.
4. Add the `release-bot` deploy key to the `main` ruleset **Bypass list**
   (Settings -> Rules -> Rulesets -> `main` -> Bypass list -> Add bypass ->
   Deploy keys -> `release-bot`).
5. Delete the local `release-bot-key*` files.

`release.yml` checks out with `ssh-key: ${{ secrets.RELEASE_DEPLOY_KEY }}`, so
`origin` is an SSH remote and semantic-release's commit + tag pushes go over the
key. The GitHub Release and issue comments still use the default `GITHUB_TOKEN`.

`devel` protection is unchanged - the back-merge reaches `devel` through a normal
PR. Without the deploy key on the bypass list, `@semantic-release/git` fails to
push to `main` and the Release run errors out after (or before) creating the tag;
it is safe to re-run once fixed.

## 2. Merge-button settings

- Settings -> General -> "Pull Requests":
  - **Allow merge commits** - ON (required; `devel -> main` must be a merge commit).
  - **Allow auto-merge** - ON (lets the back-merge PR merge itself once checks pass).
  - "Allow squash merging" may stay on for feature -> `devel` PRs, but
    **`devel -> main` PRs must never be squashed**.
- The `back-merge` job tries an immediate merge of its PR first, which works
  while `devel` has no required status checks. If `devel` later gains a required
  check, the job falls back to `--auto` (needs **Allow auto-merge** ON); if that
  cannot gate either, the PR is left open for a manual merge.

## 3. Secrets

- `RELEASE_DEPLOY_KEY` - the private half of the `release-bot` write deploy key
  (see section 1). Required by the `release` and `back-merge` jobs.
- `DOCKERHUB_USERNAME`, `DOCKERHUB_TOKEN` - Docker Hub push.
- `GITHUB_TOKEN` - provided automatically; the `permissions:` block in
  `release.yml` grants it `contents` / `issues` / `pull-requests` write. Still
  used by the `release-notes-footer` job for the Release API.
- No `NPM_TOKEN` - `@semantic-release/npm` runs with `npmPublish: false`.

## 4. First release after migration

The first `devel -> main` PR after this migration must contain at least one
`feat:` or `fix:` commit for a release to be produced; a PR of only `chore:` /
`docs:` commits is a valid no-op.

Also confirm tag reachability once the migration PR is merged: run
`git fetch origin && git describe --tags origin/main`. It must report `v0.57.2`
(the current latest tag). If it reports an older tag, an earlier release PR was
squash-merged and `semantic-release` will recompute the next version from that
older baseline - re-point/re-tag `v0.57.2` onto `origin/main` HEAD's release
commit before relying on the first automated release.
