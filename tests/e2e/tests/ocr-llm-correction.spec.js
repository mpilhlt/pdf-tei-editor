/**
 * Option "Correct OCR errors with a language model" of the OCR dialog: the request carries the
 * option and the default model, the corrections made are reported, and without a default model
 * the option is disabled. The LLM and OCR routes are mocked (the real run needs an OCR engine and
 * an LLM provider and is covered by the backend tests).
 *
 * @testCovers app/src/plugins/ocr.js
 * @testCovers app/src/templates/ocr-dialog.html
 */

import { test, expect } from '../fixtures/debug-on-failure.js';
import { setupTestConsoleCapture, waitForTestMessage, setupErrorFailure } from './helpers/test-logging.js';
import { navigateAndLogin, performLogout, releaseAllLocks } from './helpers/login-helper.js';

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

const PROVIDERS = [{
  id: 'mock-provider',
  label: 'Mock Provider',
  models: [{ id: 'mock-model', label: 'Mock Model', capabilities: [], status: { availability: 'available', detail: '' }, free: true }]
}];

const CORRECTIONS = [
  { page: 3, old: '1O', new: '10', rationale: 'footnote number' },
  { page: 5, old: 'l2', new: '12', rationale: 'footnote number' }
];

const SCANNED_PDF = 'tests/e2e/fixtures/pdf/scanned-document.pdf';

const CHECKBOX = 'sl-dialog[name="ocrOptionsDialog"] sl-checkbox[name="llmCorrection"]';

/**
 * Mock the model routes, then log in and make the inference settings load them.
 * @param {import('@playwright/test').Page} page
 * @param {boolean} withDefault - Whether a default model is configured
 * @param {boolean} [withEngine] - Mock the OCR engine list, so that the extraction dialog offers text recognition
 */
async function setUp(page, withDefault, withEngine = false) {
  if (withEngine) await page.route('**/api/v1/ocr/engines', route => route.fulfill({ json: [ENGINE] }));
  await page.route('**/api/v1/llm/providers', route => route.fulfill({ json: PROVIDERS }));
  await page.route('**/api/v1/llm/default-model', route => route.fulfill({
    json: withDefault ? { provider_id: 'mock-provider', model_id: 'mock-model' } : null
  }));
  await navigateAndLogin(page, 'testreviewer', 'reviewerpass');
  await page.evaluate(() => /** @type {any} */(window).app.getDependency('inference-settings')._refresh());
}

/**
 * Open the OCR dialog for the mock engine without waiting for it to close.
 * @param {import('@playwright/test').Page} page
 */
function openDialog(page) {
  page.evaluate((engine) => {
    const ocr = /** @type {any} */(window).app.getDependency('ocr');
    return ocr.configure(engine, ocr.getSettings(engine)).then((/** @type {any} */ s) => { /** @type {any} */(window).__ocrSettings = s; });
  }, ENGINE).catch(() => {});
}

test.describe('OCR dialog: LLM correction', () => {
  test('sends the option and the default model, and reports the corrections', async ({ page }) => {
    test.setTimeout(60000);
    const consoleLogs = setupTestConsoleCapture(page);
    const stopErrorMonitoring = setupErrorFailure(consoleLogs, ALLOWED_ERROR_PATTERNS);
    try {
      /** @type {any} */
      let requestBody = null;
      await page.route('**/api/v1/ocr', async route => {
        if (route.request().method() !== 'POST') return route.fallback();
        requestBody = route.request().postDataJSON();
        await route.fulfill({ json: { job_id: 'job-1', stable_id: 'abc', status: 'queued', username: 'x', pid: 1, created_at: '2026-01-01T00:00:00', updated_at: '2026-01-01T00:00:00' } });
      });
      await page.route('**/api/v1/ocr/jobs/*', route => route.fulfill({
        json: {
          job_id: 'job-1', stable_id: 'abc', status: 'done', username: 'x', pid: 1, created_at: '2026-01-01T00:00:00', updated_at: '2026-01-01T00:00:01',
          result: { stable_id: 'abc', changed: true, quality: { status: 'good', summary: 'ok', reasons: [] }, llm_corrections: CORRECTIONS }
        }
      }));
      await setUp(page, true);

      openDialog(page);
      await waitForTestMessage(consoleLogs, 'OCR_DIALOG_OPENED', 10000);
      await page.waitForTimeout(500);
      const state = await page.evaluate((selector) => {
        const box = /** @type {any} */(document.querySelector(selector));
        return { disabled: box.disabled, help: box.getAttribute('help-text') };
      }, CHECKBOX);
      expect(state.disabled).toBe(false);
      expect(state.help).toContain('Mock Provider/Mock Model');
      await page.locator(CHECKBOX).click({ position: { x: 8, y: 8 } });
      await expect.poll(() => page.evaluate((s) => /** @type {any} */(document.querySelector(s)).checked, CHECKBOX)).toBe(true);
      await page.locator('sl-dialog[name="ocrOptionsDialog"] sl-button[name="submit"]').click();
      await waitForTestMessage(consoleLogs, 'OCR_OPTIONS_SAVED', 10000);
      await page.waitForFunction(() => /** @type {any} */(window).__ocrSettings);
      const settings = await page.evaluate(() => /** @type {any} */(window).__ocrSettings);
      expect(settings.llmCorrection).toBe(true);

      await page.evaluate((settings) => /** @type {any} */(window).app.getDependency('ocr')
        .recognize('abc', { engine: 'mock-engine', ...settings, rebuild: true }), settings);

      expect(requestBody.llm_correction).toBe(true);
      expect(requestBody.provider_id).toBe('mock-provider');
      expect(requestBody.model_id).toBe('mock-model');
      const logged = await waitForTestMessage(consoleLogs, 'OCR_LLM_CORRECTION', 10000);
      expect(logged.value).toEqual({ requested: true, corrections: 2, error: null });
      await expect(page.locator('sl-alert', { hasText: '“1O” → “10”' })).toBeVisible();

      // the choice is remembered
      const remembered = await page.evaluate((engine) => {
        const ocr = /** @type {any} */(window).app.getDependency('ocr');
        const value = ocr.getSettings(engine).llmCorrection;
        ocr.uiStorage.set('llmCorrection', false);
        return value;
      }, ENGINE);
      expect(remembered).toBe(true);
    } finally {
      stopErrorMonitoring();
      await performLogout(page);
    }
  });

  test('disables the option without a default model', async ({ page }) => {
    test.setTimeout(60000);
    const consoleLogs = setupTestConsoleCapture(page);
    const stopErrorMonitoring = setupErrorFailure(consoleLogs, ALLOWED_ERROR_PATTERNS);
    try {
      await setUp(page, false);
      await page.evaluate(() => /** @type {any} */(window).app.getDependency('ocr').uiStorage.set('llmCorrection', true));
      openDialog(page);
      await waitForTestMessage(consoleLogs, 'OCR_DIALOG_OPENED', 10000);
      const state = await page.evaluate((selector) => {
        const box = /** @type {any} */(document.querySelector(selector));
        return { disabled: box.disabled, checked: box.checked, title: box.title };
      }, CHECKBOX);
      expect(state).toEqual({ disabled: true, checked: false, title: 'Select a default model in Tools > Inference first.' });
      await page.waitForTimeout(500);
      await page.locator('sl-dialog[name="ocrOptionsDialog"] sl-button[name="cancel"]').click();
      await page.evaluate(() => /** @type {any} */(window).app.getDependency('ocr').uiStorage.set('llmCorrection', false));
    } finally {
      stopErrorMonitoring();
      await performLogout(page);
    }
  });

  test('the extraction dialog shows that the remembered option is on', async ({ page }) => {
    test.setTimeout(60000);
    const consoleLogs = setupTestConsoleCapture(page);
    const stopErrorMonitoring = setupErrorFailure(consoleLogs, [...ALLOWED_ERROR_PATTERNS, 'User cancelled the dialog']);
    const note = () => page.evaluate(() => {
      const section = /** @type {any} */(window).ui.extractionOptions.ocrSection;
      return { visible: section.llmNote.style.display !== 'none', text: section.llmNote.textContent };
    });
    try {
      await setUp(page, true, true);
      const fileChooserPromise = page.waitForEvent('filechooser');
      await page.evaluate(() => /** @type {any} */(window).ui.toolbar.extractionActions.extractNew.click());
      await (await fileChooserPromise).setFiles(SCANNED_PDF);
      await waitForTestMessage(consoleLogs, 'PDF_UPLOAD_COMPLETED', 15000);
      await waitForTestMessage(consoleLogs, 'EXTRACTION_OPTIONS_DIALOG_STARTING', 10000);
      await expect.poll(() => page.evaluate(() => /** @type {any} */(window).ui.extractionOptions.ocrSection.style.display)).not.toBe('none');

      // off by default
      expect((await note()).visible).toBe(false);

      // turn the option on in the OCR dialog
      await page.waitForTimeout(500);
      await page.evaluate(() => /** @type {any} */(window).ui.extractionOptions.ocrSection.configureOcr.click());
      await waitForTestMessage(consoleLogs, 'OCR_DIALOG_OPENED', 10000);
      await page.waitForTimeout(500);
      await page.locator(CHECKBOX).click({ position: { x: 8, y: 8 } });
      await page.locator('sl-dialog[name="ocrOptionsDialog"] sl-button[name="submit"]').click();
      await expect.poll(note).toEqual({ visible: true, text: 'LLM correction of OCR errors is on (Mock Provider/Mock Model).' });

      // turn it off again
      await page.waitForTimeout(1000);
      await page.evaluate(() => /** @type {any} */(window).ui.extractionOptions.ocrSection.configureOcr.click());
      await page.waitForTimeout(1000);
      await page.locator(CHECKBOX).click({ position: { x: 8, y: 8 } });
      await page.locator('sl-dialog[name="ocrOptionsDialog"] sl-button[name="submit"]').click();
      await expect.poll(async () => (await note()).visible).toBe(false);

      await page.waitForTimeout(500);
      await page.evaluate(() => /** @type {any} */(window).ui.extractionOptions.cancel.click());
    } finally {
      stopErrorMonitoring();
      await releaseAllLocks(page);
      await performLogout(page);
    }
  });
});
