/**
 * Tools action "Find OCR errors (LLM)": the document is reviewed page window by page window, and
 * the suggestions of each window are shown as diagnostics. The backend routes and the layout route
 * are mocked (the real layout needs a GROBID feature file the test environment lacks; the review
 * itself is covered by the backend tests): a failing window keeps the findings of the earlier
 * windows and is named in the notification, a complete run reports the number of findings, and an
 * accepted correction is recorded in the document history.
 *
 * @testCovers app/src/plugins/ocr-review.js
 * @testCovers app/src/modules/llm-findings.js
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
});
