/**
 * The XML editor keeps a loaded document (#893).
 *
 * While `services.load()` runs, `state.xml` is null: it is only set after the editor has loaded the
 * document. State changes of other plugins in that window (e.g. the xpath navigation selecting the
 * stored xpath of the variant once the document is loaded) must not clear the editor.
 *
 * @testCovers app/src/plugins/xmleditor.js
 * @testCovers app/src/plugins/services.js
 * @testCovers app/src/plugins/start.js
 */

import { test, expect } from '../fixtures/debug-on-failure.js';
import { setupTestConsoleCapture, setupErrorFailure, waitForTestMessage } from './helpers/test-logging.js';
import { navigateAndLogin, performLogout, releaseAllLocks } from './helpers/login-helper.js';
import { selectFirstDocuments } from './helpers/extraction-helper.js';

const ALLOWED_ERROR_PATTERNS = [
  'Failed to load resource.*401.*UNAUTHORIZED',
  'Failed to load autocomplete data.*No schema location found',
  'api/validate/autocomplete-data.*400.*BAD REQUEST',
  'offsetParent is not set.*cannot scroll',
];

test.describe('XML editor keeps a loaded document', () => {

  test('a state change while the document loads does not clear the editor', async ({ page }) => {
    const consoleLogs = setupTestConsoleCapture(page);
    const stopErrorMonitoring = setupErrorFailure(consoleLogs, ALLOWED_ERROR_PATTERNS);

    try {
      await navigateAndLogin(page, 'testreviewer', 'reviewerpass');
      const loadResult = await selectFirstDocuments(page);
      expect(loadResult.success).toBe(true);

      const result = await page.evaluate(async () => {
        const win = /** @type {any} */ (window);
        const xml = win.app.getCurrentState().xml;
        const xmlEditor = win.app.getDependency('xmleditor');
        let stateDuringLoad;
        // like the xpath navigation does when it selects the stored xpath of the variant
        xmlEditor.once('editorAfterLoad', async () => {
          stateDuringLoad = win.app.getCurrentState().xml;
          await win.app.updateState({ xpath: '(//tei:text//tei:p)[1]' });
        });
        await win.app.getDependency('services').load({ xml });
        return {
          xml,
          stateDuringLoad,
          stateXml: win.app.getCurrentState().xml,
          length: xmlEditor.getView().state.doc.length
        };
      });
      expect(result.stateDuringLoad).toBeNull();
      expect(result.stateXml).toBe(result.xml);
      expect(result.length).toBeGreaterThan(0);
    } finally {
      stopErrorMonitoring();
      await releaseAllLocks(page);
      await performLogout(page);
    }
  });

  test('the reloaded page shows the content of the open document', async ({ page }) => {
    const consoleLogs = setupTestConsoleCapture(page);
    const stopErrorMonitoring = setupErrorFailure(consoleLogs, ALLOWED_ERROR_PATTERNS);

    try {
      await navigateAndLogin(page, 'testreviewer', 'reviewerpass');
      const loadResult = await selectFirstDocuments(page);
      expect(loadResult.success).toBe(true);
      const xml = await page.evaluate(() => /** @type {any} */ (window).app.getCurrentState().xml);
      expect(xml).toBeTruthy();

      consoleLogs.length = 0;
      await page.reload({ waitUntil: 'commit' });
      await waitForTestMessage(consoleLogs, 'APP_START_COMPLETED', 30000);
      const after = await page.evaluate(() => {
        const win = /** @type {any} */ (window);
        return {
          xml: win.app.getCurrentState().xml,
          length: win.app.getDependency('xmleditor').getView().state.doc.length
        };
      });
      expect(after.xml).toBe(xml);
      expect(after.length).toBeGreaterThan(0);
    } finally {
      stopErrorMonitoring();
      await releaseAllLocks(page);
      await performLogout(page);
    }
  });
});
