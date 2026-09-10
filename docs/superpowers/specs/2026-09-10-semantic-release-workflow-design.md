# Semantic Release Workflow — Design

Date: 2026-09-10
Status: Approved for planning

## Problem

Releases are cut manually. A maintainer runs `node bin/release.js patch|minor|major`
on `devel`, which bumps `package.json`, commits `chore(release): v%s` + a tag, and
pushes. The maintainer then opens a `devel→main` PR and merges it. Push to `main`
triggers `.github/workflows/release.yml`, which re-derives the tag from
`package.json`, hand-rolls a changelog from conventional commits with a large shell
script, creates the GitHub Release, and chains `.github/workflows/docker-image.yml`
to build and push the Docker image.

This requires the maintainer to choose the bump manually, keeps changelog logic as
brittle shell, and produces no committed `CHANGELOG.md`.

## Goal

Replace the manual script and hand-rolled changelog with
[`semantic-release`](https://github.com/semantic-release/semantic-release), driven
entirely by conventional-commit history:

- `devel→main` PR runs the full test suite (unchanged) and posts a dry-run preview
  of the pending release.
- Merging the PR to `main` runs `semantic-release`: it computes the next version
  from commits, writes `CHANGELOG.md`, commits the bump to `main`, tags it, and
  creates the GitHub Release.
- The Docker image is built from the `production` target and pushed with the new
  version tag + `latest`.
- `devel` is brought back in sync with `main` via an automated back-merge PR.

`bin/release.js` and the `release:*` npm scripts are removed.

## Decisions

| # | Decision | Choice |
| --- | --- | --- |
| 1 | Trigger model | Tests on the `devel→main` PR; `semantic-release` publishes on merge to `main`. |
| 2 | Version source of truth / commit-back | `semantic-release` commits bumped `package.json` + `CHANGELOG.md` back to `main` via `@semantic-release/git`. `package.json` stays the version source of truth. |
| 3 | Keeping `devel` in sync | Automated back-merge PR `main→devel` opened by the release workflow, auto-merge enabled. |
| 4 | `devel→main` PR merge strategy | Merge commit (never squash), so `semantic-release`'s commit-analyzer sees every `feat:`/`fix:` individually. |
| 5 | Auth | Default `GITHUB_TOKEN` + a branch-protection / ruleset bypass for `github-actions[bot]` on `main`. |
| 6 | Semver rules while pre-1.0 | Standard semver — `semantic-release` defaults. `feat!:` / `BREAKING CHANGE:` graduates to `1.0.0` automatically. |
| 7a | Dry-run preview on the PR | Yes — a `release-preview` job comments the pending version + notes. |
| 7b | Re-run tests on merge to `main` | No. The required PR checks already validated the identical tree (`main` changes only via PR). |

## Architecture

### Workflows

| Workflow | Trigger | Responsibility |
| --- | --- | --- |
| `.github/workflows/pr-tests.yml` (extended) | PR to `main` / `devel` | Smart test suite (unchanged). New `release-preview` job that runs **only when the PR's base branch is `main`** (`github.base_ref == 'main'` — typically `devel→main`, also any hotfix→`main`); it never runs on PRs targeting `devel`. It runs `npx semantic-release --dry-run` and posts/updates a sticky PR comment with the computed next version and release notes (or "no release will be triggered"). |
| `.github/workflows/release.yml` (rewritten) | `push` to `main` | Job `release`: `npx semantic-release`. Job `docker-build` (`needs: release`, gated on a new release having been published): reusable call to `docker-image.yml`, then append the `docker pull` footer to the GitHub Release notes. Job `back-merge` (`needs: [release, docker-build]`, same gate): open an auto-merge PR `main→devel`. |
| `.github/workflows/docker-image.yml` (simplified) | `workflow_call` | Build the `production` target, push `<version>` + `latest` to Docker Hub. Version comes from a new `version` workflow input instead of the tag-detection shell (falls back to `package.json`). |

No test re-run on merge to `main`.

### `semantic-release` configuration

New dev dependencies: `semantic-release`, `@semantic-release/changelog`,
`@semantic-release/git`. The other four plugins ship with `semantic-release`.

`.releaserc.json` at the repo root:

```jsonc
{
  "branches": ["main"],
  "plugins": [
    "@semantic-release/commit-analyzer",
    "@semantic-release/release-notes-generator",
    ["@semantic-release/changelog", { "changelogFile": "CHANGELOG.md" }],
    ["@semantic-release/npm", { "npmPublish": false }],
    ["@semantic-release/git", {
      "assets": ["package.json", "package-lock.json", "CHANGELOG.md"],
      "message": "chore(release): ${nextRelease.version} [skip ci]\n\n${nextRelease.notes}"
    }],
    ["@semantic-release/github", { "successComment": false, "failComment": false }]
  ]
}
```

- Standard semver — no custom `releaseRules`.
- `[skip ci]` in the release commit prevents `release.yml` re-triggering itself on
  the bot's push to `main`. (Belt and braces: pushes made with `GITHUB_TOKEN` do
  not start new workflow runs either.)
- `@semantic-release/npm` with `npmPublish: false` bumps `package.json` only, so
  `bin/generate-version.js` and the Docker `version` build step need no changes.
- `CHANGELOG.md` is a new committed file at the repo root, seeded with the current
  `0.57.2` entry.
- The GitHub-Release `docker pull` footer (previously produced by the shell in
  `release.yml`) is re-added by a `gh release edit` step in `release.yml` after the
  image is pushed, appending to the notes `semantic-release` generated.

### `release.yml` shape

```yaml
name: Release
on:
  push:
    branches: [main]
permissions:
  contents: write
  issues: write
  pull-requests: write
concurrency:
  group: release-${{ github.ref }}
  cancel-in-progress: false
```

`release` job:

1. `actions/checkout` — `fetch-depth: 0`, `persist-credentials: true` (so
   `@semantic-release/git` can push).
2. `actions/setup-node` (Node 20) + `npm ci`.
3. `npx semantic-release` with `GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}`.
4. A follow-up shell step reads `package.json` version and runs
   `git describe --exact-match --match "v*"` on `HEAD` to set outputs
   `published` (`true`/`false`) and `version`.

`docker-build` job: `needs: release`, `if: needs.release.outputs.published == 'true'`.
Calls `./.github/workflows/docker-image.yml` with `version: ${{ needs.release.outputs.version }}`.
Final step: `gh release view v<version> --json body` → append the `docker pull`
block → `gh release edit v<version> --notes-file -`.

`back-merge` job: `needs: [release, docker-build]`, same gate. Create branch
`chore/back-merge-<version>` from `main`, open PR to `devel`
(`chore: back-merge <version> into devel`), enable auto-merge. Conflicts surface as
a normal PR for manual resolution.

### `pr-tests.yml` changes

- Remove the dead `if: ${{ !startsWith(github.head_ref, 'release/') }}` guard and
  the `refs/tags/*` push-event branches (no more release branches or tag pushes to
  react to).
- Add `release-preview` job, gated on the PR base branch being `main`:
  `if: github.event_name == 'pull_request' && github.base_ref == 'main'`. This
  excludes every PR targeting `devel` (feature branches, etc.); the PR's head
  branch is not considered. Checkout `fetch-depth: 0`, `npm ci`,
  `npx semantic-release --dry-run` with `GITHUB_TOKEN`, capture stdout,
  post/update a sticky PR comment.

### Branch protection (manual prerequisite, documented)

Add `github-actions[bot]` to the `main` branch-protection / ruleset bypass list so
the `chore(release)` commit + tag push succeeds. `devel` protection is unchanged —
the back-merge goes through a normal PR.

## Removals

- `bin/release.js`
- `package.json` scripts: `release:patch`, `release:minor`, `release:major`
- `release.yml`: the tag-detection shell, the changelog-generation shell, the
  "previous tag" step
- `docker-image.yml`: the "Extract version from tag" shell

## Documentation & agent-instruction updates

| File | Change |
| --- | --- |
| `docs/development/ci-cd-pipeline.md` | Rewrite Release Workflow + Docker Image Workflow + Execution Flow sections and mermaid diagrams. New troubleshooting: no release cut → check commit types since last tag; back-merge PR conflicts; bot push rejected → branch-protection bypass. Replace "create a pre-release tag to test" with `npx semantic-release --dry-run`. |
| `docs/development/contributing.md` | Rewrite Release Process: merge a `devel→main` PR as a merge commit (never squash); `semantic-release` does the rest. Strengthen commit-message section: `feat:` / `fix:` / `BREAKING CHANGE:` determine the version; `chore:` / `docs:` / `test:` / etc. do not trigger a release. Remove the `bin/release.js` usage block. |
| `docs/development/index.md` | Replace "Creating a Release" steps (~lines 129–135) with the merge-PR flow. |
| `docs/user-manual/cli.md` | Remove the Release Commands table; add a one-line note that releases are automated on merge to `main`. |
| `CLAUDE.md` and `AGENTS.md` | Update the CI/CD bullet to mention `semantic-release`. Add a Critical Rule: releases are fully automated by `semantic-release` on merge to `main`; never bump `package.json` version, edit `CHANGELOG.md`, or create version tags by hand; `devel→main` PRs must be merge commits, never squashed. |
| `.husky/commit-msg.py` | No change. |
| `README.md` | No release mentions found — no change. |

## Rollout / verification

1. Land the change on `devel` via a feature branch (normal `devel` PR — tests only).
2. Set the `main` branch-protection bypass for `github-actions[bot]` (prerequisite).
3. Open the `devel→main` PR: confirm `release-preview` comments the expected next
   version (`0.58.0` given the `feat`/`fix` history since `v0.57.2`).
4. Merge as a merge commit. Watch `release.yml`: `semantic-release` publishes,
   Docker image `0.58.0` + `latest` pushed, GitHub Release has notes + `docker pull`
   footer, `CHANGELOG.md` + `package.json` bumped on `main`, back-merge PR opened.
5. Merge the back-merge PR.

If `semantic-release` misbehaves, `main` is unchanged until it succeeds (it is the
last thing that writes), so iteration is safe.

## Risks

- Branch-protection bypass must be in place before the first merge to `main` or the
  bot push fails. Documented as a prerequisite.
- `--dry-run` in `release-preview` needs `GITHUB_TOKEN` read scope; N/A for
  fork PRs since this is an internal repo.
- A `devel→main` PR merged as a squash would collapse commit history and break
  version inference. Mitigated by documentation + keeping "Allow squash merging"
  off for the repo (or at least understood by maintainers).
