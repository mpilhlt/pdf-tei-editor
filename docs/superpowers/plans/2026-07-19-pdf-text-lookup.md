# PDF Text Lookup (Sequence Alignment) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the failing bag-of-words PDF text lookup with fuzzy sequence alignment against a reconstructed per-page text stream, plus an offline real-PDF test pipeline for iterative improvement.

**Architecture:** A new DOM-free module `app/src/modules/pdf-text-matcher.js` builds normalized reading-order text streams from PDF.js `getTextContent()` items (with a char-index → item-index map) and locates the best fuzzy match of the TEI node's ordered text via 4-gram seeding plus semi-global edit-distance alignment. The browser (`pdfviewer.js`) and a Node test pipeline (`tests/pdf-match/`) share this module. Spec: `docs/superpowers/specs/2026-07-19-pdf-text-lookup-design.md`.

**Tech Stack:** Vanilla ES modules, `node:test` + existing `tests/unit-test-runner.js`, `pdfjs-dist` 5.4.449 (already a dependency), `@napi-rs/canvas` (new devDependency, PNG rendering for review reports), `jsdom` (already a devDependency, TEI parsing in case generation).

**Conventions that apply throughout:**

- Run JS unit tests with `node tests/unit-test-runner.js <file>`; run everything with `npm run test:unit:js`.
- All JSDoc type imports use `@import` blocks at the top of the file — never inline `import()` in annotations.
- Commit after every task.

---

## Task 1: Matcher — character folding and query normalization

**Files:**

- Create: `app/src/modules/pdf-text-matcher.js`
- Create: `tests/unit/js/pdf-text-matcher.test.js`

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/js/pdf-text-matcher.test.js`:

```javascript
/**
 * Tests for the pdf-text-matcher module.
 * Run with: node tests/unit-test-runner.js tests/unit/js/pdf-text-matcher.test.js
 */

import { describe, test } from 'node:test';
import assert from 'node:assert';
import {
  foldChar,
  normalizeQuery
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
    assert.strictEqual(foldChar('„'), '"'); // „
    assert.strictEqual(foldChar('“'), '"'); // “
    assert.strictEqual(foldChar('’'), "'"); // ’
    assert.strictEqual(foldChar('–'), '-'); // – en dash
    assert.strictEqual(foldChar('—'), '-'); // — em dash
  });

  test('removes soft hyphens', () => {
    assert.strictEqual(foldChar('\u00AD'), '');
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node tests/unit-test-runner.js tests/unit/js/pdf-text-matcher.test.js`
Expected: FAIL — cannot find module `pdf-text-matcher.js`.

- [ ] **Step 3: Write the implementation**

Create `app/src/modules/pdf-text-matcher.js`:

```javascript
/**
 * PDF Text Matcher
 *
 * Locates the text of a TEI node inside a PDF via fuzzy sequence alignment.
 * DOM-free: operates on plain data extracted from PDF.js getTextContent(),
 * so the identical code runs in the browser and in Node (test pipeline).
 *
 * Pipeline:
 * 1. buildPageModel(): reconstruct a normalized reading-order text stream
 *    per page, with a char-index -> item-index map.
 * 2. findBestMatch(): locate the query in the streams via 4-gram seeding
 *    (findCandidateOffsets) + semi-global edit-distance alignment
 *    (alignQueryToWindow), then map the matched char range back to items
 *    and a PDF-unit bounding box.
 *
 * Design spec: docs/superpowers/specs/2026-07-19-pdf-text-lookup-design.md
 */

/**
 * Character-level replacements applied before NFKD folding. Covers
 * typographic variants and letters without NFKD decompositions, so that
 * TEI text and PDF text normalize identically.
 * @type {Record<string, string>}
 */
const CHAR_MAP = {
  '‘': "'", '’': "'", '‚': "'", '‛': "'",
  '“': '"', '”': '"', '„': '"',
  '«': '"', '»': '"', '‹': "'", '›': "'",
  '‐': '-', '‑': '-', '‒': '-', '–': '-', '—': '-', '―': '-',
  '\u00AD': '', // soft hyphen
  'ß': 'ss', 'ẞ': 'ss',
  'Œ': 'oe', 'œ': 'oe',
  'Æ': 'ae', 'æ': 'ae'
};

const COMBINING_MARK = /[\u0300-\u036f]/;

/**
 * Folds a single character: applies CHAR_MAP, then NFKD normalization,
 * strips combining marks, lowercases. May return zero, one, or several
 * characters (e.g. "ﬁ" -> "fi", "é" -> "e", soft hyphen -> "").
 * @param {string} ch - A single character
 * @returns {string} The folded character sequence
 */
export function foldChar(ch) {
  if (Object.prototype.hasOwnProperty.call(CHAR_MAP, ch)) {
    return CHAR_MAP[ch];
  }
  let out = '';
  for (const c of ch.normalize('NFKD')) {
    if (COMBINING_MARK.test(c)) continue;
    out += c.toLowerCase();
  }
  return out;
}

/**
 * Normalizes a query string: folds every character, collapses whitespace
 * runs to single spaces, trims. The page stream is normalized with the
 * same folding, guaranteeing symmetric comparison.
 * @param {string} s - Raw query text
 * @returns {string} Normalized query
 */
export function normalizeQuery(s) {
  let out = '';
  let pendingSpace = false;
  for (const ch of s) {
    for (const c of foldChar(ch)) {
      if (/\s/.test(c)) {
        if (out.length > 0) pendingSpace = true;
        continue;
      }
      if (pendingSpace) {
        out += ' ';
        pendingSpace = false;
      }
      out += c;
    }
  }
  return out;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node tests/unit-test-runner.js tests/unit/js/pdf-text-matcher.test.js`
Expected: PASS (all foldChar/normalizeQuery tests).

- [ ] **Step 5: Commit**

```bash
git add app/src/modules/pdf-text-matcher.js tests/unit/js/pdf-text-matcher.test.js
git commit -m "feat: pdf-text-matcher character folding and query normalization"
```

---

## Task 2: Matcher — page model (lines, columns, hyphenation, char map)

**Files:**

- Modify: `app/src/modules/pdf-text-matcher.js`
- Modify: `tests/unit/js/pdf-text-matcher.test.js`

- [ ] **Step 1: Write the failing tests**

Append to `tests/unit/js/pdf-text-matcher.test.js` (and add `buildPageModel` to the import list at the top):

```javascript
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node tests/unit-test-runner.js tests/unit/js/pdf-text-matcher.test.js`
Expected: FAIL — `buildPageModel` is not exported.

- [ ] **Step 3: Write the implementation**

Append to `app/src/modules/pdf-text-matcher.js`:

```javascript
/**
 * @typedef {Object} TextItem
 * @property {string} str - Text content of the item
 * @property {number[]} transform - PDF transform matrix [a, b, c, d, e, f]; e = x, f = y (baseline, y axis up)
 * @property {number} width - Width in PDF units
 * @property {number} height - Height in PDF units
 */

/**
 * @typedef {Object} PageModel
 * @property {number} page - 1-based page number
 * @property {string} text - Normalized reading-order text stream
 * @property {number[]} charToItem - For each char in text, the index of the source item in items
 * @property {TextItem[]} items - The original items (indices match charToItem values)
 */

/**
 * Builds a normalized reading-order text stream for one page.
 *
 * Steps: position items from their transforms; group them into lines by
 * y-proximity; split lines at a column gutter (a large gap bracketing the
 * horizontal midline); if enough lines split, emit left column before right
 * column; concatenate with geometric spacing (space only where a visual gap
 * exists) and dehyphenate line-end hyphens followed by a lowercase letter.
 *
 * Known v1 limitation: in two-column mode, a line present in only one
 * column is assigned to the left stream. Improve via the test pipeline if
 * gold cases fail on this.
 *
 * @param {TextItem[]} items - Items from PDF.js getTextContent().items
 * @param {number} page - 1-based page number
 * @returns {PageModel} The page model
 */
export function buildPageModel(items, page) {
  const positioned = items
    .map((item, index) => ({
      item,
      index,
      x: item.transform[4],
      y: item.transform[5],
      w: item.width || 0,
      h: item.height || 0
    }))
    .filter(p => p.item.str.trim().length > 0);

  if (positioned.length === 0) {
    return { page, text: '', charToItem: [], items };
  }

  const avgH = positioned.reduce((s, p) => s + (p.h || 10), 0) / positioned.length;
  const yTolerance = Math.max(2, avgH * 0.5);

  // Group into lines by y proximity (top-down: descending y)
  const sorted = [...positioned].sort((a, b) => b.y - a.y || a.x - b.x);
  /** @type {Array<{y: number, items: typeof positioned}>} */
  const yLines = [];
  let current = null;
  for (const p of sorted) {
    if (!current || Math.abs(p.y - current.y) > yTolerance) {
      current = { y: p.y, items: [p] };
      yLines.push(current);
    } else {
      current.items.push(p);
    }
  }
  for (const line of yLines) {
    line.items.sort((a, b) => a.x - b.x);
  }

  // Column detection: split lines at a wide gap that brackets the midline
  const minX = Math.min(...positioned.map(p => p.x));
  const maxX = Math.max(...positioned.map(p => p.x + p.w));
  const pageWidth = maxX - minX;
  const mid = minX + pageWidth / 2;
  const gutter = Math.max(18, pageWidth * 0.04);

  /** @type {Array<{y: number, items: typeof positioned, col: 'L'|'R'}>} */
  const segments = [];
  let splitCount = 0;
  for (const line of yLines) {
    let splitAt = -1;
    for (let i = 1; i < line.items.length; i++) {
      const prev = line.items[i - 1];
      const gapStart = prev.x + prev.w;
      const gapEnd = line.items[i].x;
      if (gapEnd - gapStart >= gutter && gapStart < mid && gapEnd > mid) {
        splitAt = i;
        break;
      }
    }
    if (splitAt > 0) {
      splitCount++;
      segments.push({ y: line.y, items: line.items.slice(0, splitAt), col: 'L' });
      segments.push({ y: line.y, items: line.items.slice(splitAt), col: 'R' });
    } else {
      segments.push({ y: line.y, items: line.items, col: 'L' });
    }
  }
  const twoColumn = splitCount >= yLines.length * 0.25;
  const orderedLines = twoColumn
    ? [...segments.filter(s => s.col === 'L'), ...segments.filter(s => s.col === 'R')]
    : segments;

  // Emit normalized stream with char -> item map
  let text = '';
  /** @type {number[]} */
  const charToItem = [];
  let pendingSpace = false;
  let lastItem = -1;

  /**
   * @param {string} c - A single folded character
   * @param {number} itemIndex
   */
  const emitChar = (c, itemIndex) => {
    if (/\s/.test(c)) {
      if (text.length > 0) pendingSpace = true;
      return;
    }
    if (pendingSpace) {
      text += ' ';
      charToItem.push(lastItem);
      pendingSpace = false;
    }
    text += c;
    charToItem.push(itemIndex);
    lastItem = itemIndex;
  };

  /**
   * Returns the first non-whitespace raw (unfolded) character of a line,
   * used to decide dehyphenation (requires original case information).
   * @param {{items: typeof positioned}} line
   * @returns {string}
   */
  const firstRawChar = (line) => {
    for (const p of line.items) {
      const m = p.item.str.match(/\S/);
      if (m) return m[0];
    }
    return '';
  };

  for (let li = 0; li < orderedLines.length; li++) {
    const line = orderedLines[li];
    for (let k = 0; k < line.items.length; k++) {
      const p = line.items[k];
      if (k > 0) {
        // Geometric spacing: only insert a space when a visual gap exists,
        // so items that fragment a word ("Gian" + "na") stay joined
        const prev = line.items[k - 1];
        const gap = p.x - (prev.x + prev.w);
        if (gap > avgH * 0.15 && text.length > 0) pendingSpace = true;
      }
      for (const ch of p.item.str) {
        for (const c of foldChar(ch)) emitChar(c, p.index);
      }
    }
    const next = orderedLines[li + 1];
    if (next && text.endsWith('-')) {
      // Line ends with a hyphen: join directly with the next line. Drop the
      // hyphen if the next line starts lowercase (line-break hyphenation);
      // keep it otherwise (hyphenated compound broken at the hyphen).
      if (/\p{Ll}/u.test(firstRawChar(next))) {
        text = text.slice(0, -1);
        charToItem.pop();
      }
      pendingSpace = false;
    } else if (text.length > 0) {
      pendingSpace = true;
    }
  }

  return { page, text, charToItem, items };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node tests/unit-test-runner.js tests/unit/js/pdf-text-matcher.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/src/modules/pdf-text-matcher.js tests/unit/js/pdf-text-matcher.test.js
git commit -m "feat: pdf-text-matcher page model with reading order and char map"
```

---

## Task 3: Matcher — 4-gram candidate seeding

**Files:**

- Modify: `app/src/modules/pdf-text-matcher.js`
- Modify: `tests/unit/js/pdf-text-matcher.test.js`

- [ ] **Step 1: Write the failing tests**

Append to the test file (add `findCandidateOffsets` to imports):

```javascript
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
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node tests/unit-test-runner.js tests/unit/js/pdf-text-matcher.test.js`
Expected: FAIL — `findCandidateOffsets` is not exported.

- [ ] **Step 3: Write the implementation**

Append to `app/src/modules/pdf-text-matcher.js`:

```javascript
/** Length of the character n-grams used for candidate seeding. */
const GRAM_SIZE = 4;

/**
 * Finds candidate match start offsets of the query in a page text stream.
 *
 * Indexes all 4-grams of the page text, then votes on alignment diagonals
 * (pagePosition - queryPosition) for every query 4-gram occurrence. Grams
 * occurring too often in the page are skipped as non-distinctive. The
 * highest-voted diagonal buckets become candidate offsets.
 *
 * @param {string} pageText - Normalized page stream
 * @param {string} query - Normalized query
 * @param {number} [maxCandidates=5] - Maximum offsets to return
 * @returns {number[]} Candidate start offsets in pageText, best first
 */
export function findCandidateOffsets(pageText, query, maxCandidates = 5) {
  if (pageText.length < GRAM_SIZE || query.length < GRAM_SIZE) return [];

  /** @type {Map<string, number[]>} */
  const gramPositions = new Map();
  for (let p = 0; p + GRAM_SIZE <= pageText.length; p++) {
    const gram = pageText.substring(p, p + GRAM_SIZE);
    let positions = gramPositions.get(gram);
    if (!positions) {
      positions = [];
      gramPositions.set(gram, positions);
    }
    positions.push(p);
  }

  const bucketSize = Math.max(8, Math.round(query.length * 0.1));
  /** @type {Map<number, number>} */
  const votes = new Map();
  for (let q = 0; q + GRAM_SIZE <= query.length; q += 2) {
    const positions = gramPositions.get(query.substring(q, q + GRAM_SIZE));
    if (!positions || positions.length > 50) continue;
    for (const p of positions) {
      const bucket = Math.round((p - q) / bucketSize);
      votes.set(bucket, (votes.get(bucket) || 0) + 1);
    }
  }

  return [...votes.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxCandidates)
    .map(([bucket]) => Math.max(0, bucket * bucketSize));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node tests/unit-test-runner.js tests/unit/js/pdf-text-matcher.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/src/modules/pdf-text-matcher.js tests/unit/js/pdf-text-matcher.test.js
git commit -m "feat: pdf-text-matcher 4-gram candidate seeding"
```

---

## Task 4: Matcher — semi-global alignment

**Files:**

- Modify: `app/src/modules/pdf-text-matcher.js`
- Modify: `tests/unit/js/pdf-text-matcher.test.js`

- [ ] **Step 1: Write the failing tests**

Append to the test file (add `alignQueryToWindow` to imports):

```javascript
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node tests/unit-test-runner.js tests/unit/js/pdf-text-matcher.test.js`
Expected: FAIL — `alignQueryToWindow` is not exported.

- [ ] **Step 3: Write the implementation**

Append to `app/src/modules/pdf-text-matcher.js`:

```javascript
/**
 * Aligns the full query against a window of page text with free start and
 * end positions in the window (semi-global alignment). Unit costs for
 * substitution, insertion, and deletion.
 *
 * O(query.length * window.length) time, O(window.length) memory. Callers
 * keep windows small (query length + padding), so this stays fast.
 *
 * @param {string} query - Normalized query (fully aligned)
 * @param {string} window - Normalized page text window (substring match)
 * @returns {{distance: number, start: number, end: number}} Minimum edit
 *   distance and the matched character range [start, end) in the window
 */
export function alignQueryToWindow(query, window) {
  const m = query.length;
  const n = window.length;

  // dp row over window positions; matchStart tracks where the alignment
  // began in the window so the range can be recovered without a traceback
  let prev = new Array(n + 1).fill(0);
  let prevStart = Array.from({ length: n + 1 }, (_, j) => j);

  for (let i = 1; i <= m; i++) {
    const cur = new Array(n + 1);
    const curStart = new Array(n + 1);
    cur[0] = i;
    curStart[0] = 0;
    for (let j = 1; j <= n; j++) {
      const substitution = prev[j - 1] + (query[i - 1] === window[j - 1] ? 0 : 1);
      const deletion = prev[j] + 1; // skip a query char
      const insertion = cur[j - 1] + 1; // skip a window char
      let best = substitution;
      let start = prevStart[j - 1];
      if (deletion < best) {
        best = deletion;
        start = prevStart[j];
      }
      if (insertion < best) {
        best = insertion;
        start = curStart[j - 1];
      }
      cur[j] = best;
      curStart[j] = start;
    }
    prev = cur;
    prevStart = curStart;
  }

  let bestJ = 0;
  let bestDist = Infinity;
  for (let j = 0; j <= n; j++) {
    if (prev[j] < bestDist) {
      bestDist = prev[j];
      bestJ = j;
    }
  }
  return { distance: bestDist, start: prevStart[bestJ], end: bestJ };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node tests/unit-test-runner.js tests/unit/js/pdf-text-matcher.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/src/modules/pdf-text-matcher.js tests/unit/js/pdf-text-matcher.test.js
git commit -m "feat: pdf-text-matcher semi-global alignment"
```

---

## Task 5: Matcher — findBestMatch, item mapping, bounding box

**Files:**

- Modify: `app/src/modules/pdf-text-matcher.js`
- Modify: `tests/unit/js/pdf-text-matcher.test.js`

- [ ] **Step 1: Write the failing tests**

Append to the test file (add `findBestMatch`, `computeBBox` to imports):

```javascript
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node tests/unit-test-runner.js tests/unit/js/pdf-text-matcher.test.js`
Expected: FAIL — `findBestMatch` is not exported.

- [ ] **Step 3: Write the implementation**

Append to `app/src/modules/pdf-text-matcher.js`:

```javascript
/**
 * @typedef {Object} MatchResult
 * @property {number} page - 1-based page number of the match
 * @property {number} score - Similarity in [0, 1]: 1 - editDistance / queryLength
 * @property {number[]} charRange - [start, end) range in the page model's text
 * @property {number[]} itemIndices - Indices into the page model's items
 * @property {{x0: number, y0: number, x1: number, y1: number}} bbox - PDF user-space units (y axis up)
 * @property {string} matchedText - The matched slice of the page stream
 */

/**
 * @typedef {Object} CandidateSummary
 * @property {number} page
 * @property {number} score
 * @property {string} text - First 120 chars of the candidate window
 */

/**
 * Computes the union bounding box of the given items in PDF user-space
 * units (y axis up). Item boxes are approximated as
 * [x, y, x + width, y + height] from the baseline.
 * @param {TextItem[]} items - All page items
 * @param {number[]} itemIndices - Indices of the items to include
 * @returns {{x0: number, y0: number, x1: number, y1: number}}
 */
export function computeBBox(items, itemIndices) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const i of itemIndices) {
    const it = items[i];
    const x = it.transform[4];
    const y = it.transform[5];
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x + (it.width || 0));
    y1 = Math.max(y1, y + (it.height || 0));
  }
  return { x0, y0, x1, y1 };
}

/**
 * Maps a character range of a page model's text back to the indices of the
 * source items, in ascending order.
 * @param {PageModel} model
 * @param {number[]} charRange - [start, end)
 * @returns {number[]} Sorted unique item indices
 */
export function itemIndicesForRange(model, charRange) {
  const [start, end] = charRange;
  const set = new Set();
  for (let i = start; i < end && i < model.charToItem.length; i++) {
    const idx = model.charToItem[i];
    if (idx >= 0) set.add(idx);
  }
  return [...set].sort((a, b) => a - b);
}

/**
 * Finds the region across all pages that best matches the query text.
 *
 * For every page, candidate offsets from 4-gram seeding are refined with
 * semi-global alignment inside a padded window. The best-scoring candidate
 * wins; page selection falls out of the global comparison. Queries longer
 * than maxQueryLength are truncated — matching the start of an entry is
 * sufficient to locate its region.
 *
 * @param {PageModel[]} pageModels - Models from buildPageModel(), one per page
 * @param {string} rawQuery - Ordered node text (un-normalized)
 * @param {Object} [options={}]
 * @param {number} [options.threshold=0.6] - Minimum score for a match
 * @param {number} [options.maxCandidatesPerPage=5]
 * @param {number} [options.maxQueryLength=600]
 * @returns {{match: MatchResult|null, candidates: CandidateSummary[]}} The
 *   accepted match (or null) plus the top 5 candidates for diagnostics
 */
export function findBestMatch(pageModels, rawQuery, options = {}) {
  const { threshold = 0.6, maxCandidatesPerPage = 5, maxQueryLength = 600 } = options;

  const query = normalizeQuery(rawQuery).slice(0, maxQueryLength);
  if (query.length === 0) return { match: null, candidates: [] };

  const pad = Math.max(10, Math.ceil(query.length * 0.15));
  const scored = [];

  for (const model of pageModels) {
    if (!model.text) continue;
    for (const offset of findCandidateOffsets(model.text, query, maxCandidatesPerPage)) {
      const winStart = Math.max(0, offset - pad);
      const winEnd = Math.min(model.text.length, offset + query.length + pad);
      const aligned = alignQueryToWindow(query, model.text.slice(winStart, winEnd));
      scored.push({
        model,
        page: model.page,
        score: 1 - aligned.distance / query.length,
        charRange: [winStart + aligned.start, winStart + aligned.end]
      });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  const candidates = scored.slice(0, 5).map(c => ({
    page: c.page,
    score: Number(c.score.toFixed(3)),
    text: c.model.text.slice(c.charRange[0], c.charRange[1]).slice(0, 120)
  }));

  const best = scored[0];
  if (!best || best.score < threshold) {
    return { match: null, candidates };
  }

  const itemIndices = itemIndicesForRange(best.model, best.charRange);
  return {
    match: {
      page: best.page,
      score: best.score,
      charRange: best.charRange,
      itemIndices,
      bbox: computeBBox(best.model.items, itemIndices),
      matchedText: best.model.text.slice(best.charRange[0], best.charRange[1])
    },
    candidates
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node tests/unit-test-runner.js tests/unit/js/pdf-text-matcher.test.js`
Expected: PASS (all matcher tests).

- [ ] **Step 5: Commit**

```bash
git add app/src/modules/pdf-text-matcher.js tests/unit/js/pdf-text-matcher.test.js
git commit -m "feat: pdf-text-matcher findBestMatch with item mapping and bbox"
```

---

## Task 6: Pipeline — scaffolding and fixture extraction

**Files:**

- Modify: `package.json` (devDependency)
- Modify: `.gitignore`
- Create: `tests/pdf-match/extract-fixtures.js`

- [ ] **Step 1: Install the rendering dependency**

Run: `npm install --save-dev @napi-rs/canvas`
Expected: package.json devDependencies gains `@napi-rs/canvas`. (`pdfjs-dist` 5.4.449 is already a runtime dependency — do NOT add another copy.)

- [ ] **Step 2: Add gitignore entries**

Append to `.gitignore`:

```text
# pdf-match test pipeline: generated review artifacts (fixtures and cases ARE committed)
tests/pdf-match/pages/
tests/pdf-match/results.json
tests/pdf-match/report.html
```

- [ ] **Step 3: Write the extraction script**

Create `tests/pdf-match/extract-fixtures.js`:

```javascript
#!/usr/bin/env node
/**
 * Extracts PDF.js text content items (and optionally page PNGs) from a PDF
 * into JSON fixtures for the pdf-match test pipeline.
 *
 * Usage:
 *   node tests/pdf-match/extract-fixtures.js --pdf <path> --id <docid> [--render]
 *
 * Writes tests/pdf-match/fixtures/<docid>.items.json (committed) and, with
 * --render, tests/pdf-match/pages/<docid>/page-N.png (gitignored).
 */

import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

const baseDir = path.dirname(fileURLToPath(import.meta.url));

const { values } = parseArgs({
  options: {
    pdf: { type: 'string' },
    id: { type: 'string' },
    render: { type: 'boolean', default: false }
  }
});

if (!values.pdf || !values.id) {
  console.error('Usage: node tests/pdf-match/extract-fixtures.js --pdf <path> --id <docid> [--render]');
  process.exit(1);
}

const RENDER_SCALE = 2;
const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');

const data = new Uint8Array(fs.readFileSync(values.pdf));
const doc = await getDocument({
  data,
  standardFontDataUrl: path.join(baseDir, '../../node_modules/pdfjs-dist/standard_fonts/')
}).promise;

const fixture = {
  pdf: values.id,
  sourcePath: values.pdf,
  numPages: doc.numPages,
  pages: []
};
const pagesDir = path.join(baseDir, 'pages', values.id);

for (let p = 1; p <= doc.numPages; p++) {
  const page = await doc.getPage(p);
  const viewport = page.getViewport({ scale: 1 });
  const textContent = await page.getTextContent();
  fixture.pages.push({
    page: p,
    viewport: { width: viewport.width, height: viewport.height },
    items: textContent.items
      .filter(item => 'str' in item)
      .map(item => ({
        str: item.str,
        transform: item.transform,
        width: item.width,
        height: item.height
      }))
  });

  if (values.render) {
    const { createCanvas } = await import('@napi-rs/canvas');
    const renderViewport = page.getViewport({ scale: RENDER_SCALE });
    const canvas = createCanvas(renderViewport.width, renderViewport.height);
    const canvasContext = canvas.getContext('2d');
    await page.render({ canvasContext, viewport: renderViewport }).promise;
    fs.mkdirSync(pagesDir, { recursive: true });
    fs.writeFileSync(path.join(pagesDir, `page-${p}.png`), canvas.toBuffer('image/png'));
    console.log(`rendered page ${p}/${doc.numPages}`);
  }
}

const fixturesDir = path.join(baseDir, 'fixtures');
fs.mkdirSync(fixturesDir, { recursive: true });
const outPath = path.join(fixturesDir, `${values.id}.items.json`);
fs.writeFileSync(outPath, JSON.stringify(fixture));
console.log(`wrote ${outPath} (${doc.numPages} pages)`);
```

- [ ] **Step 4: Verify against a real PDF**

Run (any PDF from the local data store works for the smoke test):

```bash
PDF=$(find data/files -name "*.pdf" | head -1)
node tests/pdf-match/extract-fixtures.js --pdf "$PDF" --id smoke-test --render
node -e "
const f = JSON.parse(require('fs').readFileSync('tests/pdf-match/fixtures/smoke-test.items.json'));
console.log('pages:', f.numPages, 'items page 1:', f.pages[0].items.length);
if (f.pages[0].items.length === 0) process.exit(1);
"
ls tests/pdf-match/pages/smoke-test/ | head -3
```

Expected: fixture JSON with items, PNG files listed. Then remove the smoke artifacts:

```bash
rm tests/pdf-match/fixtures/smoke-test.items.json
rm -r tests/pdf-match/pages/smoke-test
```

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json .gitignore tests/pdf-match/extract-fixtures.js
git commit -m "feat: pdf-match fixture extraction script"
```

---

## Task 7: Pipeline — shared lib and case generation

**Files:**

- Create: `tests/pdf-match/lib.js`
- Create: `tests/pdf-match/generate-cases.js`

- [ ] **Step 1: Write the shared library**

Create `tests/pdf-match/lib.js`:

```javascript
/**
 * Shared helpers for the pdf-match test pipeline. Used by run-cases.js,
 * confirm.js, and the regression test.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPageModel, findBestMatch } from '../../app/src/modules/pdf-text-matcher.js';

const baseDir = path.dirname(fileURLToPath(import.meta.url));

export const FIXTURES_DIR = path.join(baseDir, 'fixtures');
export const CASES_DIR = path.join(baseDir, 'cases');
export const RESULTS_PATH = path.join(baseDir, 'results.json');
export const REPORT_PATH = path.join(baseDir, 'report.html');
/** Scale factor used by extract-fixtures.js when rendering page PNGs. */
export const RENDER_SCALE = 2;

const modelCache = new Map();

/**
 * Loads all case files, sorted by id.
 * @returns {Array<Object>} Parsed case objects
 */
export function loadCases() {
  if (!fs.existsSync(CASES_DIR)) return [];
  return fs.readdirSync(CASES_DIR)
    .filter(f => f.endsWith('.json'))
    .sort()
    .map(f => JSON.parse(fs.readFileSync(path.join(CASES_DIR, f), 'utf-8')));
}

/**
 * @param {string} id - Case id
 * @returns {string} Absolute path of the case file
 */
export function caseFilePath(id) {
  return path.join(CASES_DIR, `${id}.json`);
}

/**
 * @param {string} pdfId - Fixture document id
 * @returns {Object} Parsed fixture ({pdf, numPages, pages: [{page, viewport, items}]})
 */
export function loadFixture(pdfId) {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, `${pdfId}.items.json`), 'utf-8'));
}

/**
 * Builds (and caches) page models for a fixture document.
 * @param {string} pdfId - Fixture document id
 * @returns {Array<import('../../app/src/modules/pdf-text-matcher.js').PageModel>}
 */
export function getPageModels(pdfId) {
  if (!modelCache.has(pdfId)) {
    const fixture = loadFixture(pdfId);
    modelCache.set(pdfId, fixture.pages.map(p => buildPageModel(p.items, p.page)));
  }
  return modelCache.get(pdfId);
}

/**
 * Runs the matcher for one case. Uses threshold 0 by default so review
 * tooling always sees the best candidate; pass a real threshold for
 * regression assertions.
 * @param {Object} caseData - A case object from loadCases()
 * @param {Object} [options={}] - findBestMatch options
 * @returns {{match: Object|null, candidates: Array<Object>}}
 */
export function runCase(caseData, options = {}) {
  const models = getPageModels(caseData.pdf);
  return findBestMatch(models, caseData.queryText, { threshold: 0, ...options });
}

/**
 * Intersection-over-union of two PDF-unit bounding boxes.
 * @param {{x0: number, y0: number, x1: number, y1: number}} a
 * @param {{x0: number, y0: number, x1: number, y1: number}} b
 * @returns {number} IoU in [0, 1]
 */
export function iou(a, b) {
  const ix = Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0));
  const iy = Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));
  const inter = ix * iy;
  const areaA = (a.x1 - a.x0) * (a.y1 - a.y0);
  const areaB = (b.x1 - b.x0) * (b.y1 - b.y0);
  const union = areaA + areaB - inter;
  return union > 0 ? inter / union : 0;
}
```

- [ ] **Step 2: Write the case generator**

Create `tests/pdf-match/generate-cases.js`:

```javascript
#!/usr/bin/env node
/**
 * Generates match cases from a TEI file: one case per bibliography-entry
 * node, referencing a previously extracted PDF fixture.
 *
 * Usage:
 *   node tests/pdf-match/generate-cases.js --tei <path> --pdf-id <docid> \
 *     [--selector biblStruct,bibl] [--max 10]
 *
 * Cases are written to tests/pdf-match/cases/<docid>-NNN.json with
 * expected: null (unreviewed). The review workflow (run-cases.js +
 * confirm.js) fills in the gold expectation.
 */

import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const baseDir = path.dirname(fileURLToPath(import.meta.url));

const { values } = parseArgs({
  options: {
    tei: { type: 'string' },
    'pdf-id': { type: 'string' },
    selector: { type: 'string', default: 'biblStruct,bibl' },
    max: { type: 'string', default: '10' }
  }
});

if (!values.tei || !values['pdf-id']) {
  console.error('Usage: node tests/pdf-match/generate-cases.js --tei <path> --pdf-id <docid> [--selector biblStruct,bibl] [--max 10]');
  process.exit(1);
}

/**
 * Builds a simple positional XPath for an element (for reproducibility).
 * @param {Element} el
 * @returns {string}
 */
function simpleXPath(el) {
  const parts = [];
  let n = el;
  while (n && n.nodeType === 1) {
    let idx = 1;
    let sib = n.previousElementSibling;
    while (sib) {
      if (sib.tagName === n.tagName) idx++;
      sib = sib.previousElementSibling;
    }
    parts.unshift(`${n.tagName}[${idx}]`);
    n = n.parentElement;
  }
  return '/' + parts.join('/');
}

const xml = fs.readFileSync(values.tei, 'utf-8');
const dom = new JSDOM(xml, { contentType: 'application/xml' });
const doc = dom.window.document;

const tagNames = values.selector.split(',').map(s => s.trim()).filter(Boolean);
let elements = [];
for (const tag of tagNames) {
  elements = elements.concat(Array.from(doc.getElementsByTagName(tag)));
}
// Drop elements nested inside other selected elements (e.g. bibl in biblStruct)
elements = elements.filter(el => !elements.some(other => other !== el && other.contains(el)));

const max = parseInt(values.max, 10);
const casesDir = path.join(baseDir, 'cases');
fs.mkdirSync(casesDir, { recursive: true });

let written = 0;
for (const el of elements) {
  if (written >= max) break;
  const queryText = (el.textContent || '').replace(/\s+/g, ' ').trim();
  if (queryText.length === 0) continue;
  written++;
  const id = `${values['pdf-id']}-${String(written).padStart(3, '0')}`;
  const caseData = {
    id,
    pdf: values['pdf-id'],
    tei: values.tei,
    xpath: simpleXPath(el),
    queryText,
    expected: null
  };
  fs.writeFileSync(path.join(casesDir, `${id}.json`), JSON.stringify(caseData, null, 2) + '\n');
}
console.log(`wrote ${written} cases to ${casesDir}`);
```

- [ ] **Step 3: Verify the generator on a real TEI file**

```bash
TEI=$(find data/files -name "*.tei.xml" | head -1)
node tests/pdf-match/generate-cases.js --tei "$TEI" --pdf-id gen-smoke --selector listBibl --max 2
cat tests/pdf-match/cases/gen-smoke-001.json
rm tests/pdf-match/cases/gen-smoke-*.json
```

Expected: case JSON with non-empty `queryText`, an xpath, `expected: null`.

- [ ] **Step 4: Commit**

```bash
git add tests/pdf-match/lib.js tests/pdf-match/generate-cases.js
git commit -m "feat: pdf-match shared lib and case generation"
```

---

## Task 8: Pipeline — run cases and produce the review report

**Files:**

- Create: `tests/pdf-match/run-cases.js`

- [ ] **Step 1: Write the runner/report generator**

Create `tests/pdf-match/run-cases.js`:

```javascript
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
 * - unreviewed: no gold expectation yet — review visually, then accept or
 *               reject via confirm.js
 */

import fs from 'node:fs';
import { parseArgs } from 'node:util';
import {
  loadCases, loadFixture, runCase, iou,
  RESULTS_PATH, REPORT_PATH, RENDER_SCALE
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
  }
  results.push({ id: caseData.id, pdf: caseData.pdf, match, candidates, status, goldIou });
  console.log(`${caseData.id}: ${match ? `page ${match.page} score ${match.score.toFixed(3)}` : 'NO MATCH'} [${status}]`);
}

fs.writeFileSync(RESULTS_PATH, JSON.stringify(results, null, 2));

// ---------- HTML report ----------

/** @param {unknown} s */
const esc = s => String(s).replace(/[&<>"]/g,
  c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

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
  unreviewed: results.filter(r => r.status === 'unreviewed').length
};

const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>pdf-match report</title>
<style>
  body { font-family: sans-serif; margin: 2em; max-width: 1100px; }
  section { border: 1px solid #ccc; margin-bottom: 2em; padding: 1em; }
  section.pass { border-left: 6px solid #2a2; }
  section.fail { border-left: 6px solid #c22; }
  section.unreviewed { border-left: 6px solid #f90; }
  .box { position: absolute; border: 3px solid red; background: rgba(255,0,0,0.15); }
  table { border-collapse: collapse; }
  td, th { border: 1px solid #ccc; padding: 2px 8px; text-align: left; }
</style></head><body>
<h1>pdf-match report — ${new Date().toISOString()}</h1>
<p>${results.length} cases: ${counts.pass} pass, ${counts.fail} fail, ${counts.unreviewed} unreviewed</p>
${sections}
</body></html>`;

fs.writeFileSync(REPORT_PATH, html);
console.log(`\n${results.length} cases: ${counts.pass} pass, ${counts.fail} fail, ${counts.unreviewed} unreviewed`);
console.log(`report: file://${REPORT_PATH}`);
```

- [ ] **Step 2: Verify with a temporary end-to-end smoke run**

```bash
PDF=$(find data/files -name "*.pdf" | head -1)
TEI=$(find data/files -name "*.tei.xml" | head -1)
node tests/pdf-match/extract-fixtures.js --pdf "$PDF" --id pipe-smoke --render
node tests/pdf-match/generate-cases.js --tei "$TEI" --pdf-id pipe-smoke --selector listBibl --max 1
node tests/pdf-match/run-cases.js
```

Expected: a result line for the case (match or NO MATCH — the PDF and TEI are unrelated here, so NO MATCH is fine), `results.json` and `report.html` written. Open the report to confirm it renders. Then clean up:

```bash
rm tests/pdf-match/fixtures/pipe-smoke.items.json tests/pdf-match/cases/pipe-smoke-*.json
rm -rf tests/pdf-match/pages/pipe-smoke tests/pdf-match/results.json tests/pdf-match/report.html
```

- [ ] **Step 3: Commit**

```bash
git add tests/pdf-match/run-cases.js
git commit -m "feat: pdf-match case runner with HTML review report"
```

---

## Task 9: Pipeline — gold confirmation tool

**Files:**

- Create: `tests/pdf-match/confirm.js`

- [ ] **Step 1: Write the confirmation tool**

Create `tests/pdf-match/confirm.js`:

```javascript
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
 *   stays in the open failure set to debug.
 */

import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { caseFilePath, RESULTS_PATH } from './lib.js';

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

/**
 * @param {string} id - Case id
 * @param {(caseData: Object) => void} mutate
 */
const update = (id, mutate) => {
  const p = caseFilePath(id);
  const caseData = JSON.parse(fs.readFileSync(p, 'utf-8'));
  mutate(caseData);
  fs.writeFileSync(p, JSON.stringify(caseData, null, 2) + '\n');
};

for (const id of values.accept.split(',').filter(Boolean)) {
  const r = byId.get(id);
  if (!r || !r.match) {
    console.error(`${id}: no proposed match in results.json - cannot accept`);
    continue;
  }
  update(id, c => {
    c.expected = { page: r.match.page, bbox: r.match.bbox };
    delete c.rejected;
  });
  console.log(`${id}: accepted (page ${r.match.page})`);
}

for (const id of values.reject.split(',').filter(Boolean)) {
  update(id, c => {
    c.expected = null;
    c.rejected = true;
  });
  console.log(`${id}: rejected`);
}
```

- [ ] **Step 2: Verify with a synthetic round-trip**

```bash
mkdir -p tests/pdf-match/cases
cat > tests/pdf-match/cases/confirm-smoke-001.json << 'EOF'
{
  "id": "confirm-smoke-001",
  "pdf": "none",
  "queryText": "x",
  "expected": null
}
EOF
cat > tests/pdf-match/results.json << 'EOF'
[{ "id": "confirm-smoke-001", "match": { "page": 3, "bbox": { "x0": 1, "y0": 2, "x1": 3, "y1": 4 } } }]
EOF
node tests/pdf-match/confirm.js --accept confirm-smoke-001
cat tests/pdf-match/cases/confirm-smoke-001.json
node tests/pdf-match/confirm.js --reject confirm-smoke-001
cat tests/pdf-match/cases/confirm-smoke-001.json
rm tests/pdf-match/cases/confirm-smoke-001.json tests/pdf-match/results.json
```

Expected: after accept, `expected` holds page 3 and the bbox; after reject, `expected` is null and `rejected: true` is set.

- [ ] **Step 3: Commit**

```bash
git add tests/pdf-match/confirm.js
git commit -m "feat: pdf-match gold confirmation tool"
```

---

## Task 10: Pipeline — regression test with metrics

**Files:**

- Create: `tests/unit/js/pdf-match-regression.test.js`

- [ ] **Step 1: Write the regression test**

Create `tests/unit/js/pdf-match-regression.test.js`:

```javascript
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
const THRESHOLD = 0.6;

const goldCases = loadCases().filter(c => c.expected);

// Compute all outcomes up front so the metrics block is complete even when
// individual assertions fail
const outcomes = goldCases.map(caseData => {
  const { match } = runCase(caseData, { threshold: THRESHOLD });
  const pageOk = Boolean(match) && match.page === caseData.expected.page;
  const overlap = pageOk ? iou(match.bbox, caseData.expected.bbox) : 0;
  return { caseData, match, pageOk, overlap, regionOk: pageOk && overlap >= MIN_IOU };
});

if (outcomes.length > 0) {
  const pageAcc = outcomes.filter(o => o.pageOk).length;
  const regionAcc = outcomes.filter(o => o.regionOk).length;
  const meanScore = outcomes.reduce((s, o) => s + (o.match ? o.match.score : 0), 0) / outcomes.length;
  console.log(
    `pdf-match metrics: page accuracy ${pageAcc}/${outcomes.length}, ` +
    `region hit rate ${regionAcc}/${outcomes.length}, mean score ${meanScore.toFixed(3)}`
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
      assert.ok(o.match, 'no match above threshold');
      assert.strictEqual(o.match.page, o.caseData.expected.page, 'wrong page');
      assert.ok(o.overlap >= MIN_IOU, `IoU ${o.overlap.toFixed(2)} < ${MIN_IOU}`);
    });
  }
});
```

- [ ] **Step 2: Run to verify it skips cleanly with no gold cases**

Run: `node tests/unit-test-runner.js tests/unit/js/pdf-match-regression.test.js`
Expected: PASS with 1 skipped test, no failures.

- [ ] **Step 3: Run the full JS unit suite to confirm nothing broke**

Run: `npm run test:unit:js`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add tests/unit/js/pdf-match-regression.test.js
git commit -m "feat: pdf-match regression test with metrics summary"
```

---

## Task 11: Bootstrap the gold dataset (user-assisted checkpoint)

**Files:**

- Create: `tests/pdf-match/fixtures/*.items.json` (committed)
- Create: `tests/pdf-match/cases/*.json` (committed)

This task requires the user: they pick representative documents and review the report. PDFs and TEI files live in `data/files/<xx>/<hash>.pdf|.tei.xml` with content-hashed names; the mapping is in `data/db/metadata.db`.

- [ ] **Step 1: Ask the user to designate 5–10 PDF+TEI pairs**

Ask for pairs of paths (or document names to look up in `data/db/metadata.db`). Also ask which TEI element selector fits their bibliography markup (`biblStruct,bibl` default — adjust if their variant stores entries differently, e.g. `listBibl`).

- [ ] **Step 2: Extract fixtures and generate cases for each pair**

For each pair (choose a short human-readable `<docid>` per document):

```bash
node tests/pdf-match/extract-fixtures.js --pdf <pdf-path> --id <docid> --render
node tests/pdf-match/generate-cases.js --tei <tei-path> --pdf-id <docid> --max 10
```

- [ ] **Step 3: Run the cases and open the report**

```bash
node tests/pdf-match/run-cases.js
```

Ask the user to open `tests/pdf-match/report.html` in a browser and review each unreviewed case: does the red box sit on the right bibliography entry?

- [ ] **Step 4: Freeze the gold set**

Apply the user's verdicts:

```bash
node tests/pdf-match/confirm.js --accept <comma-separated-ids> --reject <comma-separated-ids>
```

- [ ] **Step 5: Run the regression suite for the first real metrics**

Run: `node tests/unit-test-runner.js tests/unit/js/pdf-match-regression.test.js`
Expected: PASS for all accepted cases, with the metrics line printed. Record the metrics in the commit message.

- [ ] **Step 6: Iterate on failures (if any)**

For every rejected case: inspect its report section (top candidates, matched-vs-query diff), identify the failure mode (reading order? normalization? seeding?), fix the matcher, re-run `run-cases.js`, and re-review. Newly correct cases get accepted via `confirm.js`. Repeat until the spec targets are met (≥ 90% page accuracy, ≥ 80% region hit rate on gold cases) or remaining failures are understood and documented as known limitations in the README (Task 14).

- [ ] **Step 7: Commit fixtures, cases, and any matcher fixes**

```bash
git add tests/pdf-match/fixtures tests/pdf-match/cases app/src/modules/pdf-text-matcher.js
git commit -m "feat: pdf-match gold dataset (metrics: <fill in from Step 5>)"
```

---

## Task 12: Runtime — services plugin query construction

**Files:**

- Modify: `app/src/plugins/services.js` (method `searchNodeContentsInPdf`, ~line 428-461; add module-level function after the class)

- [ ] **Step 1: Replace the term-bag construction**

In `app/src/plugins/services.js`, replace the entire `searchNodeContentsInPdf` method with:

```javascript
  /**
   * Given a node in the XML, locate and highlight the region of the PDF
   * it was extracted from, using fuzzy sequence matching on the node's
   * ordered text content.
   * @param {Element} node
   */
  async searchNodeContentsInPdf(node) {
    const queryText = getNodeText(node).join(' ')
    if (!queryText.trim()) {
      return
    }
    // If the node originates from a footnote, prepend the printed footnote
    // number: the footnote text in the PDF physically starts with it
    const footnoteId = getSourceFootnoteId(node)
    const query = footnoteId ? `${footnoteId} ${queryText}` : queryText
    const match = await this.#pdfViewer.search(query)
    if (match) {
      this.#logger.debug(`PDF match: page ${match.page}, score ${match.score.toFixed(3)}`)
    } else {
      this.#logger.debug(`No PDF match for query: ${query.slice(0, 80)}...`)
      notify('No sufficiently similar text found in the PDF', 'warning', 'search')
    }
  }
```

- [ ] **Step 2: Add the footnote-convention function**

Add after the `getTextNodes` function at the bottom of `app/src/plugins/services.js`:

```javascript
/**
 * Returns the printed footnote identifier for a node, if the project's
 * ad-hoc convention applies: a `source="fnNN"` attribute on the node or an
 * ancestor marks the footnote the node was extracted from. This convention
 * is non-standard and may change - keep ALL knowledge of it inside this
 * function; callers only see "text to prepend to the PDF search query".
 * @param {Element} node
 * @returns {string|null} The printed footnote number, or null
 */
export function getSourceFootnoteId(node) {
  let current = node
  while (current && current.nodeType === 1 /* ELEMENT_NODE */) {
    const source = current.getAttribute('source')
    if (source && /^fn\d+$/.test(source)) {
      return source.slice(2)
    }
    current = current.parentElement
  }
  return null
}
```

- [ ] **Step 3: Verify no stale references remain**

Run: `grep -n "anchorTerm\|searchTerms" app/src/plugins/services.js`
Expected: no output (the old term-bag/anchor logic is gone from services.js).

- [ ] **Step 4: Commit**

(The app is temporarily inconsistent until Task 13 lands — `search()` still expects an array. Commit both tasks' changes only after Task 13's verification, or commit now if executing tasks strictly sequentially without intermediate manual app testing.)

```bash
git add app/src/plugins/services.js
git commit -m "feat: ordered-text PDF query with isolated footnote convention"
```

---

## Task 13: Runtime — pdfviewer module search path

**Files:**

- Modify: `app/src/modules/pdfviewer.js`

- [ ] **Step 1: Replace the import and instance state**

At the top of `app/src/modules/pdfviewer.js`, replace:

```javascript
import * as pdfTextSearch from './pdf-text-search.js';
```

with:

```javascript
import { buildPageModel, findBestMatch } from './pdf-text-matcher.js';

/**
 * @import { MatchResult, PageModel } from './pdf-text-matcher.js'
 */
```

Remove the class fields `bestMatches` and `matchIndex` (lines 18-28) and in the constructor replace the highlight/search state block (`this._highlightTerms = null;` through `this._lastMatchPage = 1;`) with:

```javascript
    // Current match state for re-rendering highlights on zoom/navigation
    /** @type {MatchResult|null} */
    this._highlightMatch = null;

    // Cached page models for the loaded document (built on first search)
    /** @type {PageModel[]|null} */
    this._pageModels = null;
```

- [ ] **Step 2: Update the textlayerrendered handler**

In `isReady()`, replace the `textlayerrendered` handler body with:

```javascript
          this.eventBus.on('textlayerrendered', (evt) => {
            if (this._highlightMatch && this._highlightMatch.page === evt.pageNumber) {
              this._clearClusterHighlights();
              requestAnimationFrame(() => {
                if (this._highlightMatch) {
                  this._highlightMatchInTextLayer(this._highlightMatch, false);
                }
              });
            }
          });
```

- [ ] **Step 3: Replace the search machinery**

Delete these methods entirely: `search()`, `_scoreAllPages()`, `scrollToBestMatch()`, `_getBestMatches()`, `_highlightTermsInTextLayer()`. Add in their place:

```javascript
  /**
   * Searches the loaded PDF for the region best matching the given text
   * and highlights it. Page models are built once per document and cached.
   *
   * @param {string} queryText - Ordered text of the selected TEI node
   * @param {Object} [options={}] - Search options
   * @param {number} [options.threshold=0.6] - Minimum similarity score in [0,1]
   * @returns {Promise<MatchResult|null>} The match, or null if none scored
   *   above the threshold
   */
  async search(queryText, options = {}) {
    const { threshold = 0.6 } = options;

    if (!queryText || !queryText.trim()) {
      console.warn("No search text provided.");
      return null;
    }

    if (!this.isLoadedFlag) {
      await this.isReady();
      if (!this.loadPromise) {
        throw new Error("PDF document not loaded. Call load() first.");
      }
      await this.loadPromise;
    }

    const pageModels = await this._getPageModels();
    const { match, candidates } = findBestMatch(pageModels, queryText, { threshold });
    console.log("PDF text match candidates:", candidates);

    if (!match) {
      this._highlightMatch = null;
      this._clearClusterHighlights();
      return null;
    }

    this._highlightMatch = match;
    await this.goToPage(match.page);

    // If the text layer already exists (cached page), highlight directly;
    // otherwise the textlayerrendered handler will do it
    const pageDiv = this.viewer.querySelector(`.page[data-page-number="${match.page}"]`);
    if (pageDiv?.querySelector('.textLayer')) {
      this._highlightMatchInTextLayer(match, true);
    }
    return match;
  }

  /**
   * Builds (and caches) matcher page models for the loaded document.
   * @returns {Promise<PageModel[]>}
   * @private
   */
  async _getPageModels() {
    if (this._pageModels) {
      return this._pageModels;
    }
    const models = [];
    for (let pageNum = 1; pageNum <= this.pdfDoc.numPages; pageNum++) {
      const page = await this.pdfDoc.getPage(pageNum);
      const textContent = await page.getTextContent();
      models.push(buildPageModel(textContent.items, pageNum));
    }
    this._pageModels = models;
    return models;
  }

  /**
   * Highlights the spans of a match in the page's text layer.
   * @param {MatchResult} match - The match to highlight
   * @param {boolean} [scrollIntoView=true] - Whether to scroll to the highlight
   * @private
   */
  _highlightMatchInTextLayer(match, scrollIntoView = true) {
    this._clearClusterHighlights();

    const pageDiv = this.viewer.querySelector(`.page[data-page-number="${match.page}"]`);
    const textLayer = pageDiv?.querySelector('.textLayer');
    if (!textLayer) {
      console.warn(`Text layer not found for page ${match.page}`);
      return;
    }

    const model = this._pageModels?.[match.page - 1];
    if (!model) return;

    const spans = this._mapItemsToSpans(textLayer, model.items, match.itemIndices);
    if (spans.length === 0) {
      console.warn("Could not map matched items to text layer spans");
      return;
    }

    // Convert span positions to text-layer-relative coordinates,
    // compensating for the CSS transform scale on the text layer
    const textLayerRect = textLayer.getBoundingClientRect();
    const transform = window.getComputedStyle(textLayer).transform;
    let scale = 1;
    if (transform && transform !== 'none') {
      const matrixMatch = transform.match(/matrix\(([^,]+)/);
      if (matrixMatch) {
        scale = parseFloat(matrixMatch[1]) || 1;
      }
    }

    const cluster = spans.map(span => {
      const r = span.getBoundingClientRect();
      return {
        span,
        rect: {
          left: (r.left - textLayerRect.left) / scale,
          top: (r.top - textLayerRect.top) / scale,
          right: (r.right - textLayerRect.left) / scale,
          bottom: (r.bottom - textLayerRect.top) / scale,
          width: r.width / scale,
          height: r.height / scale
        }
      };
    });

    this._createClusterHighlight(textLayer, cluster, scrollIntoView);
  }

  /**
   * Maps matched text-content item indices to text layer span elements.
   * PDF.js renders one span per text content item in item order; this walks
   * both sequences in lockstep with a small lookahead for resynchronization,
   * and falls back to exact-text search if the correspondence drifts.
   * @param {HTMLElement} textLayer - The page's text layer element
   * @param {import('./pdf-text-matcher.js').TextItem[]} items - Page model items
   * @param {number[]} itemIndices - Indices of the matched items
   * @returns {HTMLElement[]} The corresponding span elements
   * @private
   */
  _mapItemsToSpans(textLayer, items, itemIndices) {
    const spans = Array.from(textLayer.querySelectorAll('span'));
    const wanted = new Set(itemIndices);
    const result = [];
    let s = 0;
    for (let i = 0; i < items.length; i++) {
      let found = -1;
      for (let j = s; j < Math.min(s + 3, spans.length); j++) {
        if (spans[j].textContent === items[i].str) {
          found = j;
          break;
        }
      }
      if (found === -1) continue;
      if (wanted.has(i)) result.push(spans[found]);
      s = found + 1;
    }
    // Fallback: lockstep failed entirely - find spans by exact text
    if (result.length === 0) {
      for (const i of itemIndices) {
        const str = items[i].str;
        if (!str.trim()) continue;
        const span = spans.find(sp => sp.textContent === str);
        if (span) result.push(span);
      }
    }
    return result;
  }
```

Note for the JSDoc `@import` (Step 1): the `TextItem` reference in `_mapItemsToSpans` requires adding `TextItem` to the `@import` block: `@import { MatchResult, PageModel, TextItem } from './pdf-text-matcher.js'` — and the `@param` then uses plain `{TextItem[]}`.

- [ ] **Step 4: Update _clearClusterHighlights(), clear(), and close()**

The `clearState` branch of `_clearClusterHighlights()` references the deleted fields. Replace the whole method with:

```javascript
  /**
   * Clears any existing match highlight overlays
   * @param {boolean} clearState - Also clear the stored match state (default: false)
   * @private
   */
  _clearClusterHighlights(clearState = false) {
    const highlights = this.viewer.querySelectorAll('.cluster-highlight, .span-highlight');
    highlights.forEach(highlight => highlight.remove());

    if (clearState) {
      this._highlightMatch = null;
    }
  }
```

In `clear()`, replace the old state resets (`this.bestMatches = []; this.matchIndex = 0; this._highlightTerms = null; this._highlightPageNumber = null; this._highlightMinClusterSize = null;`) with:

```javascript
    this._highlightMatch = null;
    this._pageModels = null;
```

In `close()`, after `this.pdfDoc = null;` add:

```javascript
      this._pageModels = null;
      this._highlightMatch = null;
```

- [ ] **Step 5: Check for leftover references**

Run:

```bash
grep -n "pdfTextSearch\|_highlightTerms\|_highlightPageNumber\|_highlightMinClusterSize\|_highlightAnchorTerm\|bestMatches\|matchIndex\|_lastMatchPage\|scrollToBestMatch\|_scoreAllPages\|_getBestMatches" app/src/modules/pdfviewer.js
grep -rn "scrollToBestMatch\|bestMatches\|\.search(\[" app/src --include="*.js" | grep -v modules/pdfviewer.js
```

Expected: no output from either command. If the second grep finds callers, update them to the new `search(queryText)` signature.

- [ ] **Step 6: Run the JS unit suite**

Run: `npm run test:unit:js`
Expected: PASS (matcher tests, regression suite, and the still-present old pdf-text-search tests).

- [ ] **Step 7: Manual verification in the running app**

Ask the user to (or use a running dev instance): load a gold-verified document, enable the Autosearch switch in the PDF status bar, select a bibliography entry in the XML editor, and confirm the viewer scrolls to the correct page and draws the highlight box over the entry. Also verify the highlight survives a zoom change (re-rendered via `textlayerrendered`).

- [ ] **Step 8: Commit**

```bash
git add app/src/modules/pdfviewer.js
git commit -m "feat: sequence-alignment search path in PDF viewer"
```

---

## Task 14: Cleanup and documentation

**Files:**

- Delete: `app/src/modules/pdf-text-search.js`
- Delete: `tests/unit/js/pdf-text-search.test.js`
- Create: `tests/pdf-match/README.md`
- Modify: `docs/code-assistant/testing-guide.md`

- [ ] **Step 1: Confirm the regression suite is green, then delete the old module**

```bash
node tests/unit-test-runner.js tests/unit/js/pdf-match-regression.test.js
git rm app/src/modules/pdf-text-search.js tests/unit/js/pdf-text-search.test.js
grep -rn "pdf-text-search" app tests --include="*.js"
```

Expected: regression PASS; after deletion, the grep returns nothing.

- [ ] **Step 2: Write the pipeline README**

Create `tests/pdf-match/README.md`:

```markdown
# pdf-match: PDF Text Lookup Test Pipeline

Offline test pipeline for the PDF text matcher
(`app/src/modules/pdf-text-matcher.js`). All algorithm iteration happens in
Node against real-PDF fixtures - no browser required.

Design spec: `docs/superpowers/specs/2026-07-19-pdf-text-lookup-design.md`

## Layout

| Path | Committed | Purpose |
| --- | --- | --- |
| `fixtures/<docid>.items.json` | yes | Per-page PDF.js text items + viewports |
| `cases/<id>.json` | yes | One lookup case; `expected` holds the frozen gold location |
| `pages/<docid>/page-N.png` | no | Page renders for the review report |
| `results.json`, `report.html` | no | Latest run output |

## Workflow

Add documents (PDFs/TEIs live in `data/files/`, mapping in `data/db/metadata.db`):

    node tests/pdf-match/extract-fixtures.js --pdf <pdf-path> --id <docid> --render
    node tests/pdf-match/generate-cases.js --tei <tei-path> --pdf-id <docid> --max 10

Run and review:

    node tests/pdf-match/run-cases.js
    # open tests/pdf-match/report.html - check the red box on each page image

Freeze verdicts as gold:

    node tests/pdf-match/confirm.js --accept id1,id2 --reject id3

Regression (runs automatically with `npm run test:unit:js`):

    node tests/unit-test-runner.js tests/unit/js/pdf-match-regression.test.js

## Iteration loop

1. `run-cases.js` -> open `report.html`, look at failing/rejected cases.
2. Diagnose via the top-candidates table and matched-vs-query text.
3. Fix `pdf-text-matcher.js`, re-run (seconds - fixtures are cached JSON).
4. Newly correct cases: accept via `confirm.js`. The regression suite
   pins them so later changes cannot silently regress.

## Regenerating PNGs

PNGs are gitignored. To re-render for review, re-run `extract-fixtures.js`
with `--render` using the source PDF (path recorded in the fixture's
`sourcePath` field, valid on the machine that created it).
```

- [ ] **Step 3: Add a section to the testing guide**

Append to `docs/code-assistant/testing-guide.md`:

```markdown
## PDF Text Lookup Pipeline (pdf-match)

The PDF text matcher (`app/src/modules/pdf-text-matcher.js`) has a dedicated
offline pipeline in `tests/pdf-match/` that runs it against real-PDF fixtures
with human-confirmed gold locations. See
[tests/pdf-match/README.md](../../tests/pdf-match/README.md) for the
extract → generate → review → confirm workflow. The gold cases run as part of
`npm run test:unit:js` via `tests/unit/js/pdf-match-regression.test.js`;
algorithm changes must keep the printed page-accuracy and region-hit metrics
from regressing.
```

- [ ] **Step 4: Run the full unit suite one final time**

Run: `npm run test:unit:js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore: remove bag-of-words pdf-text-search, document pdf-match pipeline"
```

---

## Success criteria (from the spec)

- Regression suite: ≥ 90% page accuracy and ≥ 80% region hit rate (IoU ≥ 0.3) on the confirmed gold set.
- Selecting a bibliography entry with Autosearch enabled scrolls to and highlights the correct region for gold-verified documents.
- All heuristic clustering code removed; the matcher has one primary tunable (acceptance threshold).
