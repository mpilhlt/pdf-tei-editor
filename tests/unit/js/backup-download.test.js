#!/usr/bin/env node

/**
 * @testCovers bin/backup-download.js
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BackupError, EXIT, acquireLock, backupFileName, formatTimestamp, listZipEntries,
  parseBackupFileName, runBackup, selectBackupsToDelete,
} from '../../../bin/backup-download.js';

/**
 * Build a minimal ZIP with stored (uncompressed) empty entries.
 * @param {string[]} names
 * @returns {Buffer}
 */
function buildZip(names) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const name of names) {
    const nameBuf = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(nameBuf.length, 26);
    parts.push(local, nameBuf);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt32LE(offset, 42);
    central.push(cen, nameBuf);
    offset += local.length + nameBuf.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(names.length, 8);
  eocd.writeUInt16LE(names.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, eocd]);
}

const VALID_ZIP = buildZip(['db/users.json', 'db/config.json']);

describe('backup file names', () => {
  it('formats a UTC timestamp and round-trips', () => {
    const d = new Date(Date.UTC(2026, 9, 3, 2, 0, 0));
    assert.strictEqual(formatTimestamp(d), '20261003T020000Z');
    const name = backupFileName('app', d);
    assert.strictEqual(name, 'app_20261003T020000Z.zip');
    assert.strictEqual(parseBackupFileName(name, 'app').getTime(), d.getTime());
  });

  it('rejects foreign names and other prefixes', () => {
    assert.strictEqual(parseBackupFileName('notes.zip', 'app'), null);
    assert.strictEqual(parseBackupFileName('other_20261003T020000Z.zip', 'app'), null);
    assert.strictEqual(parseBackupFileName('app_20261003T020000Z.zip.part', 'app'), null);
  });
});

describe('selectBackupsToDelete', () => {
  const now = new Date(Date.UTC(2026, 9, 31, 12));
  /** @param {number} daysAgo */
  const name = daysAgo => backupFileName('app', new Date(now.getTime() - daysAgo * 86400000));
  const base = { prefix: 'app', keepLast: 3, keepDays: 10, keepWeekly: 0, keepMonthly: 0, now };

  it('deletes backups older than keepDays but keeps the newest keepLast', () => {
    const files = [0, 1, 2, 5, 12, 40].map(name);
    assert.deepStrictEqual(
      selectBackupsToDelete(files, base).sort(),
      [name(12), name(40)].sort());
    // keepLast protects old backups when all are old
    const old = [20, 30, 40, 50].map(name);
    assert.deepStrictEqual(selectBackupsToDelete(old, base), [name(50)]);
  });

  it('never deletes foreign files or the newest backup', () => {
    const files = ['notes.txt', 'other_20200101T000000Z.zip', name(100)];
    assert.deepStrictEqual(selectBackupsToDelete(files, { ...base, keepLast: 0, keepDays: 1 }), []);
  });

  it('keeps one backup per recent month', () => {
    const files = [0, 35, 36, 65, 200].map(name);
    const del = selectBackupsToDelete(files, { ...base, keepLast: 1, keepDays: 1, keepMonthly: 3 });
    assert.ok(!del.includes(name(35)));
    assert.ok(del.includes(name(200)));
  });

  it('keeps one backup per recent ISO week', () => {
    const files = [0, 1, 8, 9, 30].map(name);
    const del = selectBackupsToDelete(files, { ...base, keepLast: 1, keepDays: 1, keepWeekly: 2 });
    assert.ok(del.includes(name(30)));
    assert.ok(!del.includes(name(0)));
  });
});

describe('listZipEntries', () => {
  let dir;
  before(() => { dir = mkdtempSync(join(tmpdir(), 'bk-zip-')); });
  after(() => rmSync(dir, { recursive: true, force: true }));

  it('lists entry names', () => {
    const p = join(dir, 'a.zip');
    writeFileSync(p, VALID_ZIP);
    assert.deepStrictEqual([...listZipEntries(p)].sort(), ['db/config.json', 'db/users.json']);
  });

  it('throws for a non-ZIP file', () => {
    const p = join(dir, 'b.zip');
    writeFileSync(p, 'not a zip at all, long enough to scan for the signature');
    assert.throws(() => listZipEntries(p));
  });
});

describe('acquireLock', () => {
  let dir;
  before(() => { dir = mkdtempSync(join(tmpdir(), 'bk-lock-')); });
  after(() => rmSync(dir, { recursive: true, force: true }));

  it('blocks a second holder, replaces a stale lock', () => {
    const lock = join(dir, 'l');
    const release = acquireLock(lock);
    assert.throws(() => acquireLock(lock), e => e instanceof BackupError && e.exitCode === EXIT.LOCKED);
    release();
    writeFileSync(lock, '999999999');
    acquireLock(lock)();
    assert.ok(!existsSync(lock));
  });
});

describe('runBackup', () => {
  let dir;
  let server;
  let baseUrl;
  /** @type {{status: number, body: Buffer, corruptSha?: boolean, calls: string[]}} */
  const state = { status: 200, body: VALID_ZIP, calls: [] };

  before(async () => {
    server = http.createServer((req, res) => {
      state.calls.push(`${req.method} ${req.url}`);
      if (req.url === '/api/v1/auth/login') {
        req.resume();
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ sessionId: 'sess1' }));
      } else if (req.url === '/api/v1/auth/logout') {
        res.end('{}');
      } else if (req.url === '/api/plugins/backup-restore/download') {
        if (req.headers['x-session-id'] !== 'sess1') { res.statusCode = 401; return res.end(); }
        res.statusCode = state.status;
        if (state.status !== 200) return res.end();
        const sha = createHash('sha256').update(state.body).digest('hex');
        res.setHeader('X-Content-SHA256', state.corruptSha ? 'deadbeef' : sha);
        res.setHeader('Content-Length', state.body.length);
        res.end(state.body);
      } else {
        res.statusCode = 404;
        res.end();
      }
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });
  after(() => new Promise(r => server.close(r)));

  /** @param {object} [over] */
  const options = over => ({
    destDir: dir, baseUrl, username: 'u', password: 'p', prefix: 'app', keepLast: 2, keepDays: 30,
    keepWeekly: 0, keepMonthly: 0, minSize: 10, retries: 1, timeout: 10, backoffMs: [1], dryRun: false,
    log: () => {}, ...over,
  });

  const reset = () => {
    dir = mkdtempSync(join(tmpdir(), 'bk-run-'));
    Object.assign(state, { status: 200, body: VALID_ZIP, corruptSha: false, calls: [] });
  };

  it('downloads, verifies, logs out and leaves only the final file', async () => {
    reset();
    const path = await runBackup(options());
    assert.ok(parseBackupFileName(path.split('/').pop(), 'app'));
    assert.strictEqual(statSync(path).mode & 0o777, 0o600);
    assert.deepStrictEqual(readdirSync(dir).filter(n => !n.startsWith('.')).length, 1);
    assert.ok(readdirSync(dir).every(n => !n.endsWith('.part')));
    assert.ok(state.calls.includes('POST /api/v1/auth/logout'));
    rmSync(dir, { recursive: true });
  });

  it('prunes only after success and keeps old backups when the download fails', async () => {
    reset();
    for (const d of ['20200101T000000Z', '20200102T000000Z', '20200103T000000Z']) {
      writeFileSync(join(dir, `app_${d}.zip`), 'old');
    }
    state.status = 500;
    await assert.rejects(runBackup(options()), e => e.exitCode === EXIT.FAILED);
    assert.strictEqual(readdirSync(dir).filter(n => n.endsWith('.zip')).length, 3);

    state.status = 200;
    await runBackup(options());
    // keepLast 2: the new one plus the newest old one
    assert.deepStrictEqual(readdirSync(dir).filter(n => n.endsWith('.zip')).length, 2);
    assert.ok(existsSync(join(dir, 'app_20200103T000000Z.zip')));
    rmSync(dir, { recursive: true });
  });

  it('rejects checksum mismatch, tiny and invalid files without leaving a final file', async () => {
    reset();
    state.corruptSha = true;
    await assert.rejects(runBackup(options({ retries: 0 })), /SHA-256/);
    state.corruptSha = false;
    state.body = Buffer.from('x'.repeat(100));
    await assert.rejects(runBackup(options({ retries: 0 })), /not a valid ZIP/);
    state.body = buildZip(['db/users.json']);
    await assert.rejects(runBackup(options({ retries: 0 })), /lacks required files/);
    state.body = VALID_ZIP;
    await assert.rejects(runBackup(options({ retries: 0, minSize: 1e6 })), /too small/);
    assert.deepStrictEqual(readdirSync(dir).filter(n => !n.startsWith('.lock')), []);
    rmSync(dir, { recursive: true });
  });

  it('maps 403 to the auth exit code without retrying', async () => {
    reset();
    state.status = 403;
    await assert.rejects(runBackup(options({ retries: 3 })), e => e.exitCode === EXIT.AUTH);
    assert.strictEqual(state.calls.filter(c => c.endsWith('/download')).length, 1);
    rmSync(dir, { recursive: true });
  });

  it('retries on 5xx', async () => {
    reset();
    state.status = 503;
    await assert.rejects(runBackup(options({ retries: 2 })), e => e.exitCode === EXIT.FAILED);
    assert.strictEqual(state.calls.filter(c => c.endsWith('/download')).length, 3);
    rmSync(dir, { recursive: true });
  });

  it('dry-run changes nothing', async () => {
    reset();
    writeFileSync(join(dir, 'app_20200101T000000Z.zip'), 'old');
    const logs = [];
    await runBackup(options({ dryRun: true, keepLast: 1, keepDays: 1, log: m => logs.push(m) }));
    assert.deepStrictEqual(readdirSync(dir), ['app_20200101T000000Z.zip']);
    assert.strictEqual(state.calls.length, 0);
    assert.ok(logs.some(l => l.includes('dry-run')));
    rmSync(dir, { recursive: true });
  });
});
