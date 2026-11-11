/**
 * Document lock across a page reload.
 *
 * After a reload, the page acquires the lock of the restored document again under the same
 * session. The heartbeat must not release that lock when the start plugin starts it, otherwise
 * the editor is editable while the server holds no lock (#742).
 *
 * @testCovers app/src/plugins/heartbeat.js
 * @testCovers app/src/plugins/start.js
 * @testCovers app/src/plugins/services.js
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

test.describe('Document lock across a reload', () => {

  test('the reloaded page keeps the lock of the open document', async ({ page }) => {
    const consoleLogs = setupTestConsoleCapture(page);
    const stopErrorMonitoring = setupErrorFailure(consoleLogs, ALLOWED_ERROR_PATTERNS);
    /** @type {string[]} */
    const releasedAfterReload = [];
    let reloaded = false;
    page.on('request', request => {
      if (reloaded && request.url().endsWith('/files/release_lock')) {
        releasedAfterReload.push(request.postData() || '');
      }
    });

    try {
      await navigateAndLogin(page, 'testreviewer', 'reviewerpass');
      const loadResult = await selectFirstDocuments(page);
      expect(loadResult.success).toBe(true);

      const before = await page.evaluate(() => {
        const state = /** @type {any} */ (window).app.getCurrentState();
        return { xml: state.xml, readOnly: state.editorReadOnly, sessionId: state.sessionId };
      });
      expect(before.readOnly).toBe(false);

      // Only look at the messages and requests of the reloaded page. The unloading page sends
      // its release requests before the navigation commits.
      consoleLogs.length = 0;
      await page.reload({ waitUntil: 'commit' });
      reloaded = true;
      await waitForTestMessage(consoleLogs, 'APP_START_COMPLETED', 30000);

      const after = await page.evaluate(async () => {
        const win = /** @type {any} */ (window);
        const state = win.app.getCurrentState();
        const locks = await win.client.apiClient.filesLocks();
        return { xml: state.xml, readOnly: state.editorReadOnly, sessionId: state.sessionId, locked: locks.locked_files };
      });
      expect(after.sessionId).toBe(before.sessionId);
      expect(after.xml).toBe(before.xml);
      expect(after.readOnly).toBe(false);
      expect(after.locked).toContain(before.xml);
      expect(releasedAfterReload).toEqual([]);

      const lockNotices = consoleLogs.filter(log => /being edited by|open for editing in another window/.test(log.text));
      expect(lockNotices).toEqual([]);
    } finally {
      stopErrorMonitoring();
      await releaseAllLocks(page);
      await performLogout(page);
    }
  });
});
