/**
 * File selection restore end-to-end tests
 *
 * After a reload, the "Source File" and "Target XML" selectboxes must show the document from the URL
 * hash, also when the collection filter restored from the session does not contain that document.
 *
 * @testCovers app/src/plugins/services.js
 * @testCovers app/src/plugins/file-selection.js
 */

import { test, expect } from '../fixtures/debug-on-failure.js';
import { setupTestConsoleCapture, setupErrorFailure } from './helpers/test-logging.js';
import { navigateAndLogin, performLogout, releaseAllLocks } from './helpers/login-helper.js';
import { selectFirstDocuments } from './helpers/extraction-helper.js';

const ALLOWED_ERROR_PATTERNS = [
  'Failed to load resource.*401.*UNAUTHORIZED',
  'Failed to load resource.*400.*BAD REQUEST',
  'Failed to load autocomplete data.*No schema location found',
  'api/validate/autocomplete-data.*400.*BAD REQUEST',
  'Failed to load resource.*423.*LOCKED'
];

test.describe('File selection restore', () => {

  test('shows the loaded document after a reload with a collection filter that excludes it', async ({ page }) => {
    const consoleLogs = setupTestConsoleCapture(page);
    const stopErrorMonitoring = setupErrorFailure(consoleLogs, ALLOWED_ERROR_PATTERNS);

    try {
      await navigateAndLogin(page, 'testannotator', 'annotatorpass');
      const loadResult = await selectFirstDocuments(page);
      expect(loadResult.success).toBe(true);

      // a collection filter that does not contain the loaded document, as left over in the session
      // from another tab or an earlier selection
      const { pdf, xml, docCollections } = await page.evaluate(async () => {
        const app = (/** @type {any} */ (window)).app;
        const fileSelection = app.getDependency('file-selection');
        const state = fileSelection.state;
        const file = state.fileData.find((/** @type {any} */ f) => f.source?.id === state.pdf);
        await fileSelection.dispatchStateChange({ collectionFilter: '__no_such_collection__' });
        return { pdf: state.pdf, xml: state.xml, docCollections: file.collections };
      });
      expect(pdf).toBeTruthy();
      expect(xml).toBeTruthy();

      await page.reload();

      const pdfSelect = page.locator('sl-select[name="pdf"]');
      const xmlSelect = page.locator('sl-select[name="xml"]');
      await expect(pdfSelect.locator(`sl-option[value="${pdf}"]`)).toBeAttached({ timeout: 20000 });
      await expect(xmlSelect.locator(`sl-option[value="${xml}"]`)).toBeAttached();
      expect(await pdfSelect.evaluate(el => /** @type {any} */ (el).value)).toBe(pdf);
      expect(await xmlSelect.evaluate(el => /** @type {any} */ (el).value)).toBe(xml);
      const collectionFilter = await page.evaluate(() => (/** @type {any} */ (window)).app.getDependency('file-selection').state.collectionFilter);
      expect(docCollections).toContain(collectionFilter);
    } finally {
      stopErrorMonitoring();
      await releaseAllLocks(page);
      await performLogout(page);
    }
  });
});
