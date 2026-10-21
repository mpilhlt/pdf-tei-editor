/**
 * Plugin-provided API and E2E tests
 *
 * Plugins keep tests that need a running server next to their code:
 *
 * - `<plugin>/tests/api/*.test.js`  - API tests, run by tests/backend-test-runner.js
 * - `<plugin>/tests/e2e/*.spec.js`  - Playwright tests, run by tests/e2e-runner.js
 *
 * They are written as if they were located in `tests/api/v1/` resp. `tests/e2e/tests/`,
 * so that they can use the shared helpers and fixtures with the same relative imports
 * (`../helpers/...`, `../fixtures/...`). Before a run, the runners copy ("stage") them
 * into these directories as `plugin--<plugin>--<file>` and remove the copies afterwards.
 * Staged files are git-ignored.
 *
 * Plugins are searched in `fastapi_app/plugins/` and in the directories passed with
 * `--plugin-tests <dir>` (e.g. a checkout of the plugin monorepo), at any depth.
 */

import { copyFileSync, existsSync, readdirSync, rmSync, statSync } from 'fs';
import { basename, dirname, join, relative, resolve } from 'path';
import { fileURLToPath } from 'url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Prefix of staged files */
export const STAGED_PREFIX = 'plugin--';

/**
 * @typedef {'api'|'e2e'} PluginTestKind
 */

/** @type {Record<PluginTestKind, {subdir: string, suffix: string, target: string}>} */
const KINDS = {
  api: { subdir: 'api', suffix: '.test.js', target: 'tests/api/v1' },
  e2e: { subdir: 'e2e', suffix: '.spec.js', target: 'tests/e2e/tests' },
};

const SKIPPED_DIRS = new Set(['node_modules', '__pycache__', '.git', '.venv', 'runtime', 'test-results']);

/**
 * Find plugin test files of a kind below a directory.
 * @param {string} baseDir
 * @param {PluginTestKind} kind
 * @param {number} [maxDepth=6]
 * @returns {string[]} Absolute paths
 */
function findPluginTests(baseDir, kind, maxDepth = 6) {
  const { subdir, suffix } = KINDS[kind];
  /** @type {string[]} */
  const found = [];
  /**
   * @param {string} dir
   * @param {number} depth
   */
  const visit = (dir, depth) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (basename(dir) === subdir && basename(dirname(dir)) === 'tests') {
      for (const entry of entries) {
        if (entry.isFile() && entry.name.endsWith(suffix)) found.push(join(dir, entry.name));
      }
      return;
    }
    if (depth >= maxDepth) return;
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith('.') && !SKIPPED_DIRS.has(entry.name)) {
        visit(join(dir, entry.name), depth + 1);
      }
    }
  };
  if (existsSync(baseDir) && statSync(baseDir).isDirectory()) visit(baseDir, 0);
  return found.sort();
}

/**
 * The name of the plugin a test file belongs to: the directory that contains `tests/`.
 * @param {string} file
 * @returns {string}
 */
function pluginNameOf(file) {
  return basename(dirname(dirname(dirname(file))));
}

/**
 * Path of the staged copy of a plugin test file, relative to the project root.
 * @param {string} file - Plugin test file (absolute or relative to the project root)
 * @param {PluginTestKind} kind
 * @returns {string}
 */
export function stagedPathOf(file, kind) {
  const name = `${STAGED_PREFIX}${pluginNameOf(resolve(projectRoot, file))}--${basename(file)}`;
  return join(KINDS[kind].target, name);
}

/**
 * Whether a path points to a plugin test file of the given kind.
 * @param {string} file
 * @param {PluginTestKind} kind
 * @returns {boolean}
 */
export function isPluginTestFile(file, kind) {
  const { subdir, suffix } = KINDS[kind];
  const parts = resolve(projectRoot, file).split(/[\\/]/);
  return file.endsWith(suffix) && parts.at(-2) === subdir && parts.at(-3) === 'tests';
}

/**
 * List plugin test files of a kind.
 * @param {PluginTestKind} kind
 * @param {string[]} [extraDirs=[]] - Additional directories to search
 * @returns {string[]} Paths relative to the project root
 */
export function listPluginTests(kind, extraDirs = []) {
  const dirs = [join(projectRoot, 'fastapi_app', 'plugins'), ...extraDirs.map(d => resolve(projectRoot, d))];
  return dirs.flatMap(dir => findPluginTests(dir, kind)).map(f => relative(projectRoot, f));
}

/**
 * Remove all staged copies of a kind.
 * @param {PluginTestKind} kind
 */
export function removeStagedPluginTests(kind) {
  const target = join(projectRoot, KINDS[kind].target);
  if (!existsSync(target)) return;
  for (const name of readdirSync(target)) {
    if (name.startsWith(STAGED_PREFIX)) rmSync(join(target, name), { force: true });
  }
}

/**
 * Copy plugin test files into the core test directory of their kind.
 * Earlier staged copies are removed first.
 * @param {PluginTestKind} kind
 * @param {string[]} [extraDirs=[]] - Additional directories to search
 * @returns {string[]} Staged paths relative to the project root
 */
export function stagePluginTests(kind, extraDirs = []) {
  removeStagedPluginTests(kind);
  return listPluginTests(kind, extraDirs).map(file => {
    const staged = stagedPathOf(file, kind);
    copyFileSync(join(projectRoot, file), join(projectRoot, staged));
    return staged;
  });
}
