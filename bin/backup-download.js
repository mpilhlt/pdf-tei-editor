#!/usr/bin/env node

/**
 * Download a backup of the application data for use in cron jobs.
 *
 * Logs in, downloads the backup ZIP from the Backup & Restore plugin to a
 * timestamped file, verifies it, and prunes old backups. The user needs the
 * `backup` role.
 *
 * Usage:
 *   node bin/backup-download.js --dest-dir /var/backups/pdf-tei-editor [options]
 *
 * Exit codes:
 *   0 success, 1 download/verification failed, 2 authentication/authorization
 *   failed, 3 another run holds the lock, 4 invalid arguments or unwritable
 *   destination.
 *
 * See docs/user-manual/import-export-admin.md for details and a cron example.
 */

import { Command } from 'commander';
import dotenv from 'dotenv';
import { createHash } from 'crypto';
import {
  closeSync, createWriteStream, existsSync, fsyncSync, mkdirSync, openSync, readFileSync,
  readSync, readdirSync, renameSync, statSync, unlinkSync, writeSync,
} from 'fs';
import { resolve, join } from 'path';
import { pathToFileURL } from 'url';
import { Readable, Transform } from 'stream';
import { pipeline } from 'stream/promises';

const DOWNLOAD_PATH = '/api/plugins/backup-restore/download';
const REQUIRED_ZIP_ENTRIES = ['db/users.json', 'db/config.json'];
const DAY_MS = 24 * 3600 * 1000;

export const EXIT = { OK: 0, FAILED: 1, AUTH: 2, LOCKED: 3, USAGE: 4 };

/** Error carrying the process exit code. */
export class BackupError extends Error {
  /**
   * @param {string} message
   * @param {number} exitCode
   * @param {boolean} [retryable]
   */
  constructor(message, exitCode, retryable = false) {
    super(message);
    this.exitCode = exitCode;
    this.retryable = retryable;
  }
}

// ============================================================================
// Naming and retention (pure functions)
// ============================================================================

/**
 * Format a date as the compact UTC timestamp used in backup file names.
 * @param {Date} date
 * @returns {string} e.g. 20261003T020000Z
 */
export function formatTimestamp(date) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Build the file name of a backup.
 * @param {string} prefix
 * @param {Date} date
 * @returns {string}
 */
export function backupFileName(prefix, date) {
  return `${prefix}_${formatTimestamp(date)}.zip`;
}

/**
 * Parse the timestamp from a backup file name.
 * @param {string} name
 * @param {string} prefix
 * @returns {Date|null} null if the name is not a backup file of this prefix
 */
export function parseBackupFileName(name, prefix) {
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`^${escaped}_(\\d{4})(\\d{2})(\\d{2})T(\\d{2})(\\d{2})(\\d{2})Z\\.zip$`).exec(name);
  if (!m) return null;
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number);
  const date = new Date(Date.UTC(y, mo - 1, d, h, mi, s));
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * ISO week key (UTC), e.g. "2026-W40".
 * @param {Date} date
 * @returns {string}
 */
function isoWeekKey(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((d.getTime() - yearStart) / DAY_MS + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/**
 * @typedef {object} RetentionOptions
 * @property {string} prefix - File name prefix
 * @property {number} keepLast - Always keep the newest n backups
 * @property {number} keepDays - Keep backups younger than n days
 * @property {number} keepWeekly - Additionally keep the newest backup of each of the n most recent ISO weeks that have backups
 * @property {number} keepMonthly - Same for calendar months
 * @property {Date} now - Reference time
 */

/**
 * Select the backup files to delete. Only files matching the exact naming
 * pattern for the prefix are considered; the newest backup is always kept.
 *
 * @param {string[]} fileNames - Names of the files in the destination directory
 * @param {RetentionOptions} options
 * @returns {string[]} names to delete
 */
export function selectBackupsToDelete(fileNames, options) {
  const { prefix, keepLast, keepDays, keepWeekly, keepMonthly, now } = options;
  const backups = fileNames
    .map(name => ({ name, date: parseBackupFileName(name, prefix) }))
    .filter(b => b.date)
    .sort((a, b) => b.date.getTime() - a.date.getTime());

  const keep = new Set();
  backups.slice(0, Math.max(keepLast, 1)).forEach(b => keep.add(b.name));
  const cutoff = now.getTime() - keepDays * DAY_MS;
  backups.filter(b => b.date.getTime() >= cutoff).forEach(b => keep.add(b.name));

  /** @param {(d: Date) => string} keyFn @param {number} n */
  const keepPerBucket = (keyFn, n) => {
    const seen = new Set();
    for (const b of backups) {
      const key = keyFn(b.date);
      if (seen.has(key)) continue;
      if (seen.size >= n) break;
      seen.add(key);
      keep.add(b.name);
    }
  };
  keepPerBucket(isoWeekKey, keepWeekly);
  keepPerBucket(d => `${d.getUTCFullYear()}-${d.getUTCMonth()}`, keepMonthly);

  return backups.filter(b => !keep.has(b.name)).map(b => b.name);
}

// ============================================================================
// ZIP verification
// ============================================================================

/**
 * Read a range of a file.
 * @param {number} fd
 * @param {number} position
 * @param {number} length
 * @returns {Buffer}
 */
function readRange(fd, position, length) {
  const buf = Buffer.alloc(length);
  let done = 0;
  while (done < length) {
    const n = readSync(fd, buf, done, length - done, position + done);
    if (n === 0) break;
    done += n;
  }
  return buf.subarray(0, done);
}

/**
 * List the entry names in a ZIP file by reading its central directory (ZIP64 aware).
 * @param {string} path
 * @returns {Set<string>}
 * @throws {Error} if the file is not a readable ZIP
 */
export function listZipEntries(path) {
  const size = statSync(path).size;
  const fd = openSync(path, 'r');
  try {
    const tailLen = Math.min(size, 22 + 0xffff);
    const tail = readRange(fd, size - tailLen, tailLen);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('end of central directory not found');

    let total = tail.readUInt16LE(eocd + 10);
    let cdSize = tail.readUInt32LE(eocd + 12);
    let cdOffset = tail.readUInt32LE(eocd + 16);

    if (total === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
      const locator = eocd - 20;
      if (locator < 0 || tail.readUInt32LE(locator) !== 0x07064b50) {
        throw new Error('ZIP64 locator not found');
      }
      const z64Offset = Number(tail.readBigUInt64LE(locator + 8));
      const z64 = readRange(fd, z64Offset, 56);
      if (z64.readUInt32LE(0) !== 0x06064b50) throw new Error('ZIP64 end record not found');
      total = Number(z64.readBigUInt64LE(32));
      cdSize = Number(z64.readBigUInt64LE(40));
      cdOffset = Number(z64.readBigUInt64LE(48));
    }

    const cd = readRange(fd, cdOffset, cdSize);
    const names = new Set();
    let pos = 0;
    for (let i = 0; i < total; i++) {
      if (cd.readUInt32LE(pos) !== 0x02014b50) throw new Error('corrupt central directory');
      const nameLen = cd.readUInt16LE(pos + 28);
      const extraLen = cd.readUInt16LE(pos + 30);
      const commentLen = cd.readUInt16LE(pos + 32);
      names.add(cd.toString('utf8', pos + 46, pos + 46 + nameLen));
      pos += 46 + nameLen + extraLen + commentLen;
    }
    return names;
  } finally {
    closeSync(fd);
  }
}

// ============================================================================
// Locking
// ============================================================================

/**
 * Acquire an exclusive lock file; stale locks (dead PID) are replaced.
 * @param {string} lockPath
 * @returns {() => void} release function
 * @throws {BackupError} exit code LOCKED if another run holds the lock
 */
export function acquireLock(lockPath) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(lockPath, 'wx', 0o600);
      writeSync(fd, String(process.pid));
      closeSync(fd);
      return () => { try { unlinkSync(lockPath); } catch { /* already gone */ } };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      const pid = Number(readFileSync(lockPath, 'utf8').trim());
      let alive = true;
      try { process.kill(pid, 0); } catch (e) { alive = e.code === 'EPERM'; }
      if (alive && pid) throw new BackupError(`Another backup run is active (pid ${pid})`, EXIT.LOCKED);
      unlinkSync(lockPath);
    }
  }
  throw new BackupError('Could not acquire lock', EXIT.LOCKED);
}

// ============================================================================
// Download
// ============================================================================

/**
 * @param {string} password
 * @returns {string} hex SHA-256
 */
function hashPassword(password) {
  return createHash('sha256').update(password).digest('hex');
}

/**
 * Log in and return the session id.
 * @param {string} baseUrl
 * @param {string} username
 * @param {string} password
 * @param {AbortSignal} signal
 * @returns {Promise<string>}
 */
async function login(baseUrl, username, password, signal) {
  let res;
  try {
    res = await fetch(`${baseUrl}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, passwd_hash: hashPassword(password) }),
      signal,
    });
  } catch (err) {
    throw new BackupError(`Login request failed: ${err.message}`, EXIT.FAILED, true);
  }
  if (res.status === 401 || res.status === 403) {
    throw new BackupError(`Login failed (${res.status}): wrong credentials`, EXIT.AUTH);
  }
  if (!res.ok) {
    throw new BackupError(`Login failed: HTTP ${res.status}`, EXIT.FAILED, res.status >= 500);
  }
  const data = await res.json();
  const sessionId = data.sessionId || data.session_id;
  if (!sessionId) throw new BackupError('Login response contained no session id', EXIT.FAILED);
  return sessionId;
}

/**
 * Download the backup to `partPath` and verify size and checksum against the response headers.
 * @param {string} baseUrl
 * @param {string} sessionId
 * @param {string} partPath
 * @param {AbortSignal} signal
 * @returns {Promise<number>} bytes written
 */
async function downloadTo(baseUrl, sessionId, partPath, signal) {
  let res;
  try {
    res = await fetch(`${baseUrl}${DOWNLOAD_PATH}`, { headers: { 'X-Session-ID': sessionId }, signal });
  } catch (err) {
    throw new BackupError(`Download request failed: ${err.message}`, EXIT.FAILED, true);
  }
  if (res.status === 401 || res.status === 403) {
    throw new BackupError(`Not authorized to download backups (${res.status}): the user needs the 'backup' role`, EXIT.AUTH);
  }
  if (res.status === 409 || res.status >= 500) {
    throw new BackupError(`Server returned HTTP ${res.status}`, EXIT.FAILED, true);
  }
  if (!res.ok || !res.body) {
    throw new BackupError(`Download failed: HTTP ${res.status}`, EXIT.FAILED);
  }

  const expectedLength = Number(res.headers.get('content-length')) || null;
  const expectedSha = res.headers.get('x-content-sha256');
  const hash = createHash('sha256');
  let bytes = 0;
  const counter = new Transform({
    transform(chunk, _enc, cb) { bytes += chunk.length; hash.update(chunk); cb(null, chunk); },
  });

  const out = createWriteStream(partPath, { mode: 0o600 });
  try {
    await pipeline(Readable.fromWeb(/** @type {any} */ (res.body)), counter, out);
  } catch (err) {
    throw new BackupError(`Download interrupted: ${err.message}`, EXIT.FAILED, true);
  }
  const fd = openSync(partPath, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }

  if (expectedLength !== null && bytes !== expectedLength) {
    throw new BackupError(`Size mismatch: received ${bytes} of ${expectedLength} bytes`, EXIT.FAILED, true);
  }
  if (expectedSha && hash.digest('hex') !== expectedSha) {
    throw new BackupError('SHA-256 mismatch between download and server header', EXIT.FAILED, true);
  }
  return bytes;
}

/**
 * Check that the downloaded file is a plausible backup.
 * @param {string} path
 * @param {number} minSize
 * @throws {BackupError}
 */
function verifyBackup(path, minSize) {
  const size = statSync(path).size;
  if (size < minSize) throw new BackupError(`Backup is too small (${size} bytes < ${minSize})`, EXIT.FAILED);
  let entries;
  try {
    entries = listZipEntries(path);
  } catch (err) {
    throw new BackupError(`Backup is not a valid ZIP: ${err.message}`, EXIT.FAILED);
  }
  const missing = REQUIRED_ZIP_ENTRIES.filter(e => !entries.has(e));
  if (missing.length) throw new BackupError(`Backup lacks required files: ${missing.join(', ')}`, EXIT.FAILED);
}

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * @typedef {object} RunOptions
 * @property {string} destDir
 * @property {string} baseUrl
 * @property {string} username
 * @property {string} password
 * @property {string} prefix
 * @property {number} keepLast
 * @property {number} keepDays
 * @property {number} keepWeekly
 * @property {number} keepMonthly
 * @property {number} minSize
 * @property {number} retries
 * @property {number} timeout - seconds
 * @property {number[]} [backoffMs] - retry delays (default 5 s, 15 s, 45 s)
 * @property {boolean} dryRun
 * @property {(msg: string) => void} log
 */

/**
 * Perform a backup run: download, verify, rename, prune.
 * @param {RunOptions} o
 * @returns {Promise<string|null>} path of the new backup (null in dry-run mode)
 * @throws {BackupError}
 */
export async function runBackup(o) {
  if (o.keepLast < 1 && o.keepDays < 1) {
    throw new BackupError('--keep-last and --keep-days must not both be 0', EXIT.USAGE);
  }
  if (!o.dryRun) {
    try {
      mkdirSync(o.destDir, { recursive: true, mode: 0o700 });
    } catch (err) {
      throw new BackupError(`Cannot use destination ${o.destDir}: ${err.message}`, EXIT.USAGE);
    }
  }

  const now = new Date();
  const finalName = backupFileName(o.prefix, now);
  const finalPath = join(o.destDir, finalName);
  const partPath = join(o.destDir, `.${finalName}.part`);

  const retention = () => selectBackupsToDelete(existsSync(o.destDir) ? readdirSync(o.destDir) : [], {
    prefix: o.prefix, keepLast: o.keepLast, keepDays: o.keepDays,
    keepWeekly: o.keepWeekly, keepMonthly: o.keepMonthly, now,
  });

  if (o.dryRun) {
    o.log(`[dry-run] would download ${o.baseUrl}${DOWNLOAD_PATH} to ${finalPath}`);
    const wouldDelete = retention();
    wouldDelete.forEach(n => o.log(`[dry-run] would delete ${n}`));
    return null;
  }

  const release = acquireLock(join(o.destDir, '.backup-download.lock'));
  const backoff = o.backoffMs || [5000, 15000, 45000];
  try {
    for (let attempt = 0; ; attempt++) {
      const signal = AbortSignal.timeout(o.timeout * 1000);
      let sessionId = null;
      try {
        sessionId = await login(o.baseUrl, o.username, o.password, signal);
        const bytes = await downloadTo(o.baseUrl, sessionId, partPath, signal);
        verifyBackup(partPath, o.minSize);
        renameSync(partPath, finalPath);
        o.log(`Saved ${finalPath} (${bytes} bytes)`);
        break;
      } catch (err) {
        try { unlinkSync(partPath); } catch { /* none written */ }
        if (!(err instanceof BackupError) || !err.retryable || attempt >= o.retries) throw err;
        const delay = backoff[Math.min(attempt, backoff.length - 1)];
        o.log(`${err.message}; retrying in ${delay / 1000}s (${attempt + 1}/${o.retries})`);
        await sleep(delay);
      } finally {
        if (sessionId) {
          await fetch(`${o.baseUrl}/api/v1/auth/logout`, {
            method: 'POST', headers: { 'X-Session-ID': sessionId }, signal: AbortSignal.timeout(10000),
          }).catch(() => { /* best effort */ });
        }
      }
    }

    // Retention only runs after a verified download
    for (const name of retention()) {
      unlinkSync(join(o.destDir, name));
      o.log(`Deleted old backup ${name}`);
    }
    return finalPath;
  } finally {
    release();
  }
}

// ============================================================================
// CLI
// ============================================================================

/**
 * Parse a non-negative integer option.
 * @param {string} value
 * @returns {number}
 */
function parseCount(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw new BackupError(`Invalid number: ${value}`, EXIT.USAGE);
  return n;
}

/**
 * Ping a monitoring URL; failures are ignored.
 * @param {string|undefined} url
 * @param {boolean} ok
 */
async function ping(url, ok) {
  if (!url) return;
  const target = ok ? url : `${url.replace(/\/$/, '')}/fail`;
  await fetch(target, { signal: AbortSignal.timeout(10000) }).catch(() => { /* best effort */ });
}

async function main() {
  const program = new Command();
  program
    .name('backup-download')
    .description('Download a backup of the application data, verify it and prune old backups')
    .requiredOption('--dest-dir <dir>', 'Target directory for backups')
    .option('--env <path>', 'Path to .env file with API_BASE_URL, API_USER, API_PASSWORD', './.env')
    .option('--base-url <url>', 'API base URL (default: API_BASE_URL or http://localhost:8000)')
    .option('--user <name>', 'Username (default: API_USER)')
    .option('--password-file <path>', 'File containing the password (default: API_PASSWORD)')
    .option('--prefix <str>', 'File name prefix', 'pdf-tei-editor')
    .option('--keep-last <n>', 'Always keep the newest n backups', parseCount, 7)
    .option('--keep-days <n>', 'Delete backups older than n days (never below --keep-last)', parseCount, 30)
    .option('--keep-weekly <n>', 'Also keep the newest backup of each of the n most recent ISO weeks', parseCount, 0)
    .option('--keep-monthly <n>', 'Also keep the newest backup of each of the n most recent months', parseCount, 0)
    .option('--min-size <bytes>', 'Reject downloads smaller than this', parseCount, 1024)
    .option('--retries <n>', 'Retries on network errors and 5xx', parseCount, 3)
    .option('--timeout <sec>', 'Timeout per attempt in seconds', parseCount, 3600)
    .option('--ping-url <url>', 'Monitoring URL: GET on success, <url>/fail on failure')
    .option('--dry-run', 'Show what would be downloaded and deleted, change nothing', false)
    .option('--quiet', 'Print only errors', false);
  program.parse();
  const opts = program.opts();

  dotenv.config({ path: resolve(opts.env), quiet: true });
  const username = opts.user || process.env.API_USER;
  let password = process.env.API_PASSWORD;
  if (opts.passwordFile) {
    try {
      password = readFileSync(opts.passwordFile, 'utf8').replace(/\r?\n$/, '');
    } catch (err) {
      throw new BackupError(`Cannot read password file: ${err.message}`, EXIT.USAGE);
    }
  }
  if (!username || !password) {
    throw new BackupError('Username and password required (--user/--password-file or API_USER/API_PASSWORD)', EXIT.USAGE);
  }

  const destDir = resolve(opts.destDir);
  try {
    await runBackup({
      destDir,
      baseUrl: (opts.baseUrl || process.env.API_BASE_URL || 'http://localhost:8000').replace(/\/$/, ''),
      username,
      password,
      prefix: opts.prefix,
      keepLast: opts.keepLast,
      keepDays: opts.keepDays,
      keepWeekly: opts.keepWeekly,
      keepMonthly: opts.keepMonthly,
      minSize: opts.minSize,
      retries: opts.retries,
      timeout: opts.timeout,
      dryRun: opts.dryRun,
      log: msg => { if (!opts.quiet) console.log(msg); },
    });
    await ping(opts.pingUrl, true);
  } catch (err) {
    // A held lock means a previous run is still active, not that the backup failed
    if (!(err instanceof BackupError && err.exitCode === EXIT.LOCKED)) await ping(opts.pingUrl, false);
    throw err;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    () => process.exit(EXIT.OK),
    err => {
      console.error(`backup-download: ${err.message}`);
      process.exit(err instanceof BackupError ? err.exitCode : EXIT.FAILED);
    },
  );
}
