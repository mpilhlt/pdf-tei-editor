#!/usr/bin/env node
/**
 * Freezes reviewed matches into case files as gold expectations.
 *
 * Usage:
 *   node tests/pdf-match/confirm.js [--accept id1,id2] [--reject id3,id4]
 *
 * --accept copies the proposed match (page + bbox) from results.json into
 *   the case file's `expected` field (frozen gold).
 * --reject clears `expected` and marks the case `rejected: true` so it
 *   stays in the open failure set to debug. Also records diagnostics in
 *   rejected.json (pdf, page, score, texts, candidates) for later
 *   matcher debugging.
 */

import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { RESULTS_PATH, loadCases, acceptCase, rejectCase, recordRejection } from './lib.js';

const { values } = parseArgs({
  options: {
    accept: { type: 'string', default: '' },
    reject: { type: 'string', default: '' }
  }
});

if (!values.accept && !values.reject) {
  console.error('Usage: node tests/pdf-match/confirm.js [--accept id1,id2] [--reject id3,id4]');
  process.exit(1);
}

const results = JSON.parse(fs.readFileSync(RESULTS_PATH, 'utf-8'));
const byId = new Map(results.map(r => [r.id, r]));
const casesById = new Map(loadCases().map(c => [c.id, c]));

for (const id of values.accept.split(',').filter(Boolean)) {
  const r = byId.get(id);
  if (!r || !r.match) {
    console.error(`${id}: no proposed match in results.json - cannot accept`);
    continue;
  }
  acceptCase(id, r.match);
  console.log(`${id}: accepted (page ${r.match.page})`);
}

for (const id of values.reject.split(',').filter(Boolean)) {
  const r = byId.get(id);
  rejectCase(id);
  const c = casesById.get(id);
  recordRejection({
    id,
    pdf: r ? r.pdf : undefined,
    page: r && r.match ? r.match.page : null,
    score: r && r.match ? r.match.score : null,
    queryText: c ? c.queryText : undefined,
    matchedText: r && r.match ? r.match.matchedText : null,
    bbox: r && r.match ? r.match.bbox : null,
    candidates: r ? r.candidates : undefined
  });
  console.log(`${id}: rejected`);
}
