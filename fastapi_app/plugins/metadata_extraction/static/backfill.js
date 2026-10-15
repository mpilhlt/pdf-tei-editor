/**
 * @file Options dialog of the collection metadata backfill.
 *
 * Reads the collection and session from the page URL, posts the backfill request and renders the
 * report returned by `POST /api/plugins/metadata-extraction/backfill`.
 */

/**
 * @typedef {object} FileResult
 * @property {string} stable_id
 * @property {Object<string, any>} filled - Added data points and their values
 * @property {string|null} language_source - Where an added language comes from
 * @property {boolean} locked
 * @property {string|null} error
 */

/**
 * @typedef {object} DocumentResult
 * @property {string} doc_id
 * @property {string|null} pdf_stable_id
 * @property {string|null} doi
 * @property {string[]} sources
 * @property {FileResult[]} files
 * @property {Object<string, any>} pdf_filled - Added doc_metadata keys and their values
 * @property {string[]} errors
 */

/**
 * @typedef {object} BackfillSummary
 * @property {number} documents
 * @property {number} documents_updated
 * @property {number} tei_files_updated
 * @property {number} tei_files_locked
 * @property {number} pdfs_updated
 * @property {number} errors
 */

/**
 * @typedef {object} BackfillReport
 * @property {string} collection
 * @property {boolean} dry_run
 * @property {boolean} grobid_available
 * @property {BackfillSummary} summary
 * @property {Object<string, number>} sources
 * @property {DocumentResult[]} documents
 */

const params = new URLSearchParams(window.location.search);
const sessionId = params.get('session_id') || '';
const collection = params.get('collection') || '';

const startBtn = /** @type {HTMLButtonElement} */ (document.getElementById('startBtn'));
const closeBtn = /** @type {HTMLButtonElement} */ (document.getElementById('closeBtn'));
const dryRunInput = /** @type {HTMLInputElement} */ (document.getElementById('dryRun'));
const useGrobidInput = /** @type {HTMLInputElement} */ (document.getElementById('useGrobid'));
const downloadInput = /** @type {HTMLInputElement} */ (document.getElementById('downloadReport'));
const limitInput = /** @type {HTMLInputElement} */ (document.getElementById('limit'));
const statusEl = /** @type {HTMLDivElement} */ (document.getElementById('status'));
const resultsEl = /** @type {HTMLDivElement} */ (document.getElementById('results'));

/**
 * Show a status message.
 * @param {string} message
 * @param {'info'|'success'|'warning'|'error'} type
 */
function setStatus(message, type) {
  statusEl.hidden = false;
  statusEl.className = `status ${type}`;
  statusEl.textContent = message;
}

/**
 * Create an element with text content.
 * @param {string} tag
 * @param {string} text
 * @returns {HTMLElement}
 */
function el(tag, text) {
  const element = document.createElement(tag);
  element.textContent = text;
  return element;
}

/**
 * Label of an added data point; the language is shown with its value and source.
 * @param {FileResult} file
 * @param {string} name
 * @returns {string}
 */
function fieldLabel(file, name) {
  if (name !== 'language') {
    return name;
  }
  return `language=${file.filled.language}${file.language_source ? ` (${file.language_source})` : ''}`;
}

/**
 * Save the report as a JSON file on the user's computer.
 * @param {BackfillReport} report
 */
function downloadReport(report) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const mode = report.dry_run ? 'dry-run' : 'applied';
  const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `metadata-backfill-${report.collection}-${mode}-${timestamp}.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Render the per-document results as a table.
 * @param {BackfillReport} report
 */
function renderReport(report) {
  resultsEl.replaceChildren();
  const { summary } = report;
  const verb = report.dry_run ? 'would be updated' : 'updated';
  const sources = Object.entries(report.sources)
    .filter(([, count]) => count > 0)
    .map(([source, count]) => `${source}: ${count}`)
    .join(', ');
  const lines = [
    `${summary.documents_updated} of ${summary.documents} documents ${verb} (${summary.tei_files_updated} TEI files, ${summary.pdfs_updated} PDF records).`,
    `Sources: ${sources || 'none'}.${report.grobid_available ? '' : ' GROBID was not available.'}`,
  ];
  if (summary.tei_files_locked) {
    lines.push(`${summary.tei_files_locked} TEI files skipped because they are locked.`);
  }
  if (summary.errors) {
    lines.push(`${summary.errors} errors.`);
  }
  setStatus(lines.join(' '), summary.errors ? 'warning' : 'success');

  if (report.documents.length === 0) {
    return;
  }
  const table = document.createElement('table');
  const head = document.createElement('tr');
  for (const label of ['Document', 'Sources', 'Added to TEI files', 'Added to PDF', 'Problems']) {
    head.appendChild(el('th', label));
  }
  table.appendChild(head);
  for (const doc of report.documents) {
    const row = document.createElement('tr');
    row.appendChild(el('td', doc.doi || doc.doc_id));
    row.appendChild(el('td', doc.sources.join(', ')));
    const filled = doc.files
      .filter(f => Object.keys(f.filled).length > 0 && !f.locked)
      .map(f => `${f.stable_id}: ${Object.keys(f.filled).map(name => fieldLabel(f, name)).join(', ')}`);
    row.appendChild(el('td', filled.join('; ')));
    row.appendChild(el('td', Object.keys(doc.pdf_filled).join(', ')));
    const problems = [
      ...doc.errors,
      ...doc.files.filter(f => f.locked).map(f => `${f.stable_id}: locked`),
      ...doc.files.filter(f => f.error).map(f => `${f.stable_id}: ${f.error}`),
    ];
    const problemsCell = el('td', problems.join('; '));
    problemsCell.className = 'errors';
    row.appendChild(problemsCell);
    table.appendChild(row);
  }
  resultsEl.appendChild(table);
}

/**
 * Run the backfill with the selected options.
 */
async function startBackfill() {
  const query = new URLSearchParams({
    collection,
    dry_run: String(dryRunInput.checked),
    use_grobid: String(useGrobidInput.checked),
  });
  if (limitInput.value) {
    query.set('limit', limitInput.value);
  }
  startBtn.disabled = true;
  resultsEl.replaceChildren();
  setStatus(dryRunInput.checked ? 'Checking documents...' : 'Backfilling metadata...', 'info');
  try {
    const response = await fetch(`/api/plugins/metadata-extraction/backfill?${query}`, {
      method: 'POST',
      headers: { 'X-Session-ID': sessionId },
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.detail || `Request failed (${response.status})`);
    }
    const report = /** @type {BackfillReport} */ (await response.json());
    renderReport(report);
    if (downloadInput.checked) {
      downloadReport(report);
    }
  } catch (error) {
    setStatus(`Backfill failed: ${error instanceof Error ? error.message : String(error)}`, 'error');
  } finally {
    startBtn.disabled = false;
  }
}

startBtn.addEventListener('click', startBackfill);
closeBtn.addEventListener('click', () => {
  // @ts-ignore - injected by the sandbox client script
  window.sandbox.closeDialog();
});
