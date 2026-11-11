/**
 * Plugin pages open without the session id in their URL
 *
 * Uses the "open_page" endpoint of the fixture plugin test-plugin
 * (tests/fixtures/plugins/test_plugin/), whose outputUrl is a plugin route that
 * reports the authenticated user.
 *
 * @testCovers app/src/plugins/backend-plugins.js
 * @testCovers app/src/modules/backend-plugin-sandbox.js
 * @testCovers fastapi_app/lib/plugins/plugin_window_auth.py
 */

import { test, expect } from '../fixtures/debug-on-failure.js';
import { setupTestConsoleCapture, setupErrorFailure } from './helpers/test-logging.js';
import { navigateAndLogin, performLogout } from './helpers/login-helper.js';

const TEST_USER = { username: 'testuser', password: 'testpass' };

const ALLOWED_ERROR_PATTERNS = [
  'Failed to load resource.*401' // auth status check before login
];

test.describe('Plugin window authentication', () => {

  test('result dialog and separate window load the plugin page without the session id', async ({ page, context }) => {
    const consoleLogs = setupTestConsoleCapture(page);
    const stopErrorMonitoring = setupErrorFailure(consoleLogs, ALLOWED_ERROR_PATTERNS);

    try {
      await navigateAndLogin(page, TEST_USER.username, TEST_USER.password);

      const pluginRequests = [];
      context.on('request', request => {
        if (request.url().includes('/api/plugins/test-plugin/whoami')) {
          pluginRequests.push(request.url());
        }
      });

      // Opens the result dialog through the url_openable endpoint
      await page.evaluate(() => { window.location.hash = 'plugin=test-plugin/open_page'; });

      const iframeHandle = await page.waitForSelector('sl-dialog[open] iframe');
      const frame = await iframeHandle.contentFrame();
      await expect.poll(() => frame?.url() ?? '').toContain('/api/plugins/test-plugin/whoami?source=dialog');
      expect(frame?.url()).not.toContain('session_id');
      expect(frame?.url()).not.toContain('launch=');
      await expect(frame.locator('body')).toContainText('"username":"testuser"');

      // The separate window gets its own launch token
      const popupPromise = context.waitForEvent('page');
      await page.waitForTimeout(500);
      await page.evaluate(() => {
        const button = document.querySelector('sl-dialog[open] [name="openWindowBtn"]');
        if (!(button instanceof HTMLElement)) throw new Error('Open window button not found');
        button.click();
      });
      const popup = await popupPromise;
      await popup.waitForURL(/\/api\/plugins\/test-plugin\/whoami\?source=dialog$/);
      expect(popup.url()).not.toContain('session_id');
      await expect(popup.locator('body')).toContainText('"username":"testuser"');

      // A reload of the window still works, authenticated by the cookie
      await popup.reload();
      await expect(popup.locator('body')).toContainText('"username":"testuser"');
      await popup.close();

      // The session id never appeared in a plugin page URL
      const sessionId = await page.evaluate(() => /** @type {any} */(window).app.getCurrentState().sessionId);
      expect(sessionId).toBeTruthy();
      expect(pluginRequests.length).toBeGreaterThan(0);
      for (const url of pluginRequests) {
        expect(url).not.toContain('session_id');
        expect(url).not.toContain(sessionId);
      }

      await performLogout(page);
    } finally {
      stopErrorMonitoring();
    }
  });
});
