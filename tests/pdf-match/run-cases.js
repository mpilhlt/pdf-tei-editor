#!/usr/bin/env node
/**
 * Runs the matcher over all cases, writes results.json (consumed by
 * confirm.js) and report.html for visual review.
 *
 * Usage: node tests/pdf-match/run-cases.js
 *
 * Report semantics per case:
 * - pass:       has gold expectation and the match agrees (page + IoU >= 0.3)
 * - fail:       has gold expectation and the match disagrees (or no match)
 * - rejected:   reviewed and rejected (no gold expectation) via confirm.js or
 *               the review app
 * - unreviewed: no gold expectation yet — review visually, then accept or
 *               reject via confirm.js
 */

import fs from 'node:fs';
import { parseArgs } from 'node:util';
import {
  loadCases, loadFixture, runCase, iou,
  RESULTS_PATH, REPORT_PATH
} from './lib.js';

const MIN_IOU = 0.3;

parseArgs({ options: {} }); // fail fast on unknown arguments

const cases = loadCases();
if (cases.length === 0) {
  console.error('No cases found. Run generate-cases.js first.');
  process.exit(1);
}

const results = [];
for (const caseData of cases) {
  const { match, candidates } = runCase(caseData);
  let status = 'unreviewed';
  let goldIou = null;
  if (caseData.expected) {
    if (match && match.page === caseData.expected.page) {
      goldIou = iou(match.bbox, caseData.expected.bbox);
      status = goldIou >= MIN_IOU ? 'pass' : 'fail';
    } else {
      goldIou = 0;
      status = 'fail';
    }
  } else if (caseData.rejected) {
    status = 'rejected';
  }
  results.push({ id: caseData.id, pdf: caseData.pdf, match, candidates, status, goldIou });
  console.log(`${caseData.id}: ${match ? `page ${match.page} score ${match.score.toFixed(3)}` : 'NO MATCH'} [${status}]`);
}

fs.writeFileSync(RESULTS_PATH, JSON.stringify(results, null, 2));

// ---------- HTML report ----------

/** @param {unknown} s */
const esc = s => String(s).replace(/[&<>"']/g,
  c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const sections = results.map(r => {
  const caseData = cases.find(c => c.id === r.id);
  let imageBlock = '<p><b>No match proposed.</b></p>';
  if (r.match) {
    const fixture = loadFixture(r.pdf);
    const pageInfo = fixture.pages[r.match.page - 1];
    const pw = pageInfo.viewport.width;
    const ph = pageInfo.viewport.height;
    const { bbox } = r.match;
    // PDF units (y up) -> percentages of the page image (y down)
    const leftPct = (100 * bbox.x0 / pw).toFixed(2);
    const topPct = (100 * (ph - bbox.y1) / ph).toFixed(2);
    const widthPct = (100 * (bbox.x1 - bbox.x0) / pw).toFixed(2);
    const heightPct = (100 * (bbox.y1 - bbox.y0) / ph).toFixed(2);
    imageBlock = `
      <div style="position:relative; display:inline-block; max-width:100%;">
        <img src="pages/${esc(r.pdf)}/page-${r.match.page}.png" style="max-width:100%; display:block;">
        <div class="box" style="left:${leftPct}%; top:${topPct}%; width:${widthPct}%; height:${heightPct}%;"></div>
      </div>`;
  }
  const candidateRows = r.candidates.map(c =>
    `<tr><td>${c.page}</td><td>${c.score}</td><td>${esc(c.text)}</td></tr>`).join('');
  return `
  <section class="${r.status}">
    <h2>${esc(r.id)} <span class="status">[${r.status}]</span></h2>
    <p><b>Score:</b> ${r.match ? r.match.score.toFixed(3) : '—'}
       <b>Page:</b> ${r.match ? r.match.page : '—'}
       ${r.goldIou !== null ? `<b>IoU vs gold:</b> ${r.goldIou.toFixed(2)}` : ''}</p>
    <p><b>Query:</b> ${esc(caseData.queryText)}</p>
    <p><b>Matched:</b> ${r.match ? esc(r.match.matchedText) : '—'}</p>
    ${imageBlock}
    <details><summary>Top candidates</summary>
      <table><tr><th>Page</th><th>Score</th><th>Text</th></tr>${candidateRows}</table>
    </details>
    <p class="confirm">accept: <code>node tests/pdf-match/confirm.js --accept ${esc(r.id)}</code></p>
  </section>`;
}).join('\n');

const counts = {
  pass: results.filter(r => r.status === 'pass').length,
  fail: results.filter(r => r.status === 'fail').length,
  rejected: results.filter(r => r.status === 'rejected').length,
  unreviewed: results.filter(r => r.status === 'unreviewed').length
};

const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>pdf-match report</title>
<style>
  body { font-family: sans-serif; margin: 2em; max-width: 1100px; }
  section { border: 1px solid #ccc; margin-bottom: 2em; padding: 1em; }
  section.pass { border-left: 6px solid #2a2; }
  section.fail { border-left: 6px solid #c22; }
  section.rejected { border-left: 6px solid #888; }
  section.unreviewed { border-left: 6px solid #f90; }
  .box { position: absolute; border: 3px solid red; background: rgba(255,0,0,0.15); }
  table { border-collapse: collapse; }
  td, th { border: 1px solid #ccc; padding: 2px 8px; text-align: left; }
</style></head><body>
<h1>pdf-match report — ${new Date().toISOString()}</h1>
<p>${results.length} cases: ${counts.pass} pass, ${counts.fail} fail, ${counts.rejected} rejected, ${counts.unreviewed} unreviewed</p>
${sections}
</body></html>`;

fs.writeFileSync(REPORT_PATH, html);
console.log(`\n${results.length} cases: ${counts.pass} pass, ${counts.fail} fail, ${counts.rejected} rejected, ${counts.unreviewed} unreviewed`);
console.log(`report: file://${REPORT_PATH}`);
