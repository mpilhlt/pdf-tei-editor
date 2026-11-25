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

import { readFileSync } from 'node:fs';
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

    // The uploaded PDF and the extraction result, deleted at the end
    /** @type {string[]} */
    const created = [];

    try {
      // a reviewer, who may delete the extraction result again
      await navigateAndLogin(page, 'testreviewer', 'reviewerpass');

      const fileChooserPromise = page.waitForEvent('filechooser');
      await page.evaluate(() => {
        /** @type {namedElementsTree} */
        const ui = /** @type {any} */(window).ui;
        ui.toolbar.extractionActions.extractNew.click();
      });
      // The PDF is the same as that of a fixture document that other tests load; a trailing
      // comment gives it a hash of its own, so that the upload does not change that document
      const buffer = Buffer.concat([readFileSync(PDF), Buffer.from(`\n% ${Date.now()}\n`)]);
      await (await fileChooserPromise).setFiles({ name: 'language-conflict.pdf', mimeType: 'application/pdf', buffer });
      const upload = await waitForTestMessage(consoleLogs, 'PDF_UPLOAD_COMPLETED', 15000);
      created.push(upload.value.filename);
      await waitForTestMessage(consoleLogs, 'EXTRACTION_OPTIONS_DIALOG_STARTING', 15000);

      await page.waitForTimeout(500);
      await page.evaluate(() => {
        /** @type {namedElementsTree} */
        const ui = /** @type {any} */(window).ui;
        ui.extractionOptions.modelIndex.value = 'mock-extractor';
        ui.extractionOptions.submit.click();
      });
      const extraction = await waitForTestMessage(consoleLogs, 'EXTRACTION_COMPLETED', 30000);
      created.unshift(extraction.value.resultHash);

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
      // the page reacts to the deletion of its open document with failing requests
      stopErrorMonitoring();
      if (created.length) {
        await page.evaluate(async files => {
          await /** @type {any} */(window).client.apiClient.filesDelete({ files });
        }, created);
      }
      await performLogout(page);
    }
  });
});
