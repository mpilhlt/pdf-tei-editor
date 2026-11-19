#!/usr/bin/env node

/**
 * Reads the shared zone-lines fixture with the JS mirror and compares the lines, pieces and page
 * fingerprints with the expected digest that the Python test (`test_zone_lines.py`) writes and
 * compares with its own reading. Keeps both implementations in step.
 *
 * @testCovers app/src/modules/zone-lines.js
 * @import { ZonePage } from '../../../app/src/modules/zone-lines.js'
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { readZoneLines, pagesOf, OUTSIDE } from '../../../app/src/modules/zone-lines.js';

const FIXTURES = new URL('../fixtures/zone-lines/', import.meta.url);
const SAMPLE = readFileSync(new URL('segmentation-sample.tei.xml', FIXTURES), 'utf-8');
const LAYOUT = JSON.parse(readFileSync(new URL('segmentation-sample.layout.json', FIXTURES), 'utf-8'));
const SAMPLE_PB = readFileSync(new URL('segmentation-sample-pb.tei.xml', FIXTURES), 'utf-8');
const EXPECTED = JSON.parse(readFileSync(new URL('segmentation-sample.expected.json', FIXTURES), 'utf-8'));

describe('zone lines', () => {
  it('reads the shared fixture like the Python module', () => {
    const lines = readZoneLines(SAMPLE, LAYOUT.labels);
    const pages = pagesOf(lines, LAYOUT.pages);
    assert.deepStrictEqual({
      lines: lines.map(l => ({ pieces: l.pieces.map(p => [p.label, p.text]), emptyLabel: l.emptyLabel })),
      pages: pages.map(p => ({ number: p.number, firstLine: p.firstLine, endLine: p.endLine, fingerprint: p.fingerprint }))
    }, EXPECTED);
  });

  it('locates lines and pages in the document', () => {
    const lines = readZoneLines(SAMPLE, LAYOUT.labels);
    const pages = pagesOf(lines, LAYOUT.pages);
    const page3 = /** @type {ZonePage} */ (pages[2]);
    assert.strictEqual(SAMPLE.slice(page3.from, page3.from + 1), '2');
    assert.ok(SAMPLE.slice(page3.from, page3.to).endsWith('stray text outside <lb/>'));
    assert.strictEqual(lines[15]?.pieces[0]?.label, OUTSIDE);
  });

  it('reads <pb/> as markup without text', () => {
    const lines = readZoneLines(SAMPLE_PB, LAYOUT.labels);
    const pages = pagesOf(lines, LAYOUT.pages);
    assert.deepStrictEqual({
      lines: lines.map(l => ({ pieces: l.pieces.map(p => [p.label, p.text]), emptyLabel: l.emptyLabel })),
      pages: pages.map(p => ({ number: p.number, firstLine: p.firstLine, endLine: p.endLine, fingerprint: p.fingerprint }))
    }, EXPECTED);
    const between = SAMPLE.replace('<page>2</page>', '<pb n="3"/><page>2</page>');
    assert.strictEqual(readZoneLines(between, LAYOUT.labels)[10]?.pieces[0]?.label, 'page');
  });

  it('refuses markup other than zones, <lb/> and <pb/>', () => {
    assert.throws(() => readZoneLines(SAMPLE.replace('<body>1 Introduction', '<body><hi>1</hi> Introduction'), LAYOUT.labels));
    assert.throws(() => readZoneLines(SAMPLE.replace('<body>1 Introduction', '<body><pb>1</pb> Introduction'), LAYOUT.labels));
  });
});
