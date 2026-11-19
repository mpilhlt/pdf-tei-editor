/**
 * Text recognition (OCR) option of the extraction dialog: a scanned PDF without text layer
 * forces the option, the OCR options dialog offers the engine's languages, and OCR gives
 * the PDF a text layer.
 *
 * Requires an available OCR engine (Tesseract installed); skipped otherwise.
 *
 * @testCovers app/src/plugins/ocr.js
 * @testCovers app/src/plugins/extraction.js
 * @testCovers app/src/modules/language-chooser.js
 * @testCovers fastapi_app/routers/ocr.py
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

      // Applying OCR gives the PDF a text layer and keeps its stable_id
      const result = await page.evaluate(async ({ id, engine }) => {
        return /** @type {any} */(window).client.apiClient.ocr({ stable_id: id, engine, languages: ['en'] });
      }, { id: stableId, engine: engines[0].id });
      expect(result.stable_id).toBe(stableId);
      expect(result.changed).toBe(true);
      expect(result.quality.status).toBe('good');
      expect(result.quality.ocr_applied.languages).toEqual(['en']);
    } finally {
      await releaseAllLocks(page);
      await performLogout(page);
      stopErrorMonitoring();
    }
  });
});
