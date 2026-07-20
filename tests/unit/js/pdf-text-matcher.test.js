/**
 * Tests for the pdf-text-matcher module.
 * Run with: node tests/unit-test-runner.js tests/unit/js/pdf-text-matcher.test.js
 *
 * @testCovers app/src/modules/pdf-text-matcher.js
 */

import { describe, test } from 'node:test';
import assert from 'node:assert';
import {
  foldChar,
  normalizeQuery,
  buildPageModel,
  findCandidateOffsets,
  alignQueryToWindow,
  findBestMatch,
  computeBBox
} from '../../../app/src/modules/pdf-text-matcher.js';

describe('foldChar', () => {
  test('lowercases and strips accents', () => {
    assert.strictEqual(foldChar('É'), 'e');
    assert.strictEqual(foldChar('ü'), 'u');
  });

  test('expands compatibility ligatures', () => {
    assert.strictEqual(foldChar('ﬁ'), 'fi');
  });

  test('maps special letters without NFKD decompositions', () => {
    assert.strictEqual(foldChar('ß'), 'ss');
    assert.strictEqual(foldChar('Œ'), 'oe');
  });

  test('maps typographic quotes and dashes to ASCII', () => {
    assert.strictEqual(foldChar('„'), '"');
    assert.strictEqual(foldChar('“'), '"');
    assert.strictEqual(foldChar('’'), "'");
    assert.strictEqual(foldChar('–'), '-');
    assert.strictEqual(foldChar('—'), '-');
  });

  test('removes soft hyphens', () => {
    assert.strictEqual(foldChar('­'), '');
  });
});

describe('normalizeQuery', () => {
  test('collapses whitespace and trims', () => {
    assert.strictEqual(normalizeQuery('  Foo\n\t Bar  '), 'foo bar');
  });

  test('applies character folding', () => {
    assert.strictEqual(normalizeQuery('Straße — „Test“'), 'strasse - "test"');
  });

  test('returns empty string for whitespace-only input', () => {
    assert.strictEqual(normalizeQuery('  \n '), '');
  });
});

/**
 * Creates a synthetic PDF.js text item. PDF coordinates: origin bottom-left,
 * y axis points up; transform[4] = x, transform[5] = y (baseline).
 * @param {string} str
 * @param {number} x
 * @param {number} y
 * @param {number} [width]
 * @param {number} [height]
 * @returns {{str: string, transform: number[], width: number, height: number}}
 */
function item(str, x, y, width = str.length * 5, height = 10) {
  return { str, transform: [1, 0, 0, 1, x, y], width, height };
}

describe('buildPageModel', () => {
  test('orders items on one line by x and inserts geometric spaces', () => {
    const model = buildPageModel([item('world', 60, 700), item('Hello', 10, 700, 25)], 1);
    assert.strictEqual(model.text, 'hello world');
  });

  test('joins fragmented items without intervening gap (OCR splits)', () => {
    // "Gian" ends at x=30, "na" starts at x=30: no gap, no space
    const model = buildPageModel([item('Gian', 10, 700, 20), item('na', 30, 700)], 1);
    assert.strictEqual(model.text, 'gianna');
  });

  test('orders lines top-down (PDF y axis points up)', () => {
    const model = buildPageModel([item('second', 10, 680), item('first', 10, 700)], 1);
    assert.strictEqual(model.text, 'first second');
  });

  test('dehyphenates line breaks when next line starts lowercase', () => {
    const model = buildPageModel([item('exam-', 10, 700), item('ple text', 10, 688)], 1);
    assert.strictEqual(model.text, 'example text');
  });

  test('keeps hyphen for hyphenated compounds broken at the hyphen', () => {
    const model = buildPageModel(
      [item('Müller-', 10, 700), item('Lüdenscheidt', 10, 688)], 1);
    assert.strictEqual(model.text, 'muller-ludenscheidt');
  });

  test('maps text positions back to source items', () => {
    const items = [item('Hello', 10, 700, 25), item('world', 60, 700)];
    const model = buildPageModel(items, 1);
    const pos = model.text.indexOf('world');
    assert.strictEqual(model.charToItem[pos], 1);
    assert.strictEqual(model.charToItem[0], 0);
  });

  test('two-column layout: left column stream precedes right column', () => {
    const items = [
      item('R1', 300, 700), item('R2', 300, 688),
      item('L1', 10, 700), item('L2', 10, 688)
    ];
    const model = buildPageModel(items, 1);
    assert.strictEqual(model.text, 'l1 l2 r1 r2');
  });

  test('empty page yields empty model', () => {
    const model = buildPageModel([], 3);
    assert.strictEqual(model.text, '');
    assert.strictEqual(model.page, 3);
    assert.deepStrictEqual(model.charToItem, []);
  });
});

describe('findCandidateOffsets', () => {
  test('finds the offset of a verbatim substring', () => {
    const pageText = 'lorem ipsum dolor sit amet consectetur adipiscing elit';
    const offsets = findCandidateOffsets(pageText, 'dolor sit amet');
    assert.ok(offsets.length > 0, 'expected at least one candidate');
    // True offset is 12; bucket rounding may shift it by up to one bucket
    assert.ok(Math.abs(offsets[0] - 12) <= 14, `offset ${offsets[0]} too far from 12`);
  });

  test('returns empty array when nothing matches', () => {
    const offsets = findCandidateOffsets('lorem ipsum dolor', 'zzzz qqqq xxxx');
    assert.deepStrictEqual(offsets, []);
  });

  test('returns empty array for too-short inputs', () => {
    assert.deepStrictEqual(findCandidateOffsets('ab', 'abcd'), []);
    assert.deepStrictEqual(findCandidateOffsets('abcdef', 'ab'), []);
  });

  test('respects maxCandidates limit', () => {
    // A page with the query repeated many times at spread-out positions
    // produces multiple distinct diagonal buckets; cap the returned count.
    const unit = 'alpha bravo charlie delta ';
    const pageText = unit.repeat(6);
    const offsets = findCandidateOffsets(pageText, 'alpha bravo charlie', 2);
    assert.ok(offsets.length <= 2, `expected at most 2, got ${offsets.length}`);
  });

  test('ranks the strongest diagonal first', () => {
    // The query appears verbatim once; its true offset must be the top candidate.
    const pageText = 'aaaa bbbb the distinctive phrase here cccc dddd';
    const offsets = findCandidateOffsets(pageText, 'the distinctive phrase here');
    const trueOffset = pageText.indexOf('the distinctive phrase here');
    const bucketSize = Math.max(8, Math.round('the distinctive phrase here'.length * 0.1));
    assert.ok(Math.abs(offsets[0] - trueOffset) <= bucketSize,
      `top offset ${offsets[0]} not near true offset ${trueOffset}`);
  });

  test('skips non-distinctive grams that occur very often', () => {
    // A gram repeated >50 times must not dominate; a distinctive tail still
    // drives the match. "aaaa" occurs hundreds of times and is skipped.
    const pageText = 'a'.repeat(200) + ' zebra quokka mongoose';
    const offsets = findCandidateOffsets(pageText, 'zebra quokka mongoose');
    assert.ok(offsets.length > 0, 'expected a candidate from the distinctive tail');
    const trueOffset = pageText.indexOf('zebra');
    const bucketSize = Math.max(8, Math.round('zebra quokka mongoose'.length * 0.1));
    assert.ok(Math.abs(offsets[0] - trueOffset) <= bucketSize * 2,
      `top offset ${offsets[0]} not near ${trueOffset}`);
  });
});

describe('alignQueryToWindow', () => {
  test('finds exact substring with distance 0 and correct range', () => {
    const window = 'the quick brown fox jumps';
    const result = alignQueryToWindow('brown fox', window);
    assert.strictEqual(result.distance, 0);
    assert.strictEqual(window.slice(result.start, result.end), 'brown fox');
  });

  test('tolerates a substitution', () => {
    const result = alignQueryToWindow('brawn fox', 'the quick brown fox jumps');
    assert.strictEqual(result.distance, 1);
  });

  test('tolerates missing and extra characters', () => {
    // query has an extra "x", window text has "colour" vs query "color"
    const result = alignQueryToWindow('colorx', 'they colour it');
    assert.ok(result.distance <= 2, `distance ${result.distance} > 2`);
  });

  test('aligns query against full window when window is junk', () => {
    const result = alignQueryToWindow('abc', 'zzzzz');
    assert.strictEqual(result.distance, 3);
  });
});

describe('findBestMatch', () => {
  /** Builds two synthetic pages; the reference sits on page 2, line 2. */
  function makePageModels() {
    const page1 = buildPageModel([
      item('Introduction to the general theory', 10, 700),
      item('of legal argumentation and discourse', 10, 688)
    ], 1);
    const page2 = buildPageModel([
      item('References', 10, 700),
      item('Alexy, Robert: Theorie der juristischen', 10, 688),
      item('Argumentation, Suhrkamp, Frankfurt 1983.', 10, 676),
      item('Luhmann, Niklas: Das Recht der Gesellschaft,', 10, 664),
      item('Suhrkamp, Frankfurt 1993.', 10, 652)
    ], 2);
    return [page1, page2];
  }

  test('locates a near-verbatim entry on the right page', () => {
    const models = makePageModels();
    const { match } = findBestMatch(models,
      'Alexy, Robert: Theorie der juristischen Argumentation, Suhrkamp, Frankfurt 1983.');
    assert.ok(match, 'expected a match');
    assert.strictEqual(match.page, 2);
    assert.ok(match.score > 0.9, `score ${match.score} <= 0.9`);
    // items 1 and 2 of page 2 hold the entry
    assert.deepStrictEqual(match.itemIndices, [1, 2]);
  });

  test('tolerates small differences (typos, punctuation)', () => {
    const models = makePageModels();
    const { match } = findBestMatch(models,
      'Alexy Robert, Theorie der juristischen Argumentation. Suhrkamp Frankfurt 1983');
    assert.ok(match, 'expected a match');
    assert.strictEqual(match.page, 2);
    assert.ok(match.score > 0.8, `score ${match.score} <= 0.8`);
  });

  test('returns null match but candidates for below-threshold queries', () => {
    const models = makePageModels();
    const result = findBestMatch(models, 'completely unrelated gibberish zzzz');
    assert.strictEqual(result.match, null);
    assert.ok(Array.isArray(result.candidates));
  });

  test('bbox covers the matched items in PDF units', () => {
    const models = makePageModels();
    const { match } = findBestMatch(models,
      'Luhmann, Niklas: Das Recht der Gesellschaft, Suhrkamp, Frankfurt 1993.');
    assert.ok(match);
    assert.strictEqual(match.page, 2);
    // items at y=664 and y=652, height 10: bbox spans y 652..674
    assert.ok(match.bbox.y0 <= 652 && match.bbox.y1 >= 664);
    assert.ok(match.bbox.x0 <= 10);
  });
});

describe('computeBBox', () => {
  test('computes the union box of the given items', () => {
    const items = [item('aa', 10, 100, 20, 10), item('bb', 50, 80, 30, 12)];
    const bbox = computeBBox(items, [0, 1]);
    assert.deepStrictEqual(bbox, { x0: 10, y0: 80, x1: 80, y1: 110 });
  });
});
