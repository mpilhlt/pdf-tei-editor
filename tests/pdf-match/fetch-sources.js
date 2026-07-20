#!/usr/bin/env node
/**
 * Materializes the source PDFs used by the pdf-match test pipeline into
 * sources/<docid>.pdf, from whichever source the manifest
 * (sources/sources.json) provides. PDFs are not committed to git (see
 * .gitignore); this script re-materializes them on demand.
 *
 * Each manifest entry may declare any mix of:
 *   - sourcePath  local PDF to copy in (absolute, or relative to repo root)
 *   - downloadUrl direct PDF download URL
 *   - doi         used to re-resolve a download URL (Unpaywall, then
 *                 Crossref) if downloadUrl is absent or fails
 *   - sha256      optional integrity check
 *
 * Resolution precedence per docid: existing verified file on disk ->
 * sourcePath -> downloadUrl -> doi. See sources/README.md for the full
 * manifest schema and rationale.
 *
 * Usage:
 *   node tests/pdf-match/fetch-sources.js [--id <docid>] [--force] [--all]
 *
 * --id <docid>  Only fetch this one document.
 * --force       Re-fetch even if the file already exists and checksums ok.
 * --all         No-op alias for the default behavior (fetch everything
 *               missing); accepted for explicitness in scripts/docs.
 *
 * Zero dependencies: uses only node:fs, node:path, node:crypto and the
 * global fetch (Node >= 18).
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SOURCES_DIR = path.join(__dirname, 'sources');
const MANIFEST_PATH = path.join(SOURCES_DIR, 'sources.json');
const REPO_ROOT = path.join(__dirname, '..', '..');

const USER_AGENT = 'pdf-tei-editor-test/1.0 (+https://github.com/mpilhlt/pdf-tei-editor)';
const UNPAYWALL_EMAIL = 'cmboulanger@gmail.com';

/**
 * @typedef {Object} SourceEntry
 * @property {string} [doi]
 * @property {string} [downloadUrl]
 * @property {string} [sourcePath]
 * @property {string} [sha256]
 * @property {string} description
 * @property {string} [resolvedVia]
 */

function parseArgs(argv) {
  const args = { id: null, force: false, all: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--id') {
      args.id = argv[++i];
    } else if (a === '--force') {
      args.force = true;
    } else if (a === '--all') {
      args.all = true;
    } else {
      console.error(`Unknown argument: ${a}`);
      process.exit(2);
    }
  }
  return args;
}

/** @returns {Record<string, SourceEntry>} */
function loadManifest() {
  const raw = JSON.parse(readFileSync(MANIFEST_PATH, 'utf-8'));
  const { _comment, ...entries } = raw;
  return entries;
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function isPdf(buffer) {
  return buffer.subarray(0, 4).toString('latin1') === '%PDF';
}

/**
 * Download a URL, following redirects (fetch does this natively), returning
 * a Buffer on success or throwing on network error / non-2xx status.
 * @param {string} url
 * @returns {Promise<Buffer>}
 */
async function download(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT },
    redirect: 'follow'
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

/**
 * Resolve a fallback PDF URL for a DOI via Unpaywall, then Crossref.
 * @param {string} doi
 * @returns {Promise<{ source: string, url: string } | null>}
 */
async function resolveFallbackUrl(doi) {
  // Unpaywall
  try {
    const uw = await fetch(
      `https://api.unpaywall.org/v2/${encodeURIComponent(doi)}?email=${encodeURIComponent(UNPAYWALL_EMAIL)}`,
      { headers: { 'User-Agent': USER_AGENT } }
    );
    if (uw.ok) {
      const data = await uw.json();
      const url = data?.best_oa_location?.url_for_pdf;
      if (url) {
        return { source: 'unpaywall', url };
      }
    }
  } catch {
    // ignore, fall through to Crossref
  }

  // Crossref
  try {
    const cr = await fetch(`https://api.crossref.org/works/${encodeURIComponent(doi)}`, {
      headers: { 'User-Agent': USER_AGENT }
    });
    if (cr.ok) {
      const data = await cr.json();
      const links = data?.message?.link ?? [];
      const pdfLink = links.find((l) => typeof l['content-type'] === 'string' && l['content-type'].includes('pdf'));
      if (pdfLink?.URL) {
        return { source: 'crossref', url: pdfLink.URL };
      }
    }
  } catch {
    // ignore
  }

  return null;
}

/**
 * Try to obtain the PDF bytes for one docid, trying sourcePath, then
 * downloadUrl, then doi (Unpaywall/Crossref) in order. Does not write
 * anything to disk.
 * @param {string} docid
 * @param {SourceEntry} entry
 * @returns {Promise<{ buffer: Buffer, via: string } | { error: string } | null>}
 *   null means "no source declared / all sources exhausted with nothing
 *   fatal to report"; { error } means a fatal, non-recoverable problem
 *   (e.g. local file exists but isn't a PDF); otherwise the obtained buffer.
 */
async function obtainBuffer(docid, entry) {
  if (entry.sourcePath) {
    const resolved = path.isAbsolute(entry.sourcePath) ? entry.sourcePath : path.join(REPO_ROOT, entry.sourcePath);
    if (existsSync(resolved)) {
      const buf = readFileSync(resolved);
      if (!isPdf(buf)) {
        return { error: `local file at ${resolved} does not start with %PDF — not a valid PDF, rejecting` };
      }
      return { buffer: buf, via: `copied from ${resolved}` };
    }
    console.warn(`[${docid}] sourcePath ${resolved} does not exist, falling back to remote sources...`);
  }

  if (entry.downloadUrl) {
    try {
      const buf = await download(entry.downloadUrl);
      return { buffer: buf, via: 'downloadUrl' };
    } catch (err) {
      console.warn(`[${docid}] downloadUrl failed (${err.message}), trying DOI fallback resolution...`);
    }
  }

  if (entry.doi) {
    const fallback = await resolveFallbackUrl(entry.doi);
    if (fallback) {
      try {
        const buf = await download(fallback.url);
        return { buffer: buf, via: fallback.source };
      } catch (err) {
        console.warn(`[${docid}] DOI fallback (${fallback.source}) download failed: ${err.message}`);
      }
    } else {
      console.warn(`[${docid}] DOI fallback resolution (Unpaywall/Crossref) found no PDF link for ${entry.doi}`);
    }
  }

  return null;
}

/**
 * Fetch and verify a single document, writing it to sources/<docid>.pdf on
 * success.
 * @param {string} docid
 * @param {SourceEntry} entry
 * @param {boolean} force
 * @returns {Promise<'ok'|'fetched'|'failed'>}
 */
async function fetchOne(docid, entry, force) {
  const destPath = path.join(SOURCES_DIR, `${docid}.pdf`);

  if (existsSync(destPath) && !force) {
    if (!entry.sha256) {
      console.log(`[${docid}] ok (no checksum recorded)`);
      return 'ok';
    }
    const existing = readFileSync(destPath);
    const actual = sha256(existing);
    if (actual === entry.sha256) {
      console.log(`[${docid}] ok (already present, checksum verified)`);
      return 'ok';
    }
    console.error(`[${docid}] CHECKSUM MISMATCH for existing file`);
    console.error(`  expected: ${entry.sha256}`);
    console.error(`  actual:   ${actual}`);
    console.error(`  Use --id ${docid} --force to re-fetch.${entry.doi ? ` DOI: ${entry.doi}` : ''}`);
    return 'failed';
  }

  const result = await obtainBuffer(docid, entry);

  if (result && 'error' in result) {
    console.error(`[${docid}] FAILED — ${result.error}`);
    return 'failed';
  }

  if (!result) {
    console.error(`[${docid}] FAILED — no source available`);
    console.error(
      `  Add a "sourcePath", "downloadUrl" or "doi" for "${docid}" in sources.json, or place the PDF manually at tests/pdf-match/sources/${docid}.pdf`
    );
    return 'failed';
  }

  const { buffer: buf, via } = result;

  if (!isPdf(buf)) {
    console.error(`[${docid}] FAILED — obtained content (via ${via}) does not start with %PDF`);
    if (entry.doi) console.error(`  doi: ${entry.doi}`);
    return 'failed';
  }

  const actual = sha256(buf);
  if (entry.sha256 && actual !== entry.sha256) {
    console.error(`[${docid}] CHECKSUM MISMATCH after fetch (via ${via})`);
    console.error(`  expected: ${entry.sha256}`);
    console.error(`  actual:   ${actual}`);
    console.error('  The publisher may have changed the file. Not writing it.');
    if (entry.doi) console.error(`  DOI to re-resolve: ${entry.doi}`);
    return 'failed';
  }

  mkdirSync(SOURCES_DIR, { recursive: true });
  writeFileSync(destPath, buf);
  console.log(`[${docid}] fetched (${via}), ${buf.length} bytes${entry.sha256 ? ', checksum verified' : ''}`);
  if (!entry.sha256) {
    console.log(`  hint: add "sha256": "${actual}" to sources.json to enable integrity checking`);
  }
  return 'fetched';
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const manifest = loadManifest();

  let docids;
  if (args.id) {
    if (!manifest[args.id]) {
      console.error(`Unknown docid: ${args.id}`);
      console.error(`Known docids: ${Object.keys(manifest).join(', ')}`);
      process.exit(2);
    }
    docids = [args.id];
  } else {
    docids = Object.keys(manifest);
  }

  let okCount = 0;
  let fetchedCount = 0;
  let failedCount = 0;

  for (const docid of docids) {
    const entry = manifest[docid];
    const result = await fetchOne(docid, entry, args.force);
    if (result === 'ok') okCount++;
    else if (result === 'fetched') fetchedCount++;
    else failedCount++;
  }

  console.log(`${okCount} ok, ${fetchedCount} fetched, ${failedCount} failed`);
  process.exit(failedCount > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
