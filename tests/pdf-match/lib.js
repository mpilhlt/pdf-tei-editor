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
export const REJECTED_PATH = path.join(baseDir, 'rejected.json');
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

/**
 * Reads a case file, throwing a clear error if it does not exist.
 * @param {string} id - Case id
 * @returns {{path: string, caseData: Object}} The case file path and parsed contents
 */
function readCaseFile(id) {
  const p = caseFilePath(id);
  if (!fs.existsSync(p)) {
    throw new Error(`Case file not found: ${p}`);
  }
  return { path: p, caseData: JSON.parse(fs.readFileSync(p, 'utf-8')) };
}

/**
 * Freezes a proposed match as the gold expectation for a case. Clears any
 * previous rejection markers.
 * @param {string} id - Case id
 * @param {{page: number, bbox: {x0: number, y0: number, x1: number, y1: number}}} match - Proposed match to freeze
 * @returns {void}
 */
export function acceptCase(id, match) {
  const { path: p, caseData } = readCaseFile(id);
  caseData.expected = { page: match.page, bbox: match.bbox };
  delete caseData.rejected;
  delete caseData.rejectNote;
  fs.writeFileSync(p, JSON.stringify(caseData, null, 2) + '\n');
}

/**
 * Marks a case as rejected (no valid match found by the matcher). Clears
 * `expected` and records an optional free-text note.
 * @param {string} id - Case id
 * @param {{note?: string}} [options={}] - Optional rejection note
 * @returns {void}
 */
export function rejectCase(id, { note } = {}) {
  const { path: p, caseData } = readCaseFile(id);
  caseData.expected = null;
  caseData.rejected = true;
  if (note) {
    caseData.rejectNote = note;
  } else {
    delete caseData.rejectNote;
  }
  fs.writeFileSync(p, JSON.stringify(caseData, null, 2) + '\n');
}

/**
 * Appends (or replaces, by id) a diagnostic entry in rejected.json. Used to
 * keep a record of why a case was rejected during review, for later
 * debugging of the matcher.
 * @param {{id: string, pdf?: string, page?: number|null, score?: number|null,
 *   queryText?: string, matchedText?: string|null, bbox?: Object|null,
 *   candidates?: Array<Object>, note?: string}} entry - Rejection diagnostic entry
 * @returns {void}
 */
export function recordRejection(entry) {
  let list = [];
  if (fs.existsSync(REJECTED_PATH)) {
    list = JSON.parse(fs.readFileSync(REJECTED_PATH, 'utf-8'));
  }
  const record = { ...entry, rejectedAt: new Date().toISOString() };
  const idx = list.findIndex(e => e.id === record.id);
  if (idx >= 0) {
    list[idx] = record;
  } else {
    list.push(record);
  }
  fs.writeFileSync(REJECTED_PATH, JSON.stringify(list, null, 2) + '\n');
}
