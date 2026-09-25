#!/usr/bin/env node

/**
 * Guards the bin/ vs scripts/ split: bin/ ships in the Docker image and must
 * not depend on scripts/; every Python script under bin/ and scripts/ must
 * resolve the project root correctly when run from its new location.
 *
 * @testCovers bin/
 * @testCovers scripts/
 * @testCovers Dockerfile
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/**
 * @param {string} dir absolute directory
 * @returns {string[]} absolute paths of all files below dir (excluding __pycache__)
 */
function walk(dir) {
  return readdirSync(dir).flatMap(name => {
    if (name === '__pycache__' || name.startsWith('.')) return [];
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
    const entries = readdirSync(join(ROOT, 'bin')).filter(n => n !== '__pycache__' && !n.startsWith('.') && n !== 'migrations' && n !== 'README.md');
    assert.deepStrictEqual(entries.sort(), [...EXPECTED_BIN].sort());
  });

  test('bin/migrations/ contains exactly the migration scripts', () => {
    const entries = readdirSync(join(ROOT, 'bin', 'migrations')).filter(n => n !== '__pycache__' && !n.startsWith('.') && n !== 'README.md');
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
      .filter(f => /(^|[^\w.-])scripts\//.test(readFileSync(f, 'utf8')));
    assert.deepStrictEqual(offenders.map(f => relative(ROOT, f)), []);
  });

  test('no script under bin/ or scripts/ has a stale bin/<moved-script> reference', () => {
    // names of scripts as of the bin/ split; extend when moving more
    const moved = /\bbin\/(build|bundle-templates|copy-pdfjs|compile-sl-icons|generate-[a-z-]+|check-client-outdated|debug-api|inspect-tei|reset-application|split-branch|setup-branch-protection|container|deploy|test-container|benchmark-deployment|setup-cron|run-migration|migrate-[a-z-]+|fix-doc-ids|update-(tei-)?metadata|preprocess_legacy_files)\b/;
    const offenders = [...walk(join(ROOT, 'bin')), ...walk(join(ROOT, 'scripts'))]
      .filter(f => !f.endsWith('.pyc'))
      .filter(f => moved.test(readFileSync(f, 'utf8')));
    assert.deepStrictEqual(offenders.map(f => relative(ROOT, f)), []);
  });

  test('every script resolving its own root lands on the project root', () => {
    // depth = directories between ROOT and the script. Python `Path(__file__).parent`
    // chain needs depth + 1 hops (the first hop leaves the file); JS `join(__dirname, '..')`, `new URL('./..', import.meta.url)` and shell `$SCRIPT_DIR/..` need depth.
    const scripts = [...walk(join(ROOT, 'bin')), ...walk(join(ROOT, 'scripts'))].filter(f => !f.endsWith('.pyc') && !f.endsWith('.md'));
    const problems = [];
    for (const f of scripts) {
      const depth = relative(ROOT, f).split('/').length - 1;
      const src = readFileSync(f, 'utf8');
      /** @param {string} text @param {number} climbs @param {number} needs */
      const check = (text, climbs, needs) => {
        if (climbs !== needs) problems.push(`${relative(ROOT, f)}: ${text} climbs ${climbs}, needs ${needs}`);
      };
      for (const m of src.matchAll(/Path\(__file__\)(?:\.resolve\(\))?((?:\.parent)+)/g)) {
        check(m[0], m[1].split('.parent').length - 1, depth + 1);
      }
      for (const m of src.matchAll(/(?:join|resolve)\(__dirname((?:,\s*'\.\.')+)\)/g)) {
        check(m[0], m[1].split("'..'").length - 1, depth);
      }
      for (const m of src.matchAll(/new URL\("(\.\/\.\.(?:\/\.\.)*)", import\.meta\.url\)/g)) {
        check(m[0], m[1].split('..').length - 1, depth);
      }
      for (const m of src.matchAll(/"\$SCRIPT_DIR((?:\/\.\.)+)"/g)) {
        check(m[0], m[1].split('..').length - 1, depth);
      }
    }
    assert.deepStrictEqual(problems, []);
  });
});
