#!/usr/bin/env node

/**
 * Unit tests for the unit review core module and its SHA-256 helper.
 * @testCovers app/src/modules/unit-review.js
 * @testCovers app/src/modules/sha256.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createHash } from 'node:crypto';
import { JSDOM } from 'jsdom';
import { EditorState } from '@codemirror/state';
import { xml } from '@codemirror/lang-xml';
import { sha256Hex } from '../../../app/src/modules/sha256.js';
import {
  parseUnitPath, findUnits, readReviewData, serializeReviewData, combineReviews, setMark,
  reconcileReviewData, removeUnitReviews, parseSummary, emptyReviewData, LIST_TYPE
} from '../../../app/src/modules/unit-review.js';

const REFS = `<TEI xmlns="http://www.tei-c.org/ns/1.0">
  <teiHeader/>
  <text>
    <listBibl>
      <bibl>Poid.<lb/> </bibl>
      <bibl><label>8</label><lb/> See Jain JP</bibl>
      <bibl>Poid.<lb/> </bibl>
    </listBibl>
  </text>
</TEI>`;

/**
 * @param {string} doc
 * @returns {EditorState}
 */
function makeState(doc) {
  return EditorState.create({ doc, extensions: [xml()] });
}

/**
 * @param {string} xmlString
 * @returns {Document}
 */
function parseXml(xmlString) {
  return new JSDOM(xmlString, { contentType: 'application/xml' }).window.document;
}

describe('sha256Hex', () => {
  it('matches node:crypto', () => {
    for (const s of ['', 'abc', 'ä€😀', 'a'.repeat(55), 'a'.repeat(56), 'x'.repeat(1000)]) {
      assert.strictEqual(sha256Hex(s), createHash('sha256').update(s).digest('hex'));
    }
  });
});

describe('parseUnitPath', () => {
  it('parses child and descendant steps', () => {
    assert.deepStrictEqual(parseUnitPath('.//listBibl/bibl'), [
      { descendant: true, name: 'listBibl' }, { descendant: false, name: 'bibl' }
    ]);
    assert.deepStrictEqual(parseUnitPath('./*'), [{ descendant: false, name: '*' }]);
    assert.deepStrictEqual(parseUnitPath('tei:listBibl/tei:bibl'), [
      { descendant: false, name: 'listBibl' }, { descendant: false, name: 'bibl' }
    ]);
  });

  it('returns null for the automatic default', () => {
    assert.strictEqual(parseUnitPath('auto'), null);
    assert.strictEqual(parseUnitPath(null), null);
  });

  it('rejects invalid paths', () => {
    assert.throws(() => parseUnitPath('.//bibl[1]'));
  });
});

describe('findUnits', () => {
  it('finds units by path and numbers identical ones', () => {
    const { units, looseText } = findUnits(makeState(REFS), './/listBibl/bibl');
    assert.strictEqual(units.length, 3);
    assert.ok(/^[0-9a-f]{8}$/.test(units[0].fingerprint));
    assert.strictEqual(units[2].fingerprint, units[0].fingerprint + '.2');
    assert.notStrictEqual(units[1].fingerprint, units[0].fingerprint);
    assert.strictEqual(looseText.length, 0);
  });

  it('finds the same units automatically by stepping down through single children', () => {
    const autoScan = findUnits(makeState(REFS), null);
    const byPath = findUnits(makeState(REFS), './/listBibl/bibl').units.map(u => u.fingerprint);
    assert.deepStrictEqual(autoScan.units.map(u => u.fingerprint), byPath);
    // the path the heuristic resolved to finds the same units
    assert.strictEqual(autoScan.path, './listBibl/*');
    assert.deepStrictEqual(findUnits(makeState(REFS), autoScan.path).units.map(u => u.fingerprint), byPath);
  });

  it('ignores re-indentation but not changes to text or attributes', () => {
    const base = findUnits(makeState(REFS), null).units[1].fingerprint;
    const reindented = REFS.replace('<bibl><label>8</label><lb/> See Jain JP</bibl>',
      '<bibl>\n        <label>8</label>\n        <lb/> See   Jain JP\n      </bibl>');
    assert.strictEqual(findUnits(makeState(reindented), null).units[1].fingerprint, base);
    const edited = REFS.replace('Jain JP', 'Jain J.P.');
    assert.notStrictEqual(findUnits(makeState(edited), null).units[1].fingerprint, base);
    const attr = REFS.replace('<label>8</label>', '<label type="x">8</label>');
    assert.notStrictEqual(findUnits(makeState(attr), null).units[1].fingerprint, base);
  });

  it('reports text outside units', () => {
    const doc = REFS.replace('</listBibl>', '</listBibl> loose');
    const { looseText } = findUnits(makeState(doc), './/listBibl/bibl');
    assert.strictEqual(looseText.length, 1);
  });

  it('returns no units without a <text> element', () => {
    assert.deepStrictEqual(findUnits(makeState('<TEI><teiHeader/></TEI>'), null).units, []);
  });
});

describe('review data in TEI', () => {
  it('round-trips through serialization and parsing', () => {
    const data = emptyReviewData('.//listBibl/bibl');
    setMark(data, { id: 'cb' }, 'aaaaaaaa', 'ok', { when: '2026-10-23T00:00:00Z' });
    setMark(data, { id: 'cb' }, 'bbbbbbbb', 'not-ok', { comment: 'Label & <b>', when: '2026-10-23T00:00:00Z' });
    setMark(data, { id: 'llm-kisski-llama', name: 'KISSKI / Llama', isLlm: true }, 'aaaaaaaa', 'not-ok', { comment: 'x', when: '2026-10-23T00:00:00Z' });
    const summary = { units: 2, ok: 1, notOk: 1, disputed: 0, open: 0 };
    const xmlString = serializeReviewData(data, summary, '');
    const doc = parseXml(`<standOff xmlns="http://www.tei-c.org/ns/1.0">${xmlString}</standOff>`);
    const list = /** @type {Element} */ (doc.documentElement.firstElementChild);
    assert.strictEqual(list.getAttribute('type'), LIST_TYPE);
    const read = readReviewData(list);
    assert.strictEqual(read.unitPath, './/listBibl/bibl');
    const cb = read.reviewers.get('cb');
    assert.ok(cb);
    assert.deepStrictEqual(cb.marks.get('aaaaaaaa'), { state: 'ok', comment: '', final: false });
    assert.deepStrictEqual(cb.marks.get('bbbbbbbb'), { state: 'not-ok', comment: 'Label & <b>', final: false });
    const llm = read.reviewers.get('llm-kisski-llama');
    assert.ok(llm?.isLlm);
    assert.strictEqual(llm?.name, 'KISSKI / Llama');
    assert.match(xmlString, /<note type="summary">units=2 ok=1 not-ok=1 disputed=0 open=0<\/note>/);
  });

  it('removes the review list and an empty standOff', () => {
    const doc = parseXml(`<TEI xmlns="http://www.tei-c.org/ns/1.0"><teiHeader/>
  <standOff><listAnnotation type="unit-review"/></standOff><text/></TEI>`);
    assert.strictEqual(removeUnitReviews(doc), true);
    assert.strictEqual(doc.getElementsByTagNameNS('*', 'standOff').length, 0);
  });

  it('keeps other standOff content', () => {
    const doc = parseXml(`<TEI xmlns="http://www.tei-c.org/ns/1.0"><standOff><listAnnotation type="unit-review"/><listPlace/></standOff></TEI>`);
    removeUnitReviews(doc);
    assert.strictEqual(doc.getElementsByTagNameNS('*', 'listPlace').length, 1);
  });

  it('parses the summary note', () => {
    assert.deepStrictEqual(parseSummary('units=5 ok=2 not-ok=1 disputed=1 open=1'),
      { units: 5, ok: 2, notOk: 1, disputed: 1, open: 1 });
    assert.strictEqual(parseSummary('nothing'), null);
  });
});

describe('combineReviews', () => {
  const units = [{ fingerprint: 'u1', from: 0, to: 1, name: 'bibl' }];

  it('decides by majority and reports ties as disputed', () => {
    const data = emptyReviewData();
    setMark(data, { id: 'a' }, 'u1', 'ok');
    setMark(data, { id: 'b' }, 'u1', 'not-ok');
    assert.strictEqual(combineReviews(units, data, { mode: 'majority', llmVote: true }).byFingerprint.get('u1')?.state, 'disputed');
    setMark(data, { id: 'c' }, 'u1', 'not-ok');
    const { byFingerprint, summary } = combineReviews(units, data, { mode: 'majority', llmVote: true });
    assert.strictEqual(byFingerprint.get('u1')?.state, 'not-ok');
    assert.strictEqual(summary.notOk, 1);
  });

  it('lets a final review override the votes in final mode only', () => {
    const data = emptyReviewData();
    setMark(data, { id: 'a' }, 'u1', 'not-ok');
    setMark(data, { id: 'b' }, 'u1', 'not-ok');
    setMark(data, { id: 'c' }, 'u1', 'ok', { final: true });
    assert.strictEqual(combineReviews(units, data, { mode: 'final', llmVote: true }).byFingerprint.get('u1')?.state, 'ok');
    assert.strictEqual(combineReviews(units, data, { mode: 'majority', llmVote: true }).byFingerprint.get('u1')?.state, 'not-ok');
    // a second final review replaces the first
    setMark(data, { id: 'a' }, 'u1', 'not-ok', { final: true });
    assert.strictEqual(data.reviewers.get('c')?.marks.get('u1')?.final, false);
    assert.strictEqual(combineReviews(units, data, { mode: 'final', llmVote: true }).byFingerprint.get('u1')?.state, 'not-ok');
  });

  it('uses advisory LLM marks only when no person has reviewed', () => {
    const data = emptyReviewData();
    setMark(data, { id: 'llm-x', isLlm: true }, 'u1', 'not-ok');
    const options = /** @type {const} */ ({ mode: 'majority', llmVote: false });
    assert.strictEqual(combineReviews(units, data, options).byFingerprint.get('u1')?.state, 'not-ok');
    setMark(data, { id: 'a' }, 'u1', 'ok');
    assert.strictEqual(combineReviews(units, data, options).byFingerprint.get('u1')?.state, 'ok');
    assert.strictEqual(combineReviews(units, data, { mode: 'majority', llmVote: true }).byFingerprint.get('u1')?.state, 'disputed');
  });
});

describe('reconcileReviewData', () => {
  it('carries marks of an edited unit over as was- marks and drops orphans', () => {
    const data = emptyReviewData();
    setMark(data, { id: 'a' }, 'old', 'not-ok', { comment: 'wrong label' });
    setMark(data, { id: 'a' }, 'gone', 'ok');
    const units = [{ fingerprint: 'new', from: 0, to: 1, name: 'bibl' }];
    const changed = reconcileReviewData(data, units, new Map([['new', 'old']]));
    assert.strictEqual(changed, true);
    const reviewer = data.reviewers.get('a');
    assert.deepStrictEqual(reviewer?.was.get('new'), { state: 'not-ok', comment: 'wrong label', final: false });
    // kept so that undoing the edit restores it
    assert.ok(reviewer?.marks.has('old'));
    assert.ok(!reviewer?.marks.has('gone'));
    const { byFingerprint } = combineReviews(units, data, { mode: 'majority', llmVote: true });
    assert.strictEqual(byFingerprint.get('new')?.state, 'stale');
  });

  it('removes was- marks once the unit is reviewed again', () => {
    const data = emptyReviewData();
    setMark(data, { id: 'a' }, 'old', 'not-ok');
    reconcileReviewData(data, [{ fingerprint: 'new', from: 0, to: 1, name: 'bibl' }], new Map([['new', 'old']]));
    setMark(data, { id: 'b' }, 'new', 'ok');
    assert.strictEqual(data.reviewers.get('a')?.was.size, 0);
  });
});
