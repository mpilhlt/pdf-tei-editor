/**
 * Text recognition in the extraction dialog runs in the background with a progress widget instead
 * of the blocking spinner: the widget shows the progress, cancelling stops the OCR job and nothing is
 * extracted, and a result that finishes after the user opened other documents is only loaded if the
 * user confirms. The OCR, extractor check and extraction routes are mocked (the real run needs an
 * OCR engine and is covered by the backend tests).
 *
 * @testCovers app/src/plugins/extraction.js
 * @testCovers app/src/plugins/ocr.js
 */

import { test, expect } from '../fixtures/debug-on-failure.js';
import { setupTestConsoleCapture, waitForTestMessage, setupErrorFailure } from './helpers/test-logging.js';
import { navigateAndLogin, performLogout, releaseAllLocks } from './helpers/login-helper.js';
import { selectFirstDocuments } from './helpers/extraction-helper.js';

/**
 * @import { Page } from '@playwright/test'
 */

const ALLOWED_ERROR_PATTERNS = [
  'Failed to load resource.*401.*UNAUTHORIZED'
];

const ENGINE = {
  id: 'mock-engine',
  name: 'Mock engine',
  description: 'Mock OCR engine',
  languages: ['en', 'de'],
  default_languages: ['en'],
  options: {}
};

const SCANNED_PDF = 'tests/e2e/fixtures/pdf/scanned-document.pdf';

const WIDGET = '.progress-widget[data-progress-id^="ocr-extraction-"]';

/**
 * @param {string} status
 * @param {object} [fields]
 * @returns {object} An OCR job
 */
function job(status, fields = {}) {
  return { job_id: 'job-1', stable_id: 'abc', status, username: 'x', pid: 1, created_at: '2026-01-01T00:00:00', updated_at: '2026-01-01T00:00:00', ...fields };
}

/**
 * Mock the OCR engine list, the extractor check and the start of the OCR job.
 * @param {Page} page
 * @returns {Promise<{extractCalls: () => number}>}
 */
async function mockRoutes(page) {
  let extractCalls = 0;
  await page.route('**/api/v1/ocr/engines', route => route.fulfill({ json: [ENGINE] }));
  await page.route('**/api/v1/extract/check', route => route.fulfill({ json: { ready: true, message: null } }));
  await page.route('**/api/v1/ocr', route => {
    if (route.request().method() !== 'POST') return route.fallback();
    return route.fulfill({ json: job('queued') });
  });
  await page.route('**/api/v1/extract', route => {
    extractCalls++;
    return route.fulfill({ status: 500, json: { detail: 'not expected in this test' } });
  });
  return { extractCalls: () => extractCalls };
}

/**
 * Upload the scanned PDF and submit the extraction dialog with text recognition switched on.
 * @param {Page} page
 * @param {ReturnType<typeof setupTestConsoleCapture>} consoleLogs
 */
async function startExtractionWithOcr(page, consoleLogs) {
  const fileChooserPromise = page.waitForEvent('filechooser');
  await page.evaluate(() => {
    /** @type {namedElementsTree} */
    const ui = /** @type {any} */(window).ui;
    ui.toolbar.extractionActions.extractNew.click();
  });
  await (await fileChooserPromise).setFiles(SCANNED_PDF);
  await waitForTestMessage(consoleLogs, 'EXTRACTION_OPTIONS_DIALOG_STARTING', 15000);
  // the OCR section is shown once the engines and the text quality are loaded
  await waitForTestMessage(consoleLogs, 'OCR_TEXT_QUALITY', 15000);
  await page.waitForTimeout(500);
  const applyOcr = page.locator('sl-checkbox[name="applyOcr"]');
  if (!await applyOcr.evaluate(el => /** @type {any} */(el).checked)) {
    await applyOcr.click({ position: { x: 8, y: 8 } });
  }
  await expect.poll(() => applyOcr.evaluate(el => /** @type {any} */(el).checked)).toBe(true);
  await page.waitForTimeout(500);
  await page.evaluate(() => {
    /** @type {namedElementsTree} */
    const ui = /** @type {any} */(window).ui;
    ui.extractionOptions.submit.click();
  });
}

test.describe('Text recognition in the background', () => {
  test('shows the progress and stops when cancelled, without extracting', async ({ page }) => {
    test.setTimeout(90000);
    const consoleLogs = setupTestConsoleCapture(page);
    const stopErrorMonitoring = setupErrorFailure(consoleLogs, ALLOWED_ERROR_PATTERNS);
    try {
      const mocks = await mockRoutes(page);
      let cancelPosted = false;
      await page.route('**/api/v1/ocr/jobs/*/cancel', route => {
        cancelPosted = true;
        return route.fulfill({ json: job('running') });
      });
      await page.route('**/api/v1/ocr/jobs/job-1', route => route.fulfill({
        json: cancelPosted
          ? job('cancelled')
          : job('running', { progress: { phase: 'Recognizing text', done: 1, total: 4, unit: 'page', eta_seconds: 30 } })
      }));
      await navigateAndLogin(page, 'testreviewer', 'reviewerpass');
      await startExtractionWithOcr(page, consoleLogs);

      const widget = page.locator(WIDGET);
      await expect(widget).toContainText('Recognizing text', { timeout: 20000 });
      // no blocking spinner while the job runs
      expect(await page.evaluate(() => /** @type {any} */(window).ui.spinner.container.classList.contains('hidden'))).toBe(true);

      await widget.locator('[data-name="cancelBtn"]').click();
      await waitForTestMessage(consoleLogs, 'OCR_CANCELLED', 15000);
      expect(cancelPosted).toBe(true);
      await expect(widget).toHaveCount(0);
      await expect(page.locator('sl-alert', { hasText: 'Text recognition was cancelled' })).toBeVisible();
      expect(mocks.extractCalls()).toBe(0);
    } finally {
      stopErrorMonitoring();
      await releaseAllLocks(page);
      await performLogout(page);
    }
  });

  test('asks before loading the result when other documents were opened meanwhile', async ({ page }) => {
    test.setTimeout(90000);
    const consoleLogs = setupTestConsoleCapture(page);
    const stopErrorMonitoring = setupErrorFailure(consoleLogs, ALLOWED_ERROR_PATTERNS);
    try {
      await mockRoutes(page);
      let switched = false;
      // the job finishes once the user has switched documents; only the correction was cancelled,
      // so the OCR result is kept and nothing is extracted
      await page.route('**/api/v1/ocr/jobs/*/cancel', route => route.fulfill({ json: job('running') }));
      await page.route('**/api/v1/ocr/jobs/job-1', route => route.fulfill({
        json: switched
          ? job('done', { result: { stable_id: 'abc', changed: true, quality: { status: 'good', summary: 'ok', reasons: [] }, llm_corrections: [], llm_correction_cancelled: true } })
          : job('running', { progress: { phase: 'Correcting OCR errors', done: 1, total: 3, unit: 'window', eta_seconds: 20 } })
      }));
      await navigateAndLogin(page, 'testreviewer', 'reviewerpass');
      await startExtractionWithOcr(page, consoleLogs);

      const widget = page.locator(WIDGET);
      await expect(widget).toContainText('Correcting OCR errors', { timeout: 20000 });
      // the user cancels the correction and opens other documents meanwhile
      await widget.locator('[data-name="cancelBtn"]').click();
      const loadResult = await selectFirstDocuments(page);
      expect(loadResult.success).toBe(true);
      const opened = await page.evaluate(() => /** @type {any} */(window).app.getCurrentState().xml);
      expect(opened).toBeTruthy();
      switched = true;

      const finished = await waitForTestMessage(consoleLogs, 'BACKGROUND_PROCESS_FINISHED', 15000);
      expect(finished.value.unchanged).toBe(false);
      const dialog = page.locator('sl-dialog[name="dialog"]');
      await expect(dialog).toContainText('Load the result now?');
      await page.waitForTimeout(500);
      await page.evaluate(() => /** @type {any} */(window).ui.dialog.cancelBtn.click());
      const confirmed = await waitForTestMessage(consoleLogs, 'BACKGROUND_RESULT_CONFIRMED', 10000);
      expect(confirmed.value.confirmed).toBe(false);
      // the document the user switched to stays
      expect(await page.evaluate(() => /** @type {any} */(window).app.getCurrentState().xml)).toBe(opened);
    } finally {
      stopErrorMonitoring();
      await releaseAllLocks(page);
      await performLogout(page);
    }
  });
});
