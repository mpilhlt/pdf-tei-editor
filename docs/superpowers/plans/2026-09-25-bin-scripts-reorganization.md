# bin/ Scripts Reorganization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split the 41-file `bin/` directory by audience so that only runtime/operations scripts ship in the Docker image, one-off data migrations are grouped, and build/dev/deploy tooling lives outside `bin/`.

**Architecture:** `bin/` = scripts that ship in the production image (runtime, admin CLIs, `bin/migrations/` for scripts run against live instances). `scripts/` = never shipped (`scripts/build/`, `scripts/dev/`, `scripts/deploy/`). Files move with `git mv` (history preserved). Scripts that derive the repo root from their own location (`parent.parent`, `__dirname/..`) get one more level. A unit test guards the boundary and root-resolution.

**Tech Stack:** Node.js (ESM), Python 3 (`uv run python`), bash, Docker, `node:test`.

**Working location:** Execute in a git worktree (see memory `always-work-in-worktree`), never in the shared checkout. Ignore `.claude/worktrees/**` copies when grepping.

---

## Target layout

```text
bin/                                   # ships in Docker image
  start-dev  start-prod
  manage.py  manage-remote.js
  import_files.py  export_files.py  batch-extract.js
  cli_storage_gc.py  cleanup-orphaned-xml.py
  migrations/
    run-migration.py
    migrate-tei-fileref-to-xml-id.py  migrate-tei-flavor-rename.py
    fix-doc-ids.py  update-metadata.py  update-tei-metadata.py
    preprocess_legacy_files.py
scripts/                               # never shipped
  build/
    build.js  bundle-templates.js  copy-pdfjs.js  compile-sl-icons.py
    generate-importmap.js  generate-modules.js  generate-plugins.js
    generate-version.js  generate-ui-types.js  generate-api-client.js
    generate-sandbox-client-script.py  check-client-outdated.js
  dev/
    debug-api.js  inspect-tei.py  reset-application.py
    generate-python-api-json.py  split-branch.py  setup-branch-protection.sh
  deploy/
    container.js  deploy.js  test-container.js  benchmark-deployment.js
    setup-cron.sh  generate-nginx-config.sh
```

## Reference map (what must be rewritten)

| Moved script(s) | Referenced from |
| --- | --- |
| all `build/*` invoked by build.js | `scripts/build/build.js:66-72` (`node bin/...` strings) |
| build.js, compile-sl-icons.py, generate-sandbox-client-script.py | `Dockerfile:58-60,131`, `package.json`, `app/src/module-registry.js`, `app/src/plugin-registry.js`, `scripts/build/generate-{modules,plugins}.js` (generated-file banners) |
| generate-api-client.js, check-client-outdated.js, generate-ui-types.js | `package.json`, `bin/split-branch.py:111` |
| generate-python-api-json.py | `package.json` |
| debug-api.js | `CLAUDE.md`, `.claude/settings.local.json`, `fastapi_app/plugins/grobid/README.md`, `docs/development/access-control.md`, `benchmark-deployment.js` |
| reset-application.py | `package.json` (`dev:reset`) |
| container.js, deploy.js, test-container.js | `package.json`, `deploy.js:133`, `docs/development/deployment.md`, `.env.deploy.*`, self-references in `container.js` usage text |
| setup-cron.sh, generate-nginx-config.sh | `docs/development/docker.md`, `docs/superpowers/specs/2026-09-12-session-ip-binding-design.md` |
| run-migration.py | `docs/development/migrations.md`, `docs/user-manual/cli.md` |
| migrate-*.py, update-tei-metadata.py | docs under `docs/superpowers/**`, `dev/todo/metadata-overhaul-implementation.md` |
| bin scripts that STAY | `docker/entrypoint.sh`, `docker/import-demo-data.sh`, `tests/lib/local-server-manager.js`, `tests/lib/fixture-loader.js`, `tests/api/v1/batch_upload.test.js` — **no change needed** |

Root-resolution lines that must gain one level (`..` → `../..`, `parent.parent` → `parent.parent.parent`):

| File (new location) | Line(s) today |
| --- | --- |
| `scripts/build/check-client-outdated.js` | 25 |
| `scripts/build/copy-pdfjs.js` | 17 |
| `scripts/build/generate-api-client.js` | 28 |
| `scripts/build/generate-plugins.js` | 22 |
| `scripts/build/generate-modules.js` | 22 |
| `scripts/build/generate-ui-types.js` | 17 |
| `scripts/build/generate-version.js` | 13 |
| `scripts/build/bundle-templates.js` | 113 |
| `scripts/build/generate-importmap.js` | 3 (`new URL("./..", ...)`) |
| `scripts/build/generate-sandbox-client-script.py` | 16 |
| `scripts/dev/generate-python-api-json.py` | 18 |
| `scripts/dev/inspect-tei.py` | 14 |
| `scripts/dev/reset-application.py` | 36, 115 |
| `scripts/dev/setup-branch-protection.sh` | 10 |
| `scripts/deploy/test-container.js` | 29 |
| `bin/migrations/run-migration.py` | 15 |
| `bin/migrations/migrate-tei-fileref-to-xml-id.py` | 26 |
| `bin/migrations/migrate-tei-flavor-rename.py` | 36 |
| `bin/migrations/update-metadata.py` | 14 (line 92 reuses `project_root`) |
| `bin/migrations/update-tei-metadata.py` | 29 |

Scripts that use cwd-relative paths only (no fix needed): `compile-sl-icons.py`, `container.js`, `deploy.js`, `debug-api.js`, `split-branch.py`, `fix-doc-ids.py`, `preprocess_legacy_files.py`. `setup-cron.sh` refers to a non-existent `deploy-container.sh` (pre-existing bug, out of scope; note in the PR).

---

### Task 1: Layout guard test (write first, fails)

**Files:**
- Create: `tests/unit/js/scripts-layout.test.js`

- [ ] **Step 1: Write the failing test**

```javascript
#!/usr/bin/env node

/**
 * Guards the bin/ vs scripts/ split: bin/ ships in the Docker image and must
 * not depend on scripts/; every Python script under bin/ and scripts/ must
 * resolve the project root correctly when run from its new location.
 *
 * @testCovers bin/manage.py
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/**
 * @param {string} dir absolute directory
 * @returns {string[]} absolute paths of all files below dir (excluding __pycache__)
 */
function walk(dir) {
  return readdirSync(dir).flatMap(name => {
    if (name === '__pycache__') return [];
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

const EXPECTED_BIN = [
  'start-dev', 'start-prod', 'manage.py', 'manage-remote.js', 'import_files.py',
  'export_files.py', 'batch-extract.js', 'cli_storage_gc.py', 'cleanup-orphaned-xml.py'
];
const EXPECTED_BIN_MIGRATIONS = [
  'run-migration.py', 'migrate-tei-fileref-to-xml-id.py', 'migrate-tei-flavor-rename.py',
  'fix-doc-ids.py', 'update-metadata.py', 'update-tei-metadata.py', 'preprocess_legacy_files.py'
];

describe('bin/ and scripts/ layout', () => {
  test('bin/ contains exactly the runtime scripts', () => {
    const entries = readdirSync(join(ROOT, 'bin')).filter(n => n !== '__pycache__' && n !== 'migrations' && n !== 'README.md');
    assert.deepStrictEqual(entries.sort(), [...EXPECTED_BIN].sort());
  });

  test('bin/migrations/ contains exactly the migration scripts', () => {
    const entries = readdirSync(join(ROOT, 'bin', 'migrations')).filter(n => n !== '__pycache__' && n !== 'README.md');
    assert.deepStrictEqual(entries.sort(), [...EXPECTED_BIN_MIGRATIONS].sort());
  });

  test('scripts/ has build, dev and deploy subdirectories', () => {
    for (const d of ['build', 'dev', 'deploy']) {
      assert.ok(existsSync(join(ROOT, 'scripts', d)), `scripts/${d} missing`);
    }
  });

  test('files shipped in bin/ never reference scripts/', () => {
    const offenders = walk(join(ROOT, 'bin'))
      .filter(f => !f.endsWith('.pyc') && !f.endsWith('README.md'))
      .filter(f => /\bscripts\/(build|dev|deploy)\//.test(readFileSync(f, 'utf8')));
    assert.deepStrictEqual(offenders.map(f => f.replace(ROOT + '/', '')), []);
  });

  test('no script under bin/ or scripts/ has a stale bin/<moved-script> reference', () => {
    const moved = /\bbin\/(build|bundle-templates|copy-pdfjs|compile-sl-icons|generate-[a-z-]+|check-client-outdated|debug-api|inspect-tei|reset-application|split-branch|setup-branch-protection|container|deploy|test-container|benchmark-deployment|setup-cron|run-migration|migrate-[a-z-]+|fix-doc-ids|update-(tei-)?metadata|preprocess_legacy_files)\b/;
    const offenders = [...walk(join(ROOT, 'bin')), ...walk(join(ROOT, 'scripts'))]
      .filter(f => !f.endsWith('.pyc'))
      .filter(f => moved.test(readFileSync(f, 'utf8')));
    assert.deepStrictEqual(offenders.map(f => f.replace(ROOT + '/', '')), []);
  });

  test('every script resolving its own root lands on the project root', () => {
    // depth = directories between ROOT and the script. Python `Path(__file__).parent`
    // chain needs depth + 1 hops (the first hop leaves the file); JS `join(__dirname, '..')` needs depth.
    const scripts = [...walk(join(ROOT, 'bin')), ...walk(join(ROOT, 'scripts'))].filter(f => !f.endsWith('.pyc') && !f.endsWith('.md'));
    const problems = [];
    for (const f of scripts) {
      const depth = f.replace(ROOT + '/', '').split('/').length - 1;
      const src = readFileSync(f, 'utf8');
      for (const m of src.matchAll(/(?:Path\(__file__\)(?:\.resolve\(\))?)((?:\.parent)+)/g)) {
        const climbs = m[1].split('.parent').length - 1;
        if (climbs !== depth + 1) problems.push(`${f}: ${m[0]} climbs ${climbs}, needs ${depth}`);
      }
      for (const m of src.matchAll(/join\(__dirname,\s*'((?:\.\.\/?)+)'/g)) {
        const climbs = m[1].split('..').length - 1;
        if (climbs !== depth) problems.push(`${f}: ${m[0]} climbs ${climbs}, needs ${depth}`);
      }
    }
    assert.deepStrictEqual(problems, []);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test tests/unit/js/scripts-layout.test.js`
Expected: FAIL (`scripts/` missing, bin contains extra files).

- [ ] **Step 3: Commit the test alone**

```bash
git add tests/unit/js/scripts-layout.test.js
git commit -m "test: add bin/scripts layout guard (failing until reorganization)"
```

---

### Task 2: Move files with git mv

**Files:** all moves in the table below.

- [ ] **Step 1: Create directories and move**

```bash
mkdir -p bin/migrations scripts/build scripts/dev scripts/deploy

# migrations
for f in run-migration.py migrate-tei-fileref-to-xml-id.py migrate-tei-flavor-rename.py \
         fix-doc-ids.py update-metadata.py update-tei-metadata.py preprocess_legacy_files.py; do
  git mv bin/$f bin/migrations/$f
done

# build
for f in build.js bundle-templates.js copy-pdfjs.js compile-sl-icons.py generate-importmap.js \
         generate-modules.js generate-plugins.js generate-version.js generate-ui-types.js \
         generate-api-client.js generate-sandbox-client-script.py check-client-outdated.js; do
  git mv bin/$f scripts/build/$f
done

# dev
for f in debug-api.js inspect-tei.py reset-application.py generate-python-api-json.py \
         split-branch.py setup-branch-protection.sh; do
  git mv bin/$f scripts/dev/$f
done

# deploy
for f in container.js deploy.js test-container.js benchmark-deployment.js setup-cron.sh generate-nginx-config.sh; do
  git mv bin/$f scripts/deploy/$f
done

rm -rf bin/__pycache__
ls bin bin/migrations
```

Expected: `bin` lists exactly the 9 runtime files plus `migrations`; `bin/migrations` lists the 7 migration files.

- [ ] **Step 2: Ensure `__pycache__` is ignored**

Run: `git check-ignore -v bin/__pycache__/x.pyc || printf '\n__pycache__/\n' >> .gitignore`

- [ ] **Step 3: Commit (intentionally broken intermediate state is acceptable on the branch; squash later is NOT allowed to hide the rename — keep this commit rename-only so git detects renames)**

```bash
git add -A bin scripts .gitignore
git commit -m "refactor: move bin/ scripts into bin/migrations and scripts/{build,dev,deploy}"
```

---

### Task 3: Fix root resolution in moved scripts

**Files:** the 20 lines in the "Root-resolution lines" table above.

- [ ] **Step 1: Python scripts — add one `.parent`**

Apply per file with the exact substitutions (verify each line with `grep -n` first):

```bash
# depth-2 Python scripts: Path(__file__).parent.parent -> .parent.parent.parent
sed -i '' -E 's/Path\(__file__\)\.parent\.parent\b/Path(__file__).parent.parent.parent/' \
  scripts/dev/generate-python-api-json.py scripts/dev/inspect-tei.py \
  bin/migrations/run-migration.py bin/migrations/migrate-tei-fileref-to-xml-id.py \
  bin/migrations/migrate-tei-flavor-rename.py bin/migrations/update-tei-metadata.py

# .resolve() variants
sed -i '' -E 's/Path\(__file__\)\.resolve\(\)\.parent\.parent\b/Path(__file__).resolve().parent.parent.parent/' \
  scripts/build/generate-sandbox-client-script.py scripts/dev/reset-application.py \
  bin/migrations/update-metadata.py
```

Careful: the regexes must not re-match already-fixed lines; run each command once. In `reset-application.py` also update the comment at line 35 ("parent of bin/" → "repository root").

- [ ] **Step 2: JS scripts — add one `..`**

```bash
cd scripts/build
sed -i '' "s|join(__dirname, '..')|join(__dirname, '..', '..')|" \
  check-client-outdated.js copy-pdfjs.js generate-api-client.js generate-plugins.js generate-modules.js generate-version.js
sed -i '' "s|join(__dirname, '..', 'app', 'src', 'templates')|join(__dirname, '..', '..', 'app', 'src', 'templates')|" generate-ui-types.js
sed -i '' "s|resolve(__dirname, '..')|resolve(__dirname, '..', '..')|" bundle-templates.js
sed -i '' 's|new URL("./..", import.meta.url)|new URL("./../..", import.meta.url)|' generate-importmap.js
cd ../deploy
sed -i '' 's|const projectRoot = dirname(__dirname);|const projectRoot = dirname(dirname(__dirname));|' test-container.js
cd ../..
```

Note: the test's regex for JS only matches `join(__dirname, '..'...)` forms; `generate-ui-types.js`, `bundle-templates.js` (`resolve`), `generate-importmap.js` and `test-container.js` are verified by the smoke runs in Task 6 instead.

- [ ] **Step 3: Shell script**

In `scripts/dev/setup-branch-protection.sh` line 10 change `REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"` to `REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"`.

- [ ] **Step 4: Verify each edit landed**

Run: `git diff -U0 | grep -E '^[+-].*(parent|__dirname|SCRIPT_DIR|import.meta)' `
Expected: 20 paired -/+ lines, each `+` one level deeper.

- [ ] **Step 5: Commit**

```bash
git commit -am "fix: adjust project-root resolution for relocated scripts"
```

---

### Task 4: Rewrite path references

**Files:** see the Reference map. Use a scripted rewrite plus manual review.

- [ ] **Step 1: Write the mapping script** at `<scratchpad>/rewrite-refs.sh`

```bash
#!/bin/bash
# Rewrites `bin/<name>` -> new path for every moved script, in tracked, non-history files.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
declare -A M
for f in run-migration.py migrate-tei-fileref-to-xml-id.py migrate-tei-flavor-rename.py fix-doc-ids.py update-metadata.py update-tei-metadata.py preprocess_legacy_files.py; do M[$f]=bin/migrations; done
for f in build.js bundle-templates.js copy-pdfjs.js compile-sl-icons.py generate-importmap.js generate-modules.js generate-plugins.js generate-version.js generate-ui-types.js generate-api-client.js generate-sandbox-client-script.py check-client-outdated.js; do M[$f]=scripts/build; done
for f in debug-api.js inspect-tei.py reset-application.py generate-python-api-json.py split-branch.py setup-branch-protection.sh; do M[$f]=scripts/dev; done
for f in container.js deploy.js test-container.js benchmark-deployment.js setup-cron.sh generate-nginx-config.sh; do M[$f]=scripts/deploy; done

FILES=$(git ls-files | grep -vE '^(docs/history/|docs/api/|\.claude/worktrees/|package-lock\.json|CHANGELOG\.md)' )
for f in "${!M[@]}"; do
  esc=$(printf '%s' "$f" | sed 's/[.]/\\./g')
  # match "bin/<name>" only when not already preceded by a path segment (avoid scripts/x/bin/...)
  echo "$FILES" | xargs -I{} sh -c '[ -f "{}" ] && grep -Iq "bin/'"$esc"'" "{}" && sed -i "" -E "s#(^|[^A-Za-z0-9_./-])bin/'"$esc"'#\1'"${M[$f]//\//\\/}"'/'"$f"'#g" "{}"' || true
done
git diff --stat | tail -1
```

- [ ] **Step 2: Run it and review the diff**

Run: `bash <scratchpad>/rewrite-refs.sh && git diff --stat`
Expected: changes in `package.json`, `Dockerfile`, `CLAUDE.md`, `.claude/settings.local.json` (if tracked), `.env.deploy.*`, `docs/**`, `app/src/{module,plugin}-registry.js`, `scripts/**`, `bin/**` (e.g. `manage.py` text), `fastapi_app/plugins/grobid/README.md`, `fastapi_app/lib/plugins/plugin_tools.py`, `dev/todo/*`.
Then confirm nothing over-matched: `git diff | grep '^+' | grep -E 'scripts/(build|dev|deploy)/[^ ]*/'` should be empty.

- [ ] **Step 3: Fix the leftovers the script cannot handle**

1. `scripts/build/build.js:66-72` — the strings become `node scripts/build/generate-plugins.js` etc. (should already be rewritten; verify).
2. `scripts/build/generate-{plugins,modules}.js` banners and the regenerated `app/src/{plugin,module}-registry.js` banners must match exactly (the guard `generate:check` style diffs otherwise): run `node scripts/build/build.js --steps=plugins,modules` and `git diff app/src` shows only the banner text.
3. `scripts/deploy/deploy.js:133` `'bin/container.js'` → `'scripts/deploy/container.js'`.
4. `scripts/deploy/benchmark-deployment.js` references to `debug-api.js` → `scripts/dev/debug-api.js`.
5. `bin/manage.py:4-7,505` text pointing to `bin/manage-remote.js` stays (still in `bin/`).
6. `Dockerfile:94` `COPY --from=builder /app/bin /app/bin` stays (now excludes build/dev/deploy tooling). Add above it: `# scripts/ (build, dev, deploy tooling) is intentionally not shipped`.
7. `.dockerignore`: no change (the builder stage needs `scripts/`).

- [ ] **Step 4: Confirm no stale references remain**

Run: `git grep -nE 'bin/(build|bundle-templates|copy-pdfjs|compile-sl-icons|generate-|check-client-outdated|debug-api|inspect-tei|reset-application|split-branch|setup-branch-protection|container|deploy|test-container|benchmark-deployment|setup-cron|run-migration|migrate-|fix-doc-ids|update-(tei-)?metadata|preprocess_legacy)' -- . ':!docs/history' ':!docs/api' ':!CHANGELOG.md' ':!package-lock.json'`
Expected: no output.

- [ ] **Step 5: Commit**

```bash
git commit -am "refactor: update references to relocated scripts"
```

---

### Task 5: READMEs and documentation

**Files:**
- Create: `bin/README.md`, `bin/migrations/README.md`, `scripts/README.md`
- Modify: `CLAUDE.md` (Key Directories), `docs/code-assistant/development-commands.md`, `docs/user-manual/cli.md`, `docs/development/migrations.md`, stale docstring in `bin/cli_storage_gc.py`

- [ ] **Step 1: `bin/README.md`**

```markdown
# bin/

Scripts that ship in the production Docker image. Nothing here may depend on `scripts/`.

| Script | Purpose |
| --- | --- |
| `start-prod` / `start-dev` | Start the server (production / development with auto-reload) |
| `manage.py` | Deprecated user/group/collection/config CLI (used by `docker/entrypoint.sh`) |
| `manage-remote.js` | Admin CLI for local and remote instances |
| `import_files.py` / `export_files.py` | Import and export files |
| `batch-extract.js` | Batch extraction via the API |
| `cli_storage_gc.py` | Storage garbage collection |
| `cleanup-orphaned-xml.py` | Remove XML files without a PDF |
| `migrations/` | One-off migrations to run on live instances, see its README |

Build, development and deployment tooling lives in `scripts/`.
```

- [ ] **Step 2: `bin/migrations/README.md`**

```markdown
# bin/migrations/

One-off scripts that must be run against existing (live) instances after upgrading. They ship in the Docker image.
`run-migration.py` runs the automatic database schema migrations (see docs/development/migrations.md); the other scripts are data migrations.

Convention: state in each script's docstring the release that introduced it. Remove a script once no supported deployment predates that release.

| Script | Purpose |
| --- | --- |
| `run-migration.py` | Run database schema migrations manually |
| `migrate-tei-fileref-to-xml-id.py` | Convert TEI file references to xml:id |
| `migrate-tei-flavor-rename.py` | Rename TEI flavors |
| `fix-doc-ids.py` | Rename files/contents containing outdated doc ids |
| `update-metadata.py` | Run/revert named maintenance functions on metadata.db |
| `update-tei-metadata.py` | Enrich TEI metadata (CrossRef/DataCite/LLM) |
| `preprocess_legacy_files.py` | Convert the legacy webdav-data layout for import |
```

- [ ] **Step 3: `scripts/README.md`**

```markdown
# scripts/

Tooling that is never shipped in the production image.

- `build/` — build pipeline (`npm run build`), code generators, icon/template/PDF.js bundling
- `dev/` — developer helpers: `debug-api.js`, `inspect-tei.py`, `reset-application.py`, API doc generation, branch utilities
- `deploy/` — container build/run/deploy (`container.js`, `deploy.js`), nginx and cron setup, deployment benchmarks

Runtime and admin scripts live in `bin/`.
```

- [ ] **Step 4: Update `CLAUDE.md` Key Directories** — replace the `- \`bin\` - executable files used on the command line` line with:

```markdown
- `bin` - scripts shipped in the production image (server start, admin CLIs, import/export); `bin/migrations` - one-off migrations for live instances
- `scripts` - never shipped: `scripts/build` (build pipeline, generators), `scripts/dev` (developer helpers such as `debug-api.js`), `scripts/deploy` (container/deployment tooling)
```

- [ ] **Step 5: Fix `bin/cli_storage_gc.py` docstring** — change `python fastapi_app/cli_storage_gc.py` to `python bin/cli_storage_gc.py`.

- [ ] **Step 6: Update the remaining docs** — in `docs/development/migrations.md`, `docs/user-manual/cli.md`, `docs/code-assistant/development-commands.md` confirm the rewritten paths read correctly (`bin/migrations/run-migration.py`); add a one-line pointer to the new READMEs in `docs/code-assistant/development-commands.md`.

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "docs: document bin/ and scripts/ layout"
```

---

### Task 6: Verification

- [ ] **Step 1: Layout guard passes**

Run: `node --test tests/unit/js/scripts-layout.test.js`
Expected: all tests PASS.

- [ ] **Step 2: Build pipeline is idempotent and produces no diff**

```bash
npm run build
git status --short
```

Expected: build succeeds; `git status` shows no modifications beyond generated files that are gitignored (`app/web/*`). Any diff in `app/src/*-registry.js` means a banner was not aligned (Task 4 step 3.2).

- [ ] **Step 2b: Root-resolution smoke test for scripts the guard cannot see**

```bash
node scripts/build/generate-ui-types.js && node scripts/build/bundle-templates.js && node scripts/build/generate-importmap.js && node scripts/build/generate-version.js
uv run python scripts/build/generate-sandbox-client-script.py
uv run python scripts/dev/generate-python-api-json.py
uv run python bin/migrations/run-migration.py --help
uv run python bin/migrations/update-metadata.py 2>&1 | head -3
uv run python scripts/dev/inspect-tei.py 2>&1 | head -3
node scripts/build/check-client-outdated.js || true
node scripts/deploy/container.js --help | head -5
node scripts/dev/debug-api.js 2>&1 | head -3
git status --short
```

Expected: each command starts without `ModuleNotFoundError: fastapi_app` / `ENOENT` path errors (usage messages are fine); `git status` shows no unexpected changes.

- [ ] **Step 3: Existing test suites**

Run: `npm run test:unit` and `npm run test:changed`
Expected: PASS (`tests/lib/*` and `tests/api/v1/batch_upload.test.js` still reference `bin/start-dev` and `bin/batch-extract.js`, which did not move).

- [ ] **Step 4: Docker image contents**

```bash
npm run container:build
podman run --rm --entrypoint ls <image> /app/bin /app/bin/migrations   # or docker
podman run --rm --entrypoint ls <image> /app/scripts 2>&1              # expect: No such file
```

Expected: `/app/bin` holds the 9 runtime scripts plus `migrations/`; `/app/scripts` does not exist. Then run `bash docker/entrypoint.sh`'s first `manage.py` call path via the existing `npm run test:container` and confirm it passes.

- [ ] **Step 5: CI workflow review**

Run: `git grep -n 'scripts/\|bin/' .github/workflows` — expected: only `$HOME/.cargo/bin` hits (no workflow references moved scripts; per `docs/development/ci-cd-pipeline.md` nothing to change).

- [ ] **Step 6: Push branch and open PR**

Commit type `refactor:`; per repo rules do not touch `package.json` version or `CHANGELOG.md`. Mention in the PR description: external cron jobs/operator docs that call moved deploy scripts (`setup-cron.sh`, `deploy.js`, `container.js`) must use the new `scripts/deploy/` paths; runtime entry points (`bin/manage.py`, `bin/start-prod`, `bin/import_files.py`, `bin/export_files.py`) are unchanged; `setup-cron.sh` pre-existing reference to a missing `deploy-container.sh` is out of scope.

---

## Self-review

- Spec coverage: three categories (deployment / dev-only / one-off migrations needed in deployment) → `bin/`, `scripts/`, `bin/migrations/`; `start-dev` kept with `start-prod`; `update-*metadata.py` treated as migrations; Docker image excludes `scripts/` (Task 4.3.6, Task 6.4); boundary guard (Task 1); docs (Task 5).
- Risk: root-resolution regressions are covered by the guard (Python and `join(__dirname, ...)` idioms) plus the smoke commands in Task 6.2b for idioms the guard does not parse (`resolve(__dirname, ...)`, `new URL("./../..")`, `dirname(__dirname)`, bash `REPO_ROOT`).
- Known open item: `manage.py` is marked deprecated in favour of `manage-remote.js` but is still used by `docker/entrypoint.sh`; it remains in `bin/` until the entrypoint is migrated.
