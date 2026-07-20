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
 *
 * Reliability: on the tests/pdf-match/ gold set (68 real bibliography
 * entries from 6 documents), page accuracy and region hit rate are both
 * 100%. In practice, results are only as good as the PDF's text layer —
 * scanned pages, heavy OCR artifacts, or unusual layouts degrade matches.
 * Alignment is per-page, so an entry split across a page break matches
 * whichever page holds the larger fragment (see buildPageModel() for the
 * two-column caveat). See tests/pdf-match/README.md to reproduce or extend
 * the gold set.
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
  '­': '',
  'ß': 'ss', 'ẞ': 'ss',
  'Œ': 'oe', 'œ': 'oe',
  'Æ': 'ae', 'æ': 'ae'
};

// Matches the Unicode Combining Diacritical Marks block (U+0300-U+036F).
const COMBINING_MARK = /[̀-ͯ]/;

/**
 * Folds a single character. If the character is in CHAR_MAP, returns its
 * mapping directly; otherwise NFKD-normalizes it, strips combining marks,
 * and lowercases the result. The two paths are mutually exclusive: a
 * CHAR_MAP hit returns early without also being NFKD-normalized. May
 * return zero, one, or several characters (e.g. "ﬁ" -> "fi", "é" -> "e",
 * soft hyphen -> "").
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

  // Column detection: split lines at a wide gap that brackets the midline.
  // gutter/splitCount-threshold below are untuned constants validated only
  // against the tests/pdf-match/ gold set; a page with very few lines and
  // one anomalously wide gap (e.g. a table row) could false-trigger
  // two-column mode. Retune via the pipeline if a gold case fails on this.
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

/**
 * Aligns the full query against a window of page text with free start and
 * end positions in the window (semi-global alignment). Unit costs for
 * substitution, insertion, and deletion.
 *
 * O(query.length * window.length) time, O(window.length) memory. Callers
 * keep windows small (query length + padding), so this stays fast.
 *
 * Tie-break note: when `query` shares nothing with `window`, the first
 * minimum in the final dp row wins, which can return a degenerate
 * zero-length range (start === end). Harmless today because that only
 * happens at distance ~= query.length, i.e. a score far below the
 * acceptance threshold — but a future caller that consumes start/end
 * before checking the score would see a bogus empty match.
 *
 * @param {string} query - Normalized query (fully aligned)
 * @param {string} window - Normalized page text window (substring match)
 * @returns {{distance: number, start: number, end: number}} Minimum edit
 *   distance and the matched character range [start, end) in the window
 */
export function alignQueryToWindow(query, window) {
  const m = query.length;
  const n = window.length;

  // dp row over window positions; the parallel prevStart/curStart arrays
  // track where each alignment began in the window, so the range can be
  // recovered without a traceback
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
