/**
 * After an extraction whose declared language (e.g. from CrossRef) contradicts the language
 * detected from the text, the user is asked whether to declare the detected language.
 *
 * The conflict is added to the response of the extraction request, so that any extractor
 * (including the mock extractor) can be used.
 *
 * @testCovers app/src/plugins/extraction.js
 */

/** @import { namedElementsTree } from '../../../app/src/ui.js' */

import { test, expect } from '../fixtures/debug-on-failure.js';
import { setupTestConsoleCapture, waitForTestMessage, setupErrorFailure } from './helpers/test-logging.js';
import { navigateAndLogin, performLogout, releaseAllLocks } from './helpers/login-helper.js';

const PDF = 'tests/e2e/fixtures/pdf/test-document.pdf';

test.describe('Extraction language conflict', () => {
  test('declares the detected language if the user agrees', async ({ page }) => {
    test.setTimeout(60000);
    const consoleLogs = setupTestConsoleCapture(page);
    const stopErrorMonitoring = setupErrorFailure(consoleLogs, [
      'Failed to load resource.*401.*UNAUTHORIZED'
    ]);
    await page.route('**/api/v1/extract', async route => {
      const response = await route.fetch();
      const json = await response.json();
      await route.fulfill({ response, json: { ...json, language_conflict: { declared: 'en', detected: 'de' } } });
    });

    try {
      await navigateAndLogin(page, 'testannotator', 'annotatorpass');

      const fileChooserPromise = page.waitForEvent('filechooser');
      await page.evaluate(() => {
        /** @type {namedElementsTree} */
        const ui = /** @type {any} */(window).ui;
        ui.toolbar.extractionActions.extractNew.click();
      });
      await (await fileChooserPromise).setFiles(PDF);
      await waitForTestMessage(consoleLogs, 'EXTRACTION_OPTIONS_DIALOG_STARTING', 15000);

      await page.waitForTimeout(500);
      await page.evaluate(() => {
        /** @type {namedElementsTree} */
        const ui = /** @type {any} */(window).ui;
        ui.extractionOptions.modelIndex.value = 'mock-extractor';
        ui.extractionOptions.submit.click();
      });
      await waitForTestMessage(consoleLogs, 'EXTRACTION_COMPLETED', 30000);

      const confirmDialog = page.locator('sl-dialog[name="dialog"]');
      await expect(confirmDialog).toHaveAttribute('open', '');
      await expect(confirmDialog).toHaveAttribute('label', 'Document language');
      await expect(confirmDialog).toContainText('as English, but its text reads as German');
      await page.waitForTimeout(500);
      await confirmDialog.locator('sl-button[name="confirmBtn"]').click();

      const resolved = await waitForTestMessage(consoleLogs, 'LANGUAGE_CONFLICT_RESOLVED', 10000);
      expect(resolved.value).toEqual({ declared: 'en', detected: 'de', accepted: true });
      await waitForTestMessage(consoleLogs, 'DOCUMENT_LANGUAGE_CHANGED', 10000);

      const xml = await page.evaluate(() => /** @type {any} */(window).app.getDependency('xmleditor').getXML());
      expect(xml).toMatch(/<langUsage>\s*<language ident="de"\s*\/>/);
    } finally {
      await releaseAllLocks(page);
      await performLogout(page);
      stopErrorMonitoring();
    }
  });
});
