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
        if (climbs !== depth + 1) problems.push(`${f}: ${m[0]} climbs ${climbs}, needs ${depth + 1}`);
      }
      for (const m of src.matchAll(/join\(__dirname,\s*'((?:\.\.\/?)+)'/g)) {
        const climbs = m[1].split('..').length - 1;
        if (climbs !== depth) problems.push(`${f}: ${m[0]} climbs ${climbs}, needs ${depth}`);
      }
    }
    assert.deepStrictEqual(problems, []);
  });
});
