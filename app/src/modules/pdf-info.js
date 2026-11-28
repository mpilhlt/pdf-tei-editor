/**
 * Metadata of a PDF for the "PDF information" dialog of the PDF viewer: the record of the
 * text recognition and the text corrections that the editor keeps in the file metadata of the
 * PDF, the document information dictionary, the XMP metadata and the stored file.
 *
 * `buildPdfInfoSections()` is pure; `renderPdfInfoSections()` renders its result into a container.
 */

/**
 * @import { FileMetadata } from './api-client-v1.js'
 */

/**
 * One row of a section
 * @typedef {object} PdfInfoRow
 * @property {string} label - The name of the value
 * @property {string} value - The value as text
 * @property {boolean} [highlight] - Whether the value was written by text recognition
 */

/**
 * A text correction written into the text layer
 * @typedef {object} PdfInfoCorrection
 * @property {number|null} page - The 0-based page number, if known
 * @property {string} old - The text before the correction
 * @property {string} new - The text after the correction
 */

/**
 * One record of writing text corrections into the text layer
 * @typedef {object} PdfInfoCorrectionRun
 * @property {string} title - Who or what wrote the corrections, and when
 * @property {PdfInfoRow[]} rows - The details of the run
 * @property {PdfInfoCorrection[]} corrections - The corrections
 */

/**
 * A section of the dialog
 * @typedef {object} PdfInfoSection
 * @property {string} id - Identifier of the section (`ocr`, `corrections`, `info`, `xmp`, `file`)
 * @property {string} title - Heading of the section
 * @property {boolean} [highlight] - Whether the section shows what text recognition wrote
 * @property {PdfInfoRow[]} rows - The rows
 * @property {PdfInfoCorrectionRun[]} [runs] - The correction runs (section `corrections`)
 * @property {string} [raw] - The raw XMP packet (section `xmp`)
 */

/**
 * Metadata as returned by PDF.js `PDFDocumentProxy.getMetadata()`
 * @typedef {object} PdfJsMetadata
 * @property {Record<string, unknown>} [info] - The document information dictionary, with the PDF.js additions (`PDFFormatVersion`, `IsLinearized`, ...)
 * @property {{getRaw: () => string, [Symbol.iterator]: () => Iterator<[string, unknown]>}|null} [metadata] - The parsed XMP metadata
 * @property {number|null} [contentLength] - The size of the file in bytes
 */

/**
 * Input of {@link buildPdfInfoSections}
 * @typedef {object} PdfInfoInput
 * @property {PdfJsMetadata|null} [pdfMetadata] - The metadata read by PDF.js
 * @property {number|null} [numPages] - The number of pages
 * @property {FileMetadata|null} [file] - The stored file record of the PDF
 */

/** Key of the text recognition record in the file metadata of a PDF (see fastapi_app/lib/ocr/provenance.py) */
export const OCR_METADATA_KEY = 'ocr';

/** Key of the list of text correction records in the file metadata of a PDF */
export const TEXT_CORRECTIONS_METADATA_KEY = 'text_corrections';

/** Values in the information dictionary or XMP that name a text recognition tool */
const OCR_TOOL_PATTERN = /ocrmypdf|tesseract|hocr|\bocr\b/i;

/** Labels of the standard entries of the document information dictionary, in display order */
const INFO_LABELS = /** @type {const} */ ([
  ['Title', 'Title'],
  ['Author', 'Author'],
  ['Subject', 'Subject'],
  ['Keywords', 'Keywords'],
  ['Creator', 'Creator (application)'],
  ['Producer', 'Producer'],
  ['CreationDate', 'Created'],
  ['ModDate', 'Modified'],
  ['Trapped', 'Trapped'],
  ['PDFFormatVersion', 'PDF version'],
  ['Language', 'Language'],
  ['IsLinearized', 'Optimized for web view'],
  ['IsAcroFormPresent', 'Has form fields'],
  ['IsXFAPresent', 'Has XFA forms'],
  ['IsCollectionPresent', 'Is a portfolio'],
  ['IsSignaturesPresent', 'Has signatures']
]);

/** Labels of the text recognition record */
const OCR_LABELS = /** @type {const} */ ([
  ['engine', 'Engine'],
  ['method', 'Method'],
  ['languages', 'Languages'],
  ['models', 'Models'],
  ['fallback_reason', 'Fallback reason'],
  ['applied_at', 'Applied'],
  ['applied_by', 'Applied by']
]);

/** Descriptions of the `source` of a text correction record */
const CORRECTION_SOURCES = /** @type {Record<string, string>} */ ({
  'llm-after-ocr': 'Language model, after text recognition',
  'llm-correction': 'Language model'
});

/** Keys of the file metadata that the sections for text recognition and text corrections show */
const SHOWN_FILE_METADATA_KEYS = new Set([OCR_METADATA_KEY, TEXT_CORRECTIONS_METADATA_KEY]);

/**
 * Format a PDF date string (`D:YYYYMMDDHHmmSSOHH'mm'`) or an ISO date as a local date and time.
 * Values that are not dates are returned unchanged.
 * @param {string} value
 * @returns {string}
 */
export function formatPdfDate(value) {
  const match = /^(?:D:)?(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?([Zz+-])?(\d{2})?'?(\d{2})?'?$/.exec(value.trim());
  let date = null;
  if (match) {
    const [, y, mo = '01', d = '01', h = '00', mi = '00', s = '00', tz, tzh = '00', tzm = '00'] = match;
    const offset = !tz || tz === 'Z' || tz === 'z' ? 'Z' : `${tz}${tzh}:${tzm}`;
    date = new Date(`${y}-${mo}-${d}T${h}:${mi}:${s}${offset}`);
  } else if (/^\d{4}-\d{2}-\d{2}T/.test(value.trim())) {
    date = new Date(value.trim());
  }
  if (!date || Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/**
 * Format a file size in bytes
 * @param {number} bytes
 * @returns {string}
 */
export function formatFileSize(bytes) {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Format any metadata value as text
 * @param {unknown} value
 * @returns {string}
 */
function formatValue(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (Array.isArray(value)) return value.map(formatValue).join(', ');
  if (typeof value === 'object') {
    // PDF.js returns names (e.g. /Trapped) as objects with a `name` property
    const name = /** @type {{name?: unknown}} */ (value).name;
    if (typeof name === 'string') return name;
    return JSON.stringify(value);
  }
  const text = String(value);
  return /^(?:D:)?\d{14}/.test(text) || /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(text) ? formatPdfDate(text) : text;
}

/**
 * Whether a value names a text recognition tool
 * @param {string} value
 * @returns {boolean}
 */
function namesOcrTool(value) {
  return OCR_TOOL_PATTERN.test(value);
}

/**
 * @param {Record<string, unknown>} record
 * @returns {PdfInfoRow[]}
 */
function ocrRows(record) {
  /** @type {PdfInfoRow[]} */
  const rows = [];
  for (const [key, label] of OCR_LABELS) {
    const value = formatValue(record[key]);
    if (value) rows.push({ label, value });
  }
  for (const [key, value] of Object.entries(record)) {
    if (!OCR_LABELS.some(([known]) => known === key) && formatValue(value)) {
      rows.push({ label: key, value: formatValue(value) });
    }
  }
  return rows;
}

/**
 * @param {Record<string, unknown>} record
 * @returns {PdfInfoCorrectionRun}
 */
function correctionRun(record) {
  const items = Array.isArray(record.corrections) ? record.corrections : [];
  /** @type {PdfInfoCorrection[]} */
  const corrections = items
    .filter(item => item && typeof item === 'object')
    .map(item => ({
      page: typeof item.page === 'number' ? item.page : null,
      old: String(item.old ?? ''),
      new: String(item.new ?? '')
    }));
  const model = typeof record.model_id === 'string' ? record.model_id : '';
  const source = typeof record.source === 'string' ? record.source : '';
  const appliedAt = typeof record.applied_at === 'string' ? formatPdfDate(record.applied_at) : '';
  const origin = model
    ? (CORRECTION_SOURCES[source] ?? 'Language model')
    : 'Written from the TEI document';
  const count = `${corrections.length} correction${corrections.length === 1 ? '' : 's'}`;
  /** @type {PdfInfoRow[]} */
  const rows = [{ label: 'Source', value: origin }];
  if (model) {
    const provider = typeof record.provider_id === 'string' && record.provider_id ? `${record.provider_id} / ` : '';
    rows.push({ label: 'Model', value: `${provider}${model}` });
  }
  if (Array.isArray(record.pages)) {
    rows.push({ label: 'Pages', value: record.pages.map(p => Number(p) + 1).join(', ') });
  }
  if (typeof record.tei_stable_id === 'string' && record.tei_stable_id) {
    rows.push({ label: 'TEI document', value: record.tei_stable_id });
  }
  if (typeof record.applied_by === 'string' && record.applied_by) {
    rows.push({ label: 'Applied by', value: record.applied_by });
  }
  return {
    title: [appliedAt, count].filter(Boolean).join(' · '),
    rows,
    corrections
  };
}

/**
 * Build the sections of the PDF information dialog. Sections without content are left out.
 * @param {PdfInfoInput} input
 * @returns {PdfInfoSection[]}
 */
export function buildPdfInfoSections({ pdfMetadata = null, numPages = null, file = null }) {
  /** @type {PdfInfoSection[]} */
  const sections = [];
  const fileMetadata = /** @type {Record<string, unknown>} */ (file?.file_metadata ?? {});

  // Text recognition
  const ocr = fileMetadata[OCR_METADATA_KEY];
  if (ocr && typeof ocr === 'object' && !Array.isArray(ocr)) {
    sections.push({
      id: 'ocr',
      title: 'Text recognition (OCR)',
      highlight: true,
      rows: ocrRows(/** @type {Record<string, unknown>} */ (ocr))
    });
  }

  // Text corrections written into the text layer
  const corrections = fileMetadata[TEXT_CORRECTIONS_METADATA_KEY];
  if (Array.isArray(corrections) && corrections.length > 0) {
    const runs = corrections
      .filter(record => record && typeof record === 'object')
      .map(record => correctionRun(/** @type {Record<string, unknown>} */ (record)));
    const total = runs.reduce((sum, run) => sum + run.corrections.length, 0);
    sections.push({
      id: 'corrections',
      title: 'Text corrections in the text layer',
      highlight: true,
      rows: [{ label: 'Total', value: `${total} correction${total === 1 ? '' : 's'} in ${runs.length} run${runs.length === 1 ? '' : 's'}` }],
      runs
    });
  }

  // Document information dictionary
  const info = pdfMetadata?.info ?? {};
  /** @type {PdfInfoRow[]} */
  const infoRows = [];
  for (const [key, label] of INFO_LABELS) {
    const value = formatValue(info[key]);
    if (value) infoRows.push({ label, value, highlight: namesOcrTool(value) && (key === 'Creator' || key === 'Producer') });
  }
  const custom = info.Custom;
  if (custom && typeof custom === 'object') {
    for (const [key, value] of Object.entries(custom)) {
      const text = formatValue(value);
      if (text) infoRows.push({ label: key, value: text, highlight: namesOcrTool(text) });
    }
  }
  if (numPages) infoRows.push({ label: 'Pages', value: String(numPages) });
  if (infoRows.length > 0) {
    sections.push({ id: 'info', title: 'Document information', rows: infoRows });
  }

  // XMP metadata
  const xmp = pdfMetadata?.metadata;
  if (xmp) {
    /** @type {PdfInfoRow[]} */
    const xmpRows = [];
    for (const [key, value] of xmp) {
      const text = formatValue(value);
      if (text) xmpRows.push({ label: key, value: text, highlight: namesOcrTool(text) });
    }
    const raw = typeof xmp.getRaw === 'function' ? xmp.getRaw() : '';
    if (xmpRows.length > 0 || raw) {
      sections.push({ id: 'xmp', title: 'XMP metadata', rows: xmpRows, raw: raw || undefined });
    }
  }

  // Stored file
  if (file) {
    /** @type {PdfInfoRow[]} */
    const fileRows = [];
    const originalName = fileMetadata.original_filename;
    if (file.filename) fileRows.push({ label: 'File name', value: file.filename });
    if (typeof originalName === 'string' && originalName && originalName !== file.filename) {
      fileRows.push({ label: 'Uploaded as', value: originalName });
    }
    const size = file.file_size || pdfMetadata?.contentLength;
    if (size) fileRows.push({ label: 'File size', value: formatFileSize(size) });
    if (file.doc_id) fileRows.push({ label: 'Document id', value: file.doc_id });
    if (file.id) fileRows.push({ label: 'Content hash', value: file.id });
    if (file.created_at) fileRows.push({ label: 'Stored', value: formatPdfDate(file.created_at) });
    if (file.updated_at && file.updated_at !== file.created_at) fileRows.push({ label: 'Updated', value: formatPdfDate(file.updated_at) });
    if (file.created_by) fileRows.push({ label: 'Stored by', value: file.created_by });
    for (const [key, value] of Object.entries(fileMetadata)) {
      if (SHOWN_FILE_METADATA_KEYS.has(key) || key === 'original_filename') continue;
      const text = formatValue(value);
      if (text) fileRows.push({ label: key, value: text });
    }
    if (fileRows.length > 0) {
      sections.push({ id: 'file', title: 'Stored file', rows: fileRows });
    }
  }

  return sections;
}

/**
 * Render a table of rows
 * @param {Document} doc
 * @param {PdfInfoRow[]} rows
 * @returns {HTMLTableElement}
 */
function renderRows(doc, rows) {
  const table = doc.createElement('table');
  table.className = 'pdf-info-table';
  for (const row of rows) {
    const tr = doc.createElement('tr');
    if (row.highlight) {
      tr.className = 'pdf-info-highlight';
      tr.title = 'Written by text recognition';
    }
    const th = doc.createElement('th');
    th.textContent = row.label;
    const td = doc.createElement('td');
    td.textContent = row.value;
    tr.append(th, td);
    table.append(tr);
  }
  return table;
}

/**
 * Render the sections into a container, replacing its content
 * @param {HTMLElement} container
 * @param {PdfInfoSection[]} sections
 */
export function renderPdfInfoSections(container, sections) {
  const doc = container.ownerDocument;
  container.replaceChildren();
  if (sections.length === 0) {
    const empty = doc.createElement('p');
    empty.textContent = 'The PDF has no metadata.';
    container.append(empty);
    return;
  }
  for (const section of sections) {
    const el = doc.createElement('section');
    el.className = 'pdf-info-section' + (section.highlight ? ' pdf-info-section-highlight' : '');
    el.dataset.section = section.id;
    const heading = doc.createElement('h3');
    heading.textContent = section.title;
    el.append(heading);
    if (section.rows.length > 0) {
      el.append(renderRows(doc, section.rows));
    }
    for (const run of section.runs ?? []) {
      const details = doc.createElement('sl-details');
      details.setAttribute('summary', run.title || 'Text corrections');
      details.append(renderRows(doc, run.rows));
      if (run.corrections.length > 0) {
        const list = doc.createElement('table');
        list.className = 'pdf-info-corrections';
        const head = doc.createElement('tr');
        for (const text of ['Page', 'Before', 'After']) {
          const th = doc.createElement('th');
          th.textContent = text;
          head.append(th);
        }
        list.append(head);
        for (const correction of run.corrections) {
          const tr = doc.createElement('tr');
          const cells = [correction.page === null ? '' : String(correction.page + 1), correction.old, correction.new];
          for (const text of cells) {
            const td = doc.createElement('td');
            td.textContent = text;
            tr.append(td);
          }
          list.append(tr);
        }
        details.append(list);
      }
      el.append(details);
    }
    if (section.raw) {
      const details = doc.createElement('sl-details');
      details.setAttribute('summary', 'Raw XMP');
      const pre = doc.createElement('pre');
      pre.className = 'pdf-info-raw';
      pre.textContent = section.raw;
      details.append(pre);
      el.append(details);
    }
    container.append(el);
  }
}
