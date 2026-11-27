/**
 * Tools action "Find OCR errors (LLM)": the document is reviewed page window by page window, and
 * the suggestions of each window are shown as diagnostics. The backend routes and the layout route
 * are mocked (the real layout needs a GROBID feature file the test environment lacks; the review
 * itself is covered by the backend tests): a failing window keeps the findings of the earlier
 * windows and is named in the notification, a complete run reports the number of findings, and an
 * accepted correction is recorded in the document history. The focus action reviews the focused
 * node without asking, then writes its corrections to the PDF without creating a new version.
 * The review runs as the client job `ocr.llm-review`: it shows a job widget whose cancel button
 * stops it, and a reload resumes it after the saved page windows unless the document changed.
 *
 * @testCovers app/src/plugins/ocr-review.js
 * @testCovers app/src/plugins/text-corrections.js
 * @testCovers app/src/plugins/services.js
 * @testCovers app/src/modules/llm-findings.js
 * @testCovers app/src/plugins/jobs.js
 * @testCovers fastapi_app/lib/ocr/job_types.py
 */

/**
 * @import { Page } from '@playwright/test'
 */

import fs from 'fs';
import { test, expect } from '../fixtures/debug-on-failure.js';
import { setupTestConsoleCapture, waitForTestMessage, setupErrorFailure } from './helpers/test-logging.js';
import { navigateAndLogin, releaseAllLocks } from './helpers/login-helper.js';

const ALLOWED_ERROR_PATTERNS = [
  'Failed to load resource.*401.*UNAUTHORIZED',
  'Failed to load resource.*502'
];

const SCANNED_PDF = 'tests/e2e/fixtures/pdf/scanned-document.pdf';

/**
 * Mock the model list, the layout and the review routes. Call before navigateAndLogin().
 * @param {import('@playwright/test').Page} page
 * @param {(index: number) => {status: number, json: object}} reviewWindow - response for a window
 */
async function mockRoutes(page, reviewWindow) {
  await page.route('**/api/v1/llm/providers', route => route.fulfill({
    json: [{
      id: 'mock', label: 'Mock provider', key_required: false, secret_service: null, error: null,
      models: [{ id: 'mock-model', label: 'Mock model', capabilities: [], status: null, free: true }]
    }]
  }));
  await page.route('**/api/v1/llm/default-model', route => route.request().method() === 'GET'
    ? route.fulfill({ json: null })
    : route.continue());
  await page.route('**/api/v1/files/*/layout', route => route.fulfill({ json: { status: 'ok', pages: [0], hints: [[]] } }));
  await page.route('**/api/v1/ocr/llm-review/plan', route => route.fulfill({ json: { window_count: 2 } }));
  await page.route('**/api/v1/ocr/llm-review', route => {
    const index = route.request().postDataJSON().window_index;
    return route.fulfill(reviewWindow(index));
  });
}

/**
 * Create a document of its own (a PDF with unique content and a TEI version) and load it.
 * @param {import('@playwright/test').Page} page
 * @returns {Promise<{stableId: string, pdfId: string}>}
 */
async function createOwnDocument(page) {
  const unique = `ocr-review-${Date.now()}`;
  const buffer = Buffer.concat([fs.readFileSync(SCANNED_PDF), Buffer.from(`\n%${unique}\n`)]);
  const fileChooserPromise = page.waitForEvent('filechooser');
  const uploadPromise = page.evaluate(() => /** @type {any} */ (window).client.uploadFile());
  await (await fileChooserPromise).setFiles({ name: `${unique}.pdf`, mimeType: 'application/pdf', buffer });
  const pdfId = (await uploadPromise).filename;
  expect(pdfId).toBeTruthy();

  const xml = `<TEI xmlns="http://www.tei-c.org/ns/1.0"><teiHeader><fileDesc><titleStmt><title>${unique}</title></titleStmt><publicationStmt><p/></publicationStmt><sourceDesc><p/></sourceDesc></fileDesc></teiHeader><text><body><p>teh text</p></body></text></TEI>`;
  const stableId = await page.evaluate(async ({ pdfId, xml }) => {
    const client = /** @type {any} */ (window).client;
    const list = await client.apiClient.filesList();
    const group = list.files.find((/** @type {any} */ f) => f.source?.id === pdfId);
    const saved = await client.apiClient.filesSave({ xml_string: xml, file_id: group.doc_id, new_version: true });
    await client.apiClient.filesReleaseLock({ file_id: saved.file_id });
    return saved.file_id;
  }, { pdfId, xml });
  expect(stableId).toBeTruthy();

  await page.evaluate(id => /** @type {any} */ (window).app.getDependency('services').load({ xml: id }), stableId);
  await page.waitForFunction(() => {
    const view = /** @type {any} */ (window).app.getDependency('xmleditor').getView();
    return view && view.state.doc.length > 0;
  }, { timeout: 15000 });
  await page.waitForTimeout(500);
  await page.evaluate(() => /** @type {any} */ (window).app.getDependency('inference-settings').setSessionModel('mock', 'mock-model'));
  return { stableId, pdfId };
}

/**
 * Delete the files a test created.
 * @param {import('@playwright/test').Page} page
 * @param {string[]} ids
 */
async function cleanUp(page, ids) {
  await releaseAllLocks(page);
  await page.evaluate(async ids => {
    const api = /** @type {any} */ (window).client.apiClient;
    for (const id of ids) await api.filesDelete({ files: [id] }).catch(() => {});
  }, ids).catch(() => {});
}

/**
 * Choose the item of the Tools menu and confirm the dialog naming the model.
 * @param {import('@playwright/test').Page} page
 */
async function runReview(page) {
  await page.click('sl-dropdown[name="toolsDropdown"] sl-button[name="toolsBtn"]');
  await page.waitForTimeout(500);
  const item = page.locator('sl-menu-item:has-text("Find OCR errors (LLM)")');
  await item.waitFor({ state: 'visible', timeout: 15000 });
  await expect(item).toBeEnabled({ timeout: 15000 });
  await item.click();
  const confirmDialog = page.locator('sl-dialog[name="dialog"]');
  await expect(confirmDialog).toHaveAttribute('open', '', { timeout: 15000 });
  await expect(confirmDialog).toContainText('Mock provider/Mock model');
  await page.waitForTimeout(500);
  await confirmDialog.locator('sl-button[name="confirmBtn"]').click();
}

/**
 * The response of a page window: one finding in the first, none in the second.
 * @param {number} index
 * @returns {{status: number, json: object}}
 */
function okWindow(index) {
  return {
    status: 200,
    json: {
      findings: index === 0 ? [{ id: 0, old: 'teh', new: 'the', rationale: 'OCR error: transposed letters' }] : [],
      window_count: 2, discarded: 0, window_start: 0, window_end: 10
    }
  };
}

/**
 * The job widget of a job.
 * @param {Page} page
 * @param {string} jobId
 */
function jobWidget(page, jobId) {
  return page.locator(`.progress-widget[data-progress-id="job-${jobId}"]`);
}

/**
 * The status of a job.
 * @param {Page} page
 * @param {string} jobId
 * @returns {Promise<string>}
 */
function jobStatus(page, jobId) {
  return page.evaluate(async id => (await /** @type {any} */ (window).client.apiClient.jobsGet(id)).status, jobId);
}

/**
 * Create an `ocr.llm-review` job held by this tab, as if a reload had interrupted a review, with
 * the findings of the first page window saved.
 * @param {Page} page
 * @param {{stable_id: string, xml_file_id: string}} params
 * @returns {Promise<string>} The job id
 */
async function createInterruptedReview(page, params) {
  return page.evaluate(async params => {
    const jobs = /** @type {any} */ (window).jobs;
    const api = /** @type {any} */ (window).client.apiClient;
    const holder = jobs.client.holder;
    const job = await jobs.client.submit('ocr.llm-review', { ...params, provider_id: 'mock', model_id: 'mock-model' });
    await api.jobsClaim(job.id, { holder });
    const findings = [{ id: 0, old: 'teh', new: 'the', rationale: 'OCR error: transposed letters' }];
    await api.jobsSaveStep(job.id, 'window-0', { holder, result: { findings, window_count: 2 } });
    return job.id;
  }, params);
}

/**
 * The content hash (SHA-256, hex) of the XML in the editor.
 * @param {Page} page
 * @returns {Promise<string>}
 */
function editorXmlHash(page) {
  return page.evaluate(async () => {
    const text = /** @type {any} */ (window).app.getDependency('xmleditor').getView().state.doc.toString();
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
  });
}

/**
 * Reload the page and log in again if needed; the document in the URL is loaded again.
 * @param {Page} page
 * @param {any[]} consoleLogs
 */
async function reloadAndLogin(page, consoleLogs) {
  consoleLogs.length = 0;
  await page.reload();
  if (await page.locator('sl-dialog[name="loginDialog"][open]').isVisible({ timeout: 5000 }).catch(() => false)) {
    await navigateAndLogin(page, 'testreviewer', 'reviewerpass');
  }
}

test.describe('OCR review', () => {
  test('a failing window keeps the findings of the earlier windows and is named', async ({ page }) => {
    test.setTimeout(90000);
    const consoleLogs = setupTestConsoleCapture(page);
    const stopErrorMonitoring = setupErrorFailure(consoleLogs, ALLOWED_ERROR_PATTERNS);
    /** @type {string[]} */
    const created = [];
    try {
      await mockRoutes(page, index => index === 0 ? okWindow(0) : { status: 502, json: { detail: 'The model gave an unusable answer' } });
      await navigateAndLogin(page, 'testreviewer', 'reviewerpass');
      const own = await createOwnDocument(page);
      created.push(own.stableId, own.pdfId);
      await runReview(page);

      await expect(page.locator('sl-alert[variant="danger"]')).toContainText('page window 2', { timeout: 20000 });
      await expect(page.locator('.cm-lintRange-info')).toHaveCount(1);
    } finally {
      stopErrorMonitoring();
      await cleanUp(page, created);
    }
  });

  test('a complete run reports the findings', async ({ page }) => {
    test.setTimeout(90000);
    const consoleLogs = setupTestConsoleCapture(page);
    const stopErrorMonitoring = setupErrorFailure(consoleLogs, ALLOWED_ERROR_PATTERNS);
    /** @type {string[]} */
    const created = [];
    try {
      await mockRoutes(page, okWindow);
      await navigateAndLogin(page, 'testreviewer', 'reviewerpass');
      const own = await createOwnDocument(page);
      created.push(own.stableId, own.pdfId);
      await runReview(page);

      const done = await waitForTestMessage(consoleLogs, 'OCR_REVIEW_DONE', 20000);
      expect(done.value.findings).toBe(1);
      expect(done.value.windows).toBe(2);
      await expect(page.locator('sl-alert:has-text("Found 1 possible OCR error.")')).toBeVisible({ timeout: 10000 });
      await expect(page.locator('.cm-lintRange-info')).toHaveCount(1);
    } finally {
      stopErrorMonitoring();
      await cleanUp(page, created);
    }
  });

  test('an accepted correction is recorded in the document history', async ({ page }) => {
    test.setTimeout(90000);
    const consoleLogs = setupTestConsoleCapture(page);
    const stopErrorMonitoring = setupErrorFailure(consoleLogs, ALLOWED_ERROR_PATTERNS);
    /** @type {string[]} */
    const created = [];
    try {
      await mockRoutes(page, okWindow);
      await navigateAndLogin(page, 'testreviewer', 'reviewerpass');
      const own = await createOwnDocument(page);
      created.push(own.stableId, own.pdfId);
      await runReview(page);
      await waitForTestMessage(consoleLogs, 'OCR_REVIEW_DONE', 20000);

      await page.locator('.diagnostics-drawer-item', { hasText: 'transposed letters' }).locator('.diagnostics-drawer-action', { hasText: 'Propose fix' }).click();
      await page.waitForFunction(() => /** @type {any} */ (window).app.getDependency('xmleditor').isMergeViewActive(), null, { timeout: 10000 });
      await page.evaluate(() => /** @type {any} */ (window).app.getDependency('xmleditor').acceptAllDiffs());

      const recorded = await waitForTestMessage(consoleLogs, 'OCR_CORRECTION_RECORDED', 10000);
      expect(recorded.value.count).toBe(1);
      const text = await page.evaluate(() => /** @type {any} */ (window).app.getDependency('xmleditor').getView().state.doc.toString());
      expect(text).toContain('<p>the text</p>');
      expect(text).toMatch(/<change [^>]*who="#testreviewer"[^>]*>\s*<desc>Accepted 1 OCR correction suggested by Mock provider\/Mock model<\/desc>/);
    } finally {
      stopErrorMonitoring();
      await cleanUp(page, created);
    }
  });

  test('a correction applied in the diagnostics drawer is recorded in the document history', async ({ page }) => {
    test.setTimeout(90000);
    const consoleLogs = setupTestConsoleCapture(page);
    const stopErrorMonitoring = setupErrorFailure(consoleLogs, ALLOWED_ERROR_PATTERNS);
    /** @type {string[]} */
    const created = [];
    try {
      await mockRoutes(page, okWindow);
      await navigateAndLogin(page, 'testreviewer', 'reviewerpass');
      const own = await createOwnDocument(page);
      created.push(own.stableId, own.pdfId);
      await runReview(page);
      await waitForTestMessage(consoleLogs, 'OCR_REVIEW_DONE', 20000);

      await page.locator('.diagnostics-drawer-item', { hasText: 'transposed letters' }).locator('.diagnostics-drawer-action', { hasText: 'Apply fix' }).click();

      const recorded = await waitForTestMessage(consoleLogs, 'OCR_CORRECTION_RECORDED', 10000);
      expect(recorded.value.count).toBe(1);
      const text = await page.evaluate(() => /** @type {any} */ (window).app.getDependency('xmleditor').getView().state.doc.toString());
      expect(text).toContain('<p>the text</p>');
      expect(text).toMatch(/<desc>Accepted 1 OCR correction suggested by Mock provider\/Mock model<\/desc>/);
    } finally {
      stopErrorMonitoring();
      await cleanUp(page, created);
    }
  });

  test('the focus action reviews the node without asking and then writes its corrections', async ({ page }) => {
    test.setTimeout(120000);
    const consoleLogs = setupTestConsoleCapture(page);
    const stopErrorMonitoring = setupErrorFailure(consoleLogs, ALLOWED_ERROR_PATTERNS);
    /** @type {string[]} */
    const created = [];
    try {
      await mockRoutes(page, okWindow);
      await page.route('**/api/v1/ocr/llm-review/plan', route => route.fulfill({ json: { window_count: 1, pages: [0] } }));
      /** @type {any[]} */
      const requests = [];
      await page.route('**/api/v1/ocr/text-corrections/preview', route => {
        requests.push({ preview: route.request().postDataJSON() });
        return route.fulfill({ json: { corrections: [{ page: 0, line: 0, old: 'teh', new: 'the' }], unwritable: [], reason: null, update_pending: false } });
      });
      /** @type {{stableId: string, pdfId: string}|null} */
      let own = null;
      await page.route('**/api/v1/ocr/text-corrections/apply', async route => {
        const body = route.request().postDataJSON();
        requests.push({ apply: body });
        const xml = await page.evaluate(() => /** @type {any} */ (window).app.getDependency('xmleditor').getView().state.doc.toString());
        const updated = xml.replace('</teiHeader>', '<revisionDesc><change when="2026-11-27T00:00:00Z" status="draft" who="#testreviewer"><desc>Wrote 1 text correction on page 1</desc></change></revisionDesc></teiHeader>');
        return route.fulfill({ json: { xml: updated, tei_stable_id: body.stable_id, pdf_stable_id: own?.pdfId, source_pdf_stable_id: own?.pdfId, corrections: 1, new_version: false } });
      });
      await navigateAndLogin(page, 'testreviewer', 'reviewerpass');
      own = await createOwnDocument(page);
      created.push(own.stableId, own.pdfId);
      await page.evaluate(() => /** @type {any} */ (window).app.updateState({ xpath: '(//tei:text//tei:p)[1]' }));
      const isFocusMode = () => page.evaluate(() => /** @type {any} */ (window).app.getDependency('xmleditor').isFocusMode());
      // the document has no variant and thus no node navigation, which would switch focus mode on
      await page.evaluate(() => /** @type {any} */ (window).app.getDependency('xmleditor').setFocusMode(true));
      await expect.poll(isFocusMode).toBe(true);

      const reviewButton = page.locator('.cm-focus-action', { hasText: 'OCR auto-corrections' });
      await expect(reviewButton).toBeVisible({ timeout: 15000 });
      await reviewButton.click();
      const done = await waitForTestMessage(consoleLogs, 'OCR_REVIEW_DONE', 20000);
      expect(done.value.findings).toBe(1);
      // no confirmation for a node
      await expect(page.locator('sl-dialog[name="dialog"]')).not.toHaveAttribute('open', '');

      await page.locator('.diagnostics-drawer-item', { hasText: 'transposed letters' }).locator('.diagnostics-drawer-action', { hasText: 'Apply fix' }).click();
      await waitForTestMessage(consoleLogs, 'OCR_CORRECTION_RECORDED', 10000);

      const writeButton = page.locator('.cm-focus-action', { hasText: 'Write text corrections to PDF' });
      await expect(writeButton).toBeVisible({ timeout: 10000 });
      await writeButton.click();
      const applied = await waitForTestMessage(consoleLogs, 'TEXT_CORRECTIONS_APPLIED', 20000);
      expect(applied.value).toMatchObject({ newFileId: own.stableId, newVersion: false });
      expect(requests).toEqual([
        { preview: expect.objectContaining({ stable_id: own.stableId, pages: [0] }) },
        { apply: expect.objectContaining({ stable_id: own.stableId, pages: [0], skip_unwritable: false }) }
      ]);
      // the editor shows the version with the recorded write, which is still the open one
      const state = await page.evaluate(() => {
        const app = /** @type {any} */ (window).app;
        return { xml: app.getCurrentState().xml, text: app.getDependency('xmleditor').getView().state.doc.toString() };
      });
      expect(state.xml).toBe(own.stableId);
      expect(state.text).toContain('Wrote 1 text correction on page 1');
      await expect(reviewButton).toBeVisible({ timeout: 10000 });
    } finally {
      stopErrorMonitoring();
      await cleanUp(page, created);
    }
  });

  test('review shows a job widget and cancel stops it', async ({ page }) => {
    test.setTimeout(90000);
    const consoleLogs = setupTestConsoleCapture(page);
    const stopErrorMonitoring = setupErrorFailure(consoleLogs, ALLOWED_ERROR_PATTERNS);
    /** @type {string[]} */
    const created = [];
    /** @type {number[]} */
    const reviewed = [];
    try {
      await mockRoutes(page, okWindow);
      // the first window takes a while, so that the cancel arrives before the second
      await page.route('**/api/v1/ocr/llm-review', async route => {
        const index = route.request().postDataJSON().window_index;
        reviewed.push(index);
        if (index === 0) await new Promise(resolve => setTimeout(resolve, 3000));
        return route.fulfill(okWindow(index));
      });
      await navigateAndLogin(page, 'testreviewer', 'reviewerpass');
      await waitForTestMessage(consoleLogs, 'JOBS_SUBSCRIBED', 15000);
      const own = await createOwnDocument(page);
      created.push(own.stableId, own.pdfId);
      await runReview(page);

      const widget = page.locator('.progress-widget[data-progress-id^="job-"]', { hasText: 'Finding OCR errors' });
      await expect(widget).toBeVisible({ timeout: 10000 });
      const jobId = /** @type {string} */ (await widget.getAttribute('data-progress-id')).slice('job-'.length);
      await expect(jobWidget(page, jobId).locator('[name="titleRow"]')).toHaveText('Finding OCR errors');
      await page.waitForTimeout(500);
      await jobWidget(page, jobId).locator('[data-name="cancelBtn"]').click();

      await expect(page.locator('sl-alert[variant="warning"]', { hasText: 'Review cancelled after 1 of 2 page windows; 1 possible OCR error(s) so far.' })).toBeVisible({ timeout: 15000 });
      await expect.poll(() => jobStatus(page, jobId), { timeout: 10000 }).toBe('cancelled');
      await expect(jobWidget(page, jobId)).toHaveCount(0, { timeout: 10000 });
      expect(reviewed).toEqual([0]);
      await expect(page.locator('.cm-lintRange-info')).toHaveCount(1);
    } finally {
      stopErrorMonitoring();
      await cleanUp(page, created);
    }
  });

  test('a reload resumes the review after the saved page windows', async ({ page }) => {
    test.setTimeout(90000);
    const consoleLogs = setupTestConsoleCapture(page);
    const stopErrorMonitoring = setupErrorFailure(consoleLogs, ALLOWED_ERROR_PATTERNS);
    /** @type {string[]} */
    const created = [];
    /** @type {number[]} */
    const reviewed = [];
    try {
      await mockRoutes(page, okWindow);
      await page.route('**/api/v1/ocr/llm-review', route => {
        const index = route.request().postDataJSON().window_index;
        reviewed.push(index);
        return route.fulfill(okWindow(index));
      });
      await navigateAndLogin(page, 'testreviewer', 'reviewerpass');
      await waitForTestMessage(consoleLogs, 'JOBS_SUBSCRIBED', 15000);
      const own = await createOwnDocument(page);
      created.push(own.stableId, own.pdfId);
      const jobId = await createInterruptedReview(page, { stable_id: own.stableId, xml_file_id: await editorXmlHash(page) });

      await reloadAndLogin(page, consoleLogs);
      const done = await waitForTestMessage(consoleLogs, 'OCR_REVIEW_DONE', 30000);
      // the findings of the first window come from the saved step; only the second is reviewed
      expect(done.value).toMatchObject({ findings: 1, windows: 2 });
      expect(reviewed).toEqual([1]);
      await expect.poll(() => jobStatus(page, jobId), { timeout: 10000 }).toBe('done');
      await expect(page.locator('.cm-lintRange-info')).toHaveCount(1);
    } finally {
      stopErrorMonitoring();
      await cleanUp(page, created);
    }
  });

  test('a reload discards the review if the document changed', async ({ page }) => {
    test.setTimeout(90000);
    const consoleLogs = setupTestConsoleCapture(page);
    const stopErrorMonitoring = setupErrorFailure(consoleLogs, ALLOWED_ERROR_PATTERNS);
    /** @type {string[]} */
    const created = [];
    /** @type {number[]} */
    const reviewed = [];
    try {
      await mockRoutes(page, okWindow);
      await page.route('**/api/v1/ocr/llm-review', route => {
        reviewed.push(route.request().postDataJSON().window_index);
        return route.fulfill(okWindow(0));
      });
      await navigateAndLogin(page, 'testreviewer', 'reviewerpass');
      await waitForTestMessage(consoleLogs, 'JOBS_SUBSCRIBED', 15000);
      const own = await createOwnDocument(page);
      created.push(own.stableId, own.pdfId);
      // the content hash of an earlier state of the document
      const jobId = await createInterruptedReview(page, { stable_id: own.stableId, xml_file_id: '0'.repeat(64) });

      await reloadAndLogin(page, consoleLogs);
      await expect(page.locator('sl-alert[variant="warning"]', { hasText: 'The document changed; the review was discarded' })).toBeVisible({ timeout: 30000 });
      await expect.poll(() => jobStatus(page, jobId), { timeout: 10000 }).toBe('cancelled');
      expect(reviewed).toEqual([]);
    } finally {
      stopErrorMonitoring();
      await cleanUp(page, created);
    }
  });
});
