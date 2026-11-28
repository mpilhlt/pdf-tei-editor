#!/usr/bin/env node

/**
 * Sections of the "PDF information" dialog of the PDF viewer.
 *
 * @testCovers app/src/modules/pdf-info.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { JSDOM } from 'jsdom';
import { buildPdfInfoSections, renderPdfInfoSections, formatPdfDate } from '../../../app/src/modules/pdf-info.js';

/**
 * @param {Record<string, string>} entries
 * @param {string} raw
 */
function xmp(entries, raw = '<x:xmpmeta/>') {
  const map = new Map(Object.entries(entries));
  return { getRaw: () => raw, [Symbol.iterator]: () => map.entries() };
}

const file = /** @type {any} */ ({
  id: 'abc123',
  stable_id: 's1',
  filename: 'doc.pdf',
  doc_id: '10.1/x',
  file_type: 'pdf',
  file_size: 2048,
  created_at: '2026-11-27T10:00:00Z',
  file_metadata: {
    original_filename: 'Upload.pdf',
    ocr: { engine: 'ocrmypdf', languages: ['deu', 'eng'], method: 'redo', applied_at: '2026-11-27T10:00:00+00:00', applied_by: 'admin' },
    text_corrections: [
      { applied_at: '2026-11-27T11:00:00+00:00', applied_by: 'admin', source: 'llm-after-ocr', provider_id: 'kisski', model_id: 'm1', corrections: [{ page: 0, old: 'tbe', new: 'the' }] },
      { applied_at: '2026-11-27T12:00:00+00:00', applied_by: 'rev', tei_stable_id: 't1', pages: [2], corrections: [{ page: 2, line: 4, old: 'a', new: 'b' }, { page: 2, line: 5, old: 'c', new: 'd' }] }
    ],
    extractor: 'grobid'
  }
});

describe('buildPdfInfoSections', () => {
  it('shows the OCR record and the text corrections first, highlighted', () => {
    const sections = buildPdfInfoSections({ file, numPages: 3, pdfMetadata: { info: { Producer: 'OCRmyPDF 16 / Tesseract 5', Title: 'T' } } });
    assert.deepStrictEqual(sections.map(s => s.id), ['ocr', 'corrections', 'info', 'file']);
    const [ocr, corrections] = sections;
    assert.ok(ocr.highlight && corrections.highlight);
    assert.deepStrictEqual(ocr.rows.find(r => r.label === 'Languages')?.value, 'deu, eng');
    assert.strictEqual(corrections.rows[0].value, '3 corrections in 2 runs');
    assert.strictEqual(corrections.runs?.[0].rows.find(r => r.label === 'Model')?.value, 'kisski / m1');
    assert.strictEqual(corrections.runs?.[1].rows.find(r => r.label === 'Pages')?.value, '3');
    assert.strictEqual(corrections.runs?.[1].rows[0].value, 'Written from the TEI document');
  });

  it('highlights a producer that names a text recognition tool', () => {
    const [info] = buildPdfInfoSections({ pdfMetadata: { info: { Producer: 'OCRmyPDF 16', Creator: 'Word', PDFFormatVersion: '1.7', IsLinearized: false } } });
    assert.strictEqual(info.rows.find(r => r.label === 'Producer')?.highlight, true);
    assert.strictEqual(info.rows.find(r => r.label === 'Creator (application)')?.highlight, false);
    assert.strictEqual(info.rows.find(r => r.label === 'Optimized for web view')?.value, 'No');
  });

  it('lists XMP entries with the raw packet and other file metadata', () => {
    const sections = buildPdfInfoSections({ file, pdfMetadata: { info: {}, metadata: xmp({ 'xmp:creatortool': 'ocrmypdf 16', 'dc:title': 'T' }) } });
    const x = sections.find(s => s.id === 'xmp');
    assert.strictEqual(x?.raw, '<x:xmpmeta/>');
    assert.strictEqual(x?.rows.find(r => r.label === 'xmp:creatortool')?.highlight, true);
    const stored = sections.find(s => s.id === 'file');
    assert.strictEqual(stored?.rows.find(r => r.label === 'Uploaded as')?.value, 'Upload.pdf');
    assert.strictEqual(stored?.rows.find(r => r.label === 'extractor')?.value, 'grobid');
    assert.ok(!stored?.rows.some(r => r.label === 'ocr' || r.label === 'text_corrections'));
  });

  it('returns no sections without metadata', () => {
    assert.deepStrictEqual(buildPdfInfoSections({}), []);
  });
});

describe('formatPdfDate', () => {
  it('parses PDF dates and leaves other text alone', () => {
    assert.notStrictEqual(formatPdfDate("D:20261127100000+01'00'"), "D:20261127100000+01'00'");
    assert.strictEqual(formatPdfDate('not a date'), 'not a date');
  });
});

describe('renderPdfInfoSections', () => {
  it('renders sections, correction tables and the raw XMP', () => {
    const dom = new JSDOM('<!DOCTYPE html><div></div>');
    const container = /** @type {HTMLElement} */ (dom.window.document.querySelector('div'));
    renderPdfInfoSections(container, buildPdfInfoSections({ file, pdfMetadata: { info: {}, metadata: xmp({ 'dc:title': 'T' }) } }));
    assert.ok(container.querySelector('[data-section="ocr"].pdf-info-section-highlight'));
    assert.strictEqual(container.querySelectorAll('.pdf-info-corrections tr').length, 2 + 3);
    assert.ok(container.querySelector('.pdf-info-raw'));
  });
});
