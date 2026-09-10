# semantic-release: one-time setup

These are repository-admin actions, done once. Day-to-day releasing needs none of
them (see [contributing.md](contributing.md#release-process)).

## 1. `main` ruleset and the release-bot GitHub App

`main` is now governed by a repository **ruleset** named `main` (the old *classic*
branch protection was removed). The ruleset:

- requires a pull request before merging (0 approvals required),
- requires the `test` status check to pass,
- blocks force-pushes and branch deletion,
- allows only **merge** and **rebase** merges (**no squash**) for `devel -> main`,
- does **not** require linear history.

`semantic-release` pushes the `chore(release): X.Y.Z` commit and the `vX.Y.Z` tag
straight to `main`, which the ruleset blocks for any actor not on its **Bypass
list**. The built-in **GitHub Actions** actor (the default `GITHUB_TOKEN`) cannot
be added to a repo-level ruleset bypass in this org, so releasing goes through a
dedicated org-owned **GitHub App** ("release bot") that *is* a bypass actor.
`release.yml` mints a short-lived installation token per run with
`actions/create-github-app-token` and uses it for the checkout, for
`semantic-release` itself, and for opening the back-merge PR.

One-time setup:

1. **Create the App.** Org Settings -> Developer settings -> GitHub Apps -> New
   GitHub App. Owner: the org. Repository permissions: **Contents: Read and
   write** and **Pull requests: Read and write**. No webhook (uncheck "Active").
   No account permissions needed.
2. **Generate a private key** for the App (App settings -> Private keys ->
   Generate a private key) and download the `.pem`.
3. **Install the App** on this repository only (App settings -> Install App ->
   the org -> Only select repositories -> `pdf-tei-editor`).
4. **Add repo secrets** (Settings -> Secrets and variables -> Actions):
   - `RELEASE_APP_ID` - the App's numeric App ID.
   - `RELEASE_APP_PRIVATE_KEY` - the full contents of the downloaded `.pem`.
5. **Add the App to the ruleset bypass list.** Settings -> Rules -> Rulesets ->
   `main` -> Bypass list -> Add -> Apps -> the release App -> mode **Always**.

`devel` protection is unchanged - the back-merge reaches `devel` through a normal
PR. Without the App on the bypass list, `@semantic-release/git` fails to push to
`main` and the Release workflow run errors out with no tag and no GitHub Release.

## 2. Merge-button settings

- Settings -> General -> "Pull Requests":
  - **Allow merge commits** - ON (required; `devel -> main` must be a merge commit).
  - **Allow auto-merge** - ON (lets the back-merge PR merge itself once checks pass).
  - "Allow squash merging" may stay on for feature -> `devel` PRs, but
    **`devel -> main` PRs must never be squashed**.

## 3. Secrets

- `RELEASE_APP_ID`, `RELEASE_APP_PRIVATE_KEY` - the release-bot GitHub App (see
  section 1). Required by the `release` and `back-merge` jobs.
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
