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
// Drop elements inside <teiHeader>: those describe the article itself
// (its own citation/metadata), not references printed in the document body
elements = elements.filter(el => !el.closest('teiHeader'));
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
