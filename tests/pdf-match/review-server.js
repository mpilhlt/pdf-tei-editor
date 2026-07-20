#!/usr/bin/env node
/**
 * Interactive review server for pdf-match test cases. Zero-dependency
 * replacement for the static report.html + confirm.js CLI workflow.
 *
 * Usage:
 *   node tests/pdf-match/review-server.js [--port 8899]
 *
 * Serves the review UI at http://127.0.0.1:<port>/, an API to list cases
 * and their current review state, page-image PNGs, and an endpoint to
 * accept/reject a case (writing the same case files confirm.js writes).
 *
 * Run `node tests/pdf-match/run-cases.js` first so results.json exists.
 */

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import {
  loadCases, caseFilePath, loadFixture, RESULTS_PATH,
  acceptCase, rejectCase, recordRejection
} from './lib.js';

const baseDir = path.dirname(fileURLToPath(import.meta.url));
const PAGES_DIR = path.join(baseDir, 'pages');
const UI_PATH = path.join(baseDir, 'review-ui.html');

const { values } = parseArgs({ options: { port: { type: 'string', default: '8899' } } });
const PORT = Number(values.port);

const SAFE_TOKEN = /^[A-Za-z0-9._-]+$/;

/**
 * Reads results.json, if present.
 * @returns {Array<Object>} Match results keyed by case id (empty array if run-cases.js was never run)
 */
function readResults() {
  if (!fs.existsSync(RESULTS_PATH)) return [];
  return JSON.parse(fs.readFileSync(RESULTS_PATH, 'utf-8'));
}

/**
 * @param {Object} caseData - A case object from loadCases()
 * @returns {'accepted'|'rejected'|'unreviewed'} The current review state
 */
function reviewStateOf(caseData) {
  if (caseData.expected) return 'accepted';
  if (caseData.rejected) return 'rejected';
  return 'unreviewed';
}

/**
 * Builds the payload for GET /api/cases: one entry per case, merging case
 * data, the proposed match from results.json, and the matched page's
 * viewport (for the bbox overlay math).
 * @returns {Array<Object>}
 */
function buildCasesPayload() {
  const cases = loadCases();
  const resultsById = new Map(readResults().map(r => [r.id, r]));
  const fixtureCache = new Map();

  return cases.map(c => {
    const r = resultsById.get(c.id);
    const match = r && r.match ? r.match : null;
    let viewport = null;
    if (match) {
      if (!fixtureCache.has(c.pdf)) {
        try {
          fixtureCache.set(c.pdf, loadFixture(c.pdf));
        } catch {
          fixtureCache.set(c.pdf, null);
        }
      }
      const fixture = fixtureCache.get(c.pdf);
      const pageInfo = fixture && fixture.pages[match.page - 1];
      viewport = pageInfo ? pageInfo.viewport : null;
    }
    return {
      id: c.id,
      pdf: c.pdf,
      queryText: c.queryText,
      xpath: c.xpath,
      match: match ? {
        page: match.page,
        score: match.score,
        bbox: match.bbox,
        matchedText: match.matchedText
      } : null,
      candidates: r ? r.candidates : [],
      viewport,
      status: r ? r.status : 'unreviewed',
      goldIou: r ? r.goldIou : null,
      reviewState: reviewStateOf(c),
      rejectNote: c.rejectNote || null
    };
  });
}

/**
 * Sends a JSON response.
 * @param {http.ServerResponse} res - Response object
 * @param {number} status - HTTP status code
 * @param {unknown} body - Value to serialize as JSON
 * @returns {void}
 */
function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(data) });
  res.end(data);
}

/**
 * Reads and parses a JSON request body.
 * @param {http.IncomingMessage} req - Request object
 * @returns {Promise<Object>} Parsed JSON body
 */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === 'GET' && url.pathname === '/') {
      const html = fs.readFileSync(UI_PATH, 'utf-8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/cases') {
      sendJson(res, 200, buildCasesPayload());
      return;
    }

    if (req.method === 'GET' && url.pathname.startsWith('/pages/')) {
      const parts = url.pathname.slice('/pages/'.length).split('/');
      if (parts.length !== 2) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('Bad request: expected /pages/<docid>/<filename>');
        return;
      }
      const [docid, filename] = parts;
      const pageMatch = /^page-(\d+)\.png$/.exec(filename);
      if (!SAFE_TOKEN.test(docid) || !pageMatch) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('Bad request: invalid docid or filename');
        return;
      }
      const filePath = path.join(PAGES_DIR, docid, filename);
      // Defence in depth: resolved path must stay inside PAGES_DIR even
      // though SAFE_TOKEN already rejects '/', '..' and encoded variants.
      const resolved = path.resolve(filePath);
      if (!resolved.startsWith(path.resolve(PAGES_DIR) + path.sep)) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('Bad request: invalid path');
        return;
      }
      if (!fs.existsSync(resolved)) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end(`Page image not found: ${docid}/${filename}. Re-run extract-fixtures.js with --render to regenerate page PNGs.`);
        return;
      }
      const bytes = fs.readFileSync(resolved);
      res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': bytes.length });
      res.end(bytes);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/verdict') {
      let body;
      try {
        body = await readJsonBody(req);
      } catch {
        sendJson(res, 400, { error: 'Invalid JSON body' });
        return;
      }
      const { id, verdict, note } = body;
      if (typeof id !== 'string' || !SAFE_TOKEN.test(id) || !fs.existsSync(caseFilePath(id))) {
        sendJson(res, 400, { error: 'Invalid or unknown case id' });
        return;
      }
      if (verdict !== 'accept' && verdict !== 'reject') {
        sendJson(res, 400, { error: "verdict must be 'accept' or 'reject'" });
        return;
      }

      const results = readResults();
      const r = results.find(x => x.id === id) || null;
      const cases = loadCases();
      const caseData = cases.find(c => c.id === id) || null;

      if (verdict === 'accept') {
        if (!r || !r.match) {
          sendJson(res, 400, { error: 'No proposed match in results.json - cannot accept' });
          return;
        }
        acceptCase(id, r.match);
      } else {
        rejectCase(id, { note });
        recordRejection({
          id,
          pdf: r ? r.pdf : (caseData ? caseData.pdf : undefined),
          page: r && r.match ? r.match.page : null,
          score: r && r.match ? r.match.score : null,
          queryText: caseData ? caseData.queryText : undefined,
          matchedText: r && r.match ? r.match.matchedText : null,
          bbox: r && r.match ? r.match.bbox : null,
          candidates: r ? r.candidates : undefined,
          note: note || undefined
        });
      }

      sendJson(res, 200, { id, reviewState: verdict === 'accept' ? 'accepted' : 'rejected' });
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  } catch (err) {
    console.error(err);
    sendJson(res, 500, { error: String(err && err.message || err) });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`pdf-match review server: http://127.0.0.1:${PORT}/`);
});
