/**
 * Text recognition in the extraction dialog runs as a job in the background instead of behind the
 * blocking spinner: the job's widget (shown by the jobs plugin) shows the progress, cancelling
 * stops the job and nothing is extracted, and a result that finishes after the user opened other
 * documents is only loaded if the user confirms. The OCR routes are answered with stand-in jobs
 * (`test.progress`, see helpers/ocr-job-helper.js), since the real run needs an OCR engine and is
 * covered by the backend tests; the extractor check and extraction routes are mocked.
 *
 * @testCovers app/src/plugins/extraction.js
 * @testCovers app/src/plugins/ocr.js
 * @testCovers app/src/plugins/ocr-correction.js
 */

import { test, expect } from '../fixtures/debug-on-failure.js';
import { setupTestConsoleCapture, waitForTestMessage, setupErrorFailure } from './helpers/test-logging.js';
import { navigateAndLogin, performLogout, releaseAllLocks } from './helpers/login-helper.js';
import { selectFirstDocuments } from './helpers/extraction-helper.js';
import { standInOcrJobs, jobWidget } from './helpers/ocr-job-helper.js';

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

const QUALITY = { status: 'good', summary: 'ok', reasons: [] };

/**
 * Mock the OCR engine list, the extractor check and the extraction.
 * @param {Page} page
 * @returns {Promise<{extractCalls: () => number}>}
 */
async function mockRoutes(page) {
  let extractCalls = 0;
  await page.route('**/api/v1/ocr/engines', route => route.fulfill({ json: [ENGINE] }));
  await page.route('**/api/v1/extract/check', route => route.fulfill({ json: { ready: true, message: null } }));
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

/**
 * The id of the job that the client submitted.
 * @param {ReturnType<typeof setupTestConsoleCapture>} consoleLogs
 * @returns {Promise<string>}
 */
async function submittedJobId(consoleLogs) {
  const submitted = await waitForTestMessage(consoleLogs, 'OCR_JOB_SUBMITTED', 20000);
  return submitted.value.jobId;
}

test.describe('Text recognition in the background', () => {
  test('shows the progress and stops when cancelled, without extracting', async ({ page }) => {
    test.setTimeout(90000);
    const consoleLogs = setupTestConsoleCapture(page);
    const stopErrorMonitoring = setupErrorFailure(consoleLogs, ALLOWED_ERROR_PATTERNS);
    try {
      const mocks = await mockRoutes(page);
      await standInOcrJobs(page, '**/api/v1/ocr', () => ({ steps: 100, delay_ms: 300, phase: 'Recognizing text', unit: 'page' }));
      await navigateAndLogin(page, 'testreviewer', 'reviewerpass');
      await startExtractionWithOcr(page, consoleLogs);

      const widget = jobWidget(page, await submittedJobId(consoleLogs));
      await expect(widget).toContainText('Recognizing text', { timeout: 20000 });
      // no blocking spinner and no widget of the extraction while the job runs
      expect(await page.evaluate(() => /** @type {any} */(window).ui.spinner.container.classList.contains('hidden'))).toBe(true);
      await expect(page.locator('.progress-widget[data-progress-id^="ocr-extraction-"]')).toHaveCount(0);

      await widget.locator('[data-name="cancelBtn"]').click();
      await waitForTestMessage(consoleLogs, 'OCR_CANCELLED', 15000);
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
      // cancelling during the correction pass keeps the OCR result: the job ends done with
      // `llm_correction_cancelled`, and nothing is extracted
      await standInOcrJobs(page, '**/api/v1/ocr', body => ({
        steps: 100,
        delay_ms: 300,
        phase: 'Correcting OCR errors',
        unit: 'window',
        cancel_result: { stable_id: body.stable_id, source_stable_id: body.stable_id, changed: true, quality: QUALITY, llm_corrections: [], llm_correction_cancelled: true }
      }));
      await navigateAndLogin(page, 'testreviewer', 'reviewerpass');
      await startExtractionWithOcr(page, consoleLogs);

      const widget = jobWidget(page, await submittedJobId(consoleLogs));
      await expect(widget).toContainText('Correcting OCR errors', { timeout: 20000 });
      // the user opens other documents meanwhile, then cancels the correction
      const loadResult = await selectFirstDocuments(page);
      expect(loadResult.success).toBe(true);
      const opened = await page.evaluate(() => /** @type {any} */(window).app.getCurrentState().xml);
      expect(opened).toBeTruthy();
      await widget.locator('[data-name="cancelBtn"]').click();

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

const PROVIDERS = [{
  id: 'mock-provider',
  label: 'Mock Provider',
  models: [{ id: 'mock-model', label: 'Mock Model', capabilities: [], status: { availability: 'available', detail: '' }, free: true }]
}];

/**
 * Mock a default model, log in, open the first documents and start "Correct OCR errors in PDF
 * without review (LLM)", confirming the dialog.
 * @param {Page} page
 * @returns {Promise<{pdf: string, xml: string}>} The open documents
 */
async function startCorrection(page) {
  await page.route('**/api/v1/llm/providers', route => route.fulfill({ json: PROVIDERS }));
  await page.route('**/api/v1/llm/default-model', route => route.fulfill({ json: { provider_id: 'mock-provider', model_id: 'mock-model' } }));
  await navigateAndLogin(page, 'testreviewer', 'reviewerpass');
  await page.evaluate(() => /** @type {any} */(window).app.getDependency('inference-settings')._refresh());
  const loadResult = await selectFirstDocuments(page);
  expect(loadResult.success).toBe(true);
  const shown = await page.evaluate(() => {
    const state = /** @type {any} */(window).app.getCurrentState();
    return { pdf: state.pdf, xml: state.xml };
  });
  page.evaluate(() => /** @type {any} */(window).app.getDependency('ocr-correction').run()).catch(() => {});
  const dialog = page.locator('sl-dialog[name="dialog"]');
  await expect(dialog).toContainText('Correct the OCR errors in the text layer of the PDF using Mock Provider');
  await page.waitForTimeout(500);
  await page.evaluate(() => /** @type {any} */(window).ui.dialog.confirmBtn.click());
  return shown;
}

test.describe('Correct OCR errors in PDF without review (LLM)', () => {
  test('corrects the open PDF in the background and loads it again', async ({ page }) => {
    test.setTimeout(90000);
    const consoleLogs = setupTestConsoleCapture(page);
    const stopErrorMonitoring = setupErrorFailure(consoleLogs, ALLOWED_ERROR_PATTERNS);
    try {
      // the corrected PDF is a new PDF of the document (#944); the stand-in returns the open PDF
      const { requests } = await standInOcrJobs(page, '**/api/v1/ocr/llm-correction', body => ({
        steps: 3,
        delay_ms: 1000,
        phase: 'Correcting OCR errors',
        unit: 'window',
        result: { stable_id: body.stable_id, source_stable_id: body.stable_id, changed: true, quality: QUALITY, llm_corrections: [{ page: 1, old: '1O', new: '10', rationale: 'footnote number' }], message: 'Corrected 1 OCR error with mock-model.' }
      }));
      const { pdf } = await startCorrection(page);
      const widget = jobWidget(page, await submittedJobId(consoleLogs));
      await expect(widget).toContainText('Correcting OCR errors', { timeout: 15000 });

      const completed = await waitForTestMessage(consoleLogs, 'OCR_CORRECTION_COMPLETED', 20000);
      expect(completed.value).toEqual({ stableId: pdf, changed: true, corrections: 1 });
      expect(requests).toEqual([{ stable_id: pdf, provider_id: 'mock-provider', model_id: 'mock-model' }]);
      await expect(page.locator('sl-alert', { hasText: '“1O” → “10”' })).toBeVisible();
      // the same documents are open: the corrected PDF is loaded without asking, without a version
      // (none is attached to it yet)
      const finished = await waitForTestMessage(consoleLogs, 'BACKGROUND_PROCESS_FINISHED', 10000);
      expect(finished.value.unchanged).toBe(true);
      await expect(widget).toHaveCount(0);
      await expect.poll(() => page.evaluate(() => {
        const state = /** @type {any} */(window).app.getCurrentState();
        return { pdf: state.pdf, xml: state.xml };
      })).toEqual({ pdf, xml: null });
    } finally {
      stopErrorMonitoring();
      await releaseAllLocks(page);
      await performLogout(page);
    }
  });

  test('stops when cancelled and leaves the PDF unchanged', async ({ page }) => {
    test.setTimeout(90000);
    const consoleLogs = setupTestConsoleCapture(page);
    const stopErrorMonitoring = setupErrorFailure(consoleLogs, ALLOWED_ERROR_PATTERNS);
    try {
      await standInOcrJobs(page, '**/api/v1/ocr/llm-correction', () => ({ steps: 100, delay_ms: 300, phase: 'Correcting OCR errors', unit: 'window' }));
      await startCorrection(page);
      const widget = jobWidget(page, await submittedJobId(consoleLogs));
      await expect(widget).toContainText('Correcting OCR errors', { timeout: 15000 });
      await widget.locator('[data-name="cancelBtn"]').click();
      await waitForTestMessage(consoleLogs, 'OCR_CANCELLED', 15000);
      await expect(widget).toHaveCount(0);
      await expect(page.locator('sl-alert', { hasText: 'The correction was cancelled. The PDF is unchanged.' })).toBeVisible();
    } finally {
      stopErrorMonitoring();
      await releaseAllLocks(page);
      await performLogout(page);
    }
  });
});
