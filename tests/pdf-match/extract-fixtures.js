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
// pdf.js requires a trailing "/" and reads this as a plain fs path via
// fs.promises.readFile, so it must use forward slashes even on Windows
// (path.join's backslashes fail pdf.js's own "/"-suffix check).
const standardFontDataUrl = `${path.join(baseDir, '../../node_modules/pdfjs-dist/standard_fonts').split(path.sep).join('/')}/`;
const doc = await getDocument({ data, standardFontDataUrl }).promise;

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
