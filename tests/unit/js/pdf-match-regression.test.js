/**
 * Regression suite for the PDF text matcher: runs the matcher against all
 * gold-confirmed pdf-match cases (real-PDF fixtures) and asserts page and
 * region correctness. Skips silently while no gold cases exist.
 *
 * Workflow to add gold cases: see tests/pdf-match/README.md
 * Run with: node tests/unit-test-runner.js tests/unit/js/pdf-match-regression.test.js
 */

import { describe, test } from 'node:test';
import assert from 'node:assert';
import { loadCases, runCase, iou } from '../../pdf-match/lib.js';

const MIN_IOU = 0.3;
// The production accept/reject cutoff (see pdf-text-matcher.js). Gold cases
// are run with the matcher's default threshold (0, i.e. "always return the
// best candidate") because this suite pins *region correctness*, per the
// design spec's success criteria (page accuracy, region hit rate) — not
// whether a case's score happens to clear the runtime bar. A case can be a
// confirmed-correct match with a low score (e.g. slr-003, ~0.58: right page,
// exact bbox, but scored below RUNTIME_THRESHOLD by the alignment metric);
// that is a real, accepted limitation, not a regression. How many gold cases
// would actually surface via Autosearch is tracked separately below.
const RUNTIME_THRESHOLD = 0.6;

const goldCases = loadCases().filter(c => c.expected);

// Compute all outcomes up front so the metrics block is complete even when
// individual assertions fail
const outcomes = goldCases.map(caseData => {
  const { match } = runCase(caseData);
  const pageOk = Boolean(match) && match.page === caseData.expected.page;
  const overlap = pageOk ? iou(match.bbox, caseData.expected.bbox) : 0;
  const clearsRuntimeThreshold = Boolean(match) && match.score >= RUNTIME_THRESHOLD;
  return { caseData, match, pageOk, overlap, regionOk: pageOk && overlap >= MIN_IOU, clearsRuntimeThreshold };
});

if (outcomes.length > 0) {
  const pageAcc = outcomes.filter(o => o.pageOk).length;
  const regionAcc = outcomes.filter(o => o.regionOk).length;
  const runtimeAcc = outcomes.filter(o => o.clearsRuntimeThreshold).length;
  const meanScore = outcomes.reduce((s, o) => s + (o.match ? o.match.score : 0), 0) / outcomes.length;
  console.log(
    `pdf-match metrics: page accuracy ${pageAcc}/${outcomes.length}, ` +
    `region hit rate ${regionAcc}/${outcomes.length}, mean score ${meanScore.toFixed(3)}, ` +
    `${runtimeAcc}/${outcomes.length} clear the runtime threshold (${RUNTIME_THRESHOLD})`
  );
}

describe('pdf-match regression (gold cases)', () => {
  test('gold case availability', (t) => {
    if (goldCases.length === 0) {
      t.skip('no gold cases confirmed yet');
    }
  });

  for (const o of outcomes) {
    test(`case ${o.caseData.id}`, () => {
      assert.ok(o.match, 'matcher found no candidate at all');
      assert.strictEqual(o.match.page, o.caseData.expected.page, 'wrong page');
      assert.ok(o.overlap >= MIN_IOU, `IoU ${o.overlap.toFixed(2)} < ${MIN_IOU}`);
    });
  }
});
