/**
 * Text recognition (OCR) option of the extraction dialog: a placeholder is shown until the
 * engines are loaded, a scanned PDF without text layer forces the option, the OCR options dialog offers the engine's languages, and OCR gives
 * the PDF a text layer.
 *
 * Requires an available OCR engine (Tesseract installed); skipped otherwise.
 *
 * @testCovers app/src/plugins/ocr.js
 * @testCovers app/src/plugins/extraction.js
 * @testCovers app/src/modules/language-chooser.js
 * @testCovers fastapi_app/routers/ocr.py
 * @testCovers fastapi_app/lib/extraction/job_types.py
 */

/** @import { namedElementsTree } from '../../../app/src/ui.js' */

import { test, expect } from '../fixtures/debug-on-failure.js';
import { setupTestConsoleCapture, waitForTestMessage, setupErrorFailure } from './helpers/test-logging.js';
import { navigateAndLogin, performLogout, releaseAllLocks } from './helpers/login-helper.js';

const SCANNED_PDF = 'tests/e2e/fixtures/pdf/scanned-document.pdf';

test.describe('OCR extraction option', () => {
  test('forces text recognition for a PDF without text layer', async ({ page }) => {
    test.setTimeout(90000);
    const consoleLogs = setupTestConsoleCapture(page);
    const stopErrorMonitoring = setupErrorFailure(consoleLogs, [
      'Failed to load resource.*401.*UNAUTHORIZED',
      'User cancelled the dialog' // logged by ExtractionPlugin when the dialog is cancelled
    ]);

    try {
      await navigateAndLogin(page, 'testreviewer', 'reviewerpass');

      const engines = await page.evaluate(() => /** @type {any} */(window).client.apiClient.ocrEngines());
      test.skip(engines.length === 0, 'No OCR engine available (Tesseract not installed)');

      // Upload the scanned PDF, which opens the extraction dialog
      const fileChooserPromise = page.waitForEvent('filechooser');
      await page.evaluate(() => {
        /** @type {namedElementsTree} */
        const ui = /** @type {any} */(window).ui;
        ui.toolbar.extractionActions.extractNew.click();
      });
      await (await fileChooserPromise).setFiles(SCANNED_PDF);
      const upload = await waitForTestMessage(consoleLogs, 'PDF_UPLOAD_COMPLETED', 15000);
      const stableId = upload.value.filename;
      await waitForTestMessage(consoleLogs, 'EXTRACTION_OPTIONS_DIALOG_STARTING', 10000);

      const quality = await waitForTestMessage(consoleLogs, 'OCR_TEXT_QUALITY', 15000);
      // Without a text layer, the comparison with the page images is not requested
      expect(quality.value).toEqual({ stableId, status: 'missing', layout: false, layoutChecked: false });

      // No text layer: the option is checked and cannot be unchecked
      await expect.poll(() => page.evaluate(() => {
        /** @type {namedElementsTree} */
        const ui = /** @type {any} */(window).ui;
        const section = ui.extractionOptions.ocrSection;
        return {
          visible: section.style.display !== 'none',
          checked: section.applyOcr.checked,
          disabled: section.applyOcr.disabled,
          engine: section.ocrEngine.value,
          status: section.textQuality.dataset.status
        };
      })).toEqual({ visible: true, checked: true, disabled: true, engine: engines[0].id, status: 'missing' });

      // The OCR options dialog offers the engine's languages
      await page.waitForTimeout(500);
      await page.evaluate(() => {
        /** @type {namedElementsTree} */
        const ui = /** @type {any} */(window).ui;
        ui.extractionOptions.ocrSection.configureOcr.click();
      });
      const opened = await waitForTestMessage(consoleLogs, 'OCR_DIALOG_OPENED', 10000);
      expect(opened.value.languages.length).toBeGreaterThan(0);

      // The OCR dialog is shown on top of the extraction dialog
      await page.waitForTimeout(500);
      const topmostDialog = await page.evaluate(() => {
        const element = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2);
        return element?.closest('sl-dialog')?.getAttribute('name');
      });
      expect(topmostDialog).toBe('ocrOptionsDialog');
      const offered = await page.evaluate(() => {
        /** @type {namedElementsTree} */
        const ui = /** @type {any} */(window).ui;
        return Array.from(ui.ocrOptionsDialog.languages.querySelectorAll('sl-option')).map(o => /** @type {any} */(o).value);
      });
      expect(offered.sort()).toEqual([...engines[0].languages].sort());

      await page.waitForTimeout(500);
      await page.evaluate(() => {
        /** @type {namedElementsTree} */
        const ui = /** @type {any} */(window).ui;
        ui.ocrOptionsDialog.languages.value = ['en'];
        ui.ocrOptionsDialog.submit.click();
      });
      const saved = await waitForTestMessage(consoleLogs, 'OCR_OPTIONS_SAVED', 10000);
      expect(saved.value.languages).toEqual(['en']);

      // Close the extraction dialog without extracting
      await page.waitForTimeout(500);
      await page.evaluate(() => {
        /** @type {namedElementsTree} */
        const ui = /** @type {any} */(window).ui;
        ui.extractionOptions.cancel.click();
      });

      // Applying OCR stores a new PDF of the document with a text layer (#944); the source is
      // not changed. OCR runs as a job of type `ocr`.
      const job = await page.evaluate(async ({ id, engine }) => {
        const apiClient = /** @type {any} */(window).client.apiClient;
        let job = await apiClient.ocr({ stable_id: id, engine, languages: ['en'] });
        while (job.status === 'queued' || job.status === 'active') {
          await new Promise(resolve => setTimeout(resolve, 500));
          job = await apiClient.jobsGet(job.id);
        }
        return job;
      }, { id: stableId, engine: engines[0].id });
      expect(job.type).toBe('ocr');
      expect(job.status, job.error?.message).toBe('done');
      const result = job.result;
      expect(result.source_stable_id).toBe(stableId);
      expect(result.stable_id).not.toBe(stableId);
      expect(result.changed).toBe(true);
      expect(result.quality.status).toBe('good');
      expect(result.quality.ocr_applied.languages).toEqual(['en']);

      // An extraction job with text recognition as its first step: OCR runs under the lock of
      // the PDF that the extraction job holds, and the extraction extracts from the new PDF
      const extractJob = await page.evaluate(async ({ id, engine }) => {
        const apiClient = /** @type {any} */(window).client.apiClient;
        let job = await apiClient.extractJob({ extractor: 'mock-extractor', file_id: id, options: {}, ocr: { stable_id: id, engine, languages: ['en'] } });
        while (job.status === 'queued' || job.status === 'active') {
          await new Promise(resolve => setTimeout(resolve, 500));
          job = await apiClient.jobsGet(job.id);
        }
        return job;
      }, { id: stableId, engine: engines[0].id });
      expect(extractJob.type).toBe('extract');
      expect(extractJob.status, extractJob.error?.message).toBe('done');
      expect(extractJob.result.ocr.source_stable_id).toBe(stableId);
      expect(extractJob.result.pdf).toBe(extractJob.result.ocr.stable_id);
      expect(extractJob.result.xml).toBeTruthy();
      expect(extractJob.result.cancelled).toBe(false);
    } finally {
      await releaseAllLocks(page);
      await performLogout(page);
      stopErrorMonitoring();
    }
  });

  test('does not start text recognition if the extractor is not ready', async ({ page }) => {
    const consoleLogs = setupTestConsoleCapture(page);
    const stopErrorMonitoring = setupErrorFailure(consoleLogs, [
      'Failed to load resource.*401.*UNAUTHORIZED',
      'cannot be used at the moment' // logged by ExtractionPlugin with the error
    ]);
    // The extractor's service is down
    await page.route('**/api/v1/extract/check', route => route.fulfill({
      json: { ready: false, message: 'The extraction service is not reachable' }
    }));
    // text recognition is the first step of the extraction job, or a job of its own
    let ocrStarted = false;
    for (const url of ['**/api/v1/ocr', '**/api/v1/extract/job']) {
      await page.route(url, route => {
        ocrStarted = true;
        return route.continue();
      });
    }

    try {
      await navigateAndLogin(page, 'testreviewer', 'reviewerpass');
      const engines = await page.evaluate(() => /** @type {any} */(window).client.apiClient.ocrEngines());
      test.skip(engines.length === 0, 'No OCR engine available (Tesseract not installed)');

      const fileChooserPromise = page.waitForEvent('filechooser');
      await page.evaluate(() => {
        /** @type {namedElementsTree} */
        const ui = /** @type {any} */(window).ui;
        ui.toolbar.extractionActions.extractNew.click();
      });
      await (await fileChooserPromise).setFiles(SCANNED_PDF);
      await waitForTestMessage(consoleLogs, 'EXTRACTION_OPTIONS_DIALOG_STARTING', 15000);
      // Without a text layer, text recognition is forced
      await expect.poll(() => page.evaluate(() => {
        /** @type {namedElementsTree} */
        const ui = /** @type {any} */(window).ui;
        return ui.extractionOptions.ocrSection.applyOcr.checked;
      })).toBe(true);

      await page.waitForTimeout(500);
      await page.evaluate(() => {
        /** @type {namedElementsTree} */
        const ui = /** @type {any} */(window).ui;
        ui.extractionOptions.submit.click();
      });
      const checked = await waitForTestMessage(consoleLogs, 'EXTRACTOR_CHECKED', 10000);
      expect(checked.value.ready).toBe(false);
      const errorDialog = page.locator('sl-dialog[name="dialog"]');
      await expect(errorDialog).toContainText('The extraction service is not reachable');
      expect(ocrStarted).toBe(false);

      await page.waitForTimeout(500);
      await page.keyboard.press('Escape');
    } finally {
      await releaseAllLocks(page);
      await performLogout(page);
      stopErrorMonitoring();
    }
  });

  test('shows a placeholder until the OCR engines are loaded', async ({ page }) => {
    const consoleLogs = setupTestConsoleCapture(page);
    const stopErrorMonitoring = setupErrorFailure(consoleLogs, [
      'Failed to load resource.*401.*UNAUTHORIZED',
      'User cancelled the dialog'
    ]);
    // Hold the engine list back, which the OCR plugin requests after login
    /** @type {() => void} */
    let releaseEngines = () => {};
    const enginesReleased = new Promise(resolve => { releaseEngines = () => resolve(undefined); });
    await page.route('**/api/v1/ocr/engines', async route => {
      await enginesReleased;
      await route.continue();
    });

    /** @returns {Promise<{loading: boolean, section: boolean}>} */
    const visibility = () => page.evaluate(() => {
      /** @type {namedElementsTree} */
      const ui = /** @type {any} */(window).ui;
      return {
        loading: ui.extractionOptions.ocrLoading.style.display !== 'none',
        section: ui.extractionOptions.ocrSection.style.display !== 'none'
      };
    });

    try {
      await navigateAndLogin(page, 'testreviewer', 'reviewerpass');
      const fileChooserPromise = page.waitForEvent('filechooser');
      await page.evaluate(() => {
        /** @type {namedElementsTree} */
        const ui = /** @type {any} */(window).ui;
        ui.toolbar.extractionActions.extractNew.click();
      });
      await (await fileChooserPromise).setFiles(SCANNED_PDF);
      await waitForTestMessage(consoleLogs, 'EXTRACTION_OPTIONS_DIALOG_STARTING', 15000);

      await expect.poll(visibility).toEqual({ loading: true, section: false });
      if (process.env.E2E_SCREENSHOT_DIR) {
        await page.screenshot({ path: `${process.env.E2E_SCREENSHOT_DIR}/ocr-options-loading.png` });
      }

      releaseEngines();
      const engines = await page.evaluate(() => /** @type {any} */(window).client.apiClient.ocrEngines());
      // The placeholder is replaced by the options, or removed if no engine is available
      await expect.poll(visibility).toEqual({ loading: false, section: engines.length > 0 });

      await page.waitForTimeout(500);
      await page.evaluate(() => {
        /** @type {namedElementsTree} */
        const ui = /** @type {any} */(window).ui;
        ui.extractionOptions.cancel.click();
      });
    } finally {
      releaseEngines();
      await releaseAllLocks(page);
      await performLogout(page);
      stopErrorMonitoring();
    }
  });
});
