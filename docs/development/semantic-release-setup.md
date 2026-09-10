# semantic-release: one-time setup

These are repository-admin actions, done once. Day-to-day releasing needs none of
them (see [contributing.md](contributing.md#release-process)).

## 1. Branch protection / ruleset bypass on `main`

`semantic-release` pushes the `chore(release): X.Y.Z` commit and the `vX.Y.Z` tag
straight to `main`. Add `github-actions[bot]` (GitHub Actions) to the bypass list
of the `main` branch protection rule / ruleset:

- Settings -> Rules -> Rulesets (or Branches -> branch protection for `main`).
- Add the **GitHub Actions** actor to the bypass list, or enable "Allow specified
  actors to bypass required pull requests".

`devel` protection is unchanged - the back-merge goes through a normal PR.

**This repo currently uses *classic* branch protection on `main`** (no rulesets),
which has `enforce_admins` on, `required_linear_history` on, and a required `test`
status check — none of which a classic rule lets an actor bypass. Before the first
automated release, `main` must be converted to a **repository ruleset** that:

- lists **GitHub Actions** (`github-actions[bot]`) in **Bypass list**,
- does **not** require linear history (or bypasses it for that actor), so
  `devel -> main` PRs can be merged as merge commits,
- keeps "Require a pull request before merging" for humans but allows the bypass
  actor to push the `chore(release)` commit and `vX.Y.Z` tag directly.

Without this, `@semantic-release/git` fails to push to `main` and the first
Release workflow run errors out with no tag and no GitHub Release.

## 2. Merge-button settings

- Settings -> General -> "Pull Requests":
  - **Allow merge commits** - ON (required; `devel -> main` must be a merge commit).
  - **Allow auto-merge** - ON (lets the back-merge PR merge itself once checks pass).
  - "Allow squash merging" may stay on for feature -> `devel` PRs, but
    **`devel -> main` PRs must never be squashed**.

## 3. Secrets (already present, listed for completeness)

- `DOCKERHUB_USERNAME`, `DOCKERHUB_TOKEN` - Docker Hub push.
- `GITHUB_TOKEN` - provided automatically; the `permissions:` block in
  `release.yml` grants it `contents` / `issues` / `pull-requests` write.
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
