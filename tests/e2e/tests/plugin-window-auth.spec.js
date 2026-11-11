/**
 * Plugin pages open without the session id in their URL
 *
 * Uses the "open_page" endpoint of the fixture plugin test-plugin
 * (tests/fixtures/plugins/test_plugin/), whose outputUrl is a plugin page that
 * asks a plugin route with fetch() and XMLHttpRequest which user it is
 * authenticated as (window.checkWhoami()).
 *
 * @testCovers app/src/plugins/backend-plugins.js
 * @testCovers app/src/modules/backend-plugin-sandbox.js
 * @testCovers fastapi_app/lib/plugins/plugin_window_auth.py
 * @testCovers fastapi_app/lib/plugins/plugin_tools.py
 */

import { test, expect } from '../fixtures/debug-on-failure.js';
import { setupTestConsoleCapture, setupErrorFailure } from './helpers/test-logging.js';
import { navigateAndLogin, performLogout } from './helpers/login-helper.js';

/**
 * @import { Page, Frame } from '@playwright/test'
 */

const TEST_USER = { username: 'testuser', password: 'testpass' };
const TEST_ADMIN = { username: 'testadmin', password: 'adminpass' };
const PAGE_URL = /\/api\/plugins\/test-plugin\/whoami-page\?source=dialog$/;

const ALLOWED_ERROR_PATTERNS = [
  'Failed to load resource.*401' // auth status check before login
];

/**
 * Open the fixture plugin page in the result dialog and return its frame
 * @param {Page} page
 * @returns {Promise<Frame>}
 */
async function openPluginPage(page) {
  // Opens the result dialog through the url_openable endpoint
  await page.evaluate(() => { window.location.hash = 'plugin=test-plugin/open_page'; });
  const iframeHandle = await page.waitForSelector('sl-dialog[open] iframe');
  const frame = await iframeHandle.contentFrame();
  if (!frame) throw new Error('Plugin iframe has no frame');
  await expect.poll(() => frame.url()).toMatch(PAGE_URL);
  await expect(frame.locator('#result')).not.toBeEmpty();
  return frame;
}

/**
 * Ask the plugin page which user its requests authenticate as
 * @param {Page | Frame} target
 * @returns {Promise<{fetch: string, xhr: string}>}
 */
async function whoami(target) {
  return target.evaluate(() => /** @type {any} */(window).checkWhoami());
}

test.describe('Plugin window authentication', () => {

  test('result dialog and separate window load the plugin page without the session id', async ({ page, context }) => {
    const consoleLogs = setupTestConsoleCapture(page);
    const stopErrorMonitoring = setupErrorFailure(consoleLogs, ALLOWED_ERROR_PATTERNS);

    try {
      await navigateAndLogin(page, TEST_USER.username, TEST_USER.password);

      /** @type {string[]} */
      const pluginRequests = [];
      context.on('request', request => {
        if (request.url().includes('/api/plugins/test-plugin/')) {
          pluginRequests.push(request.url());
        }
      });

      const frame = await openPluginPage(page);
      expect(frame.url()).not.toContain('session_id');
      expect(frame.url()).not.toContain('launch=');
      expect(await whoami(frame)).toEqual({ fetch: 'testuser', xhr: 'testuser' });

      // The separate window gets its own launch token
      const popupPromise = context.waitForEvent('page');
      await page.waitForTimeout(500);
      await page.evaluate(() => {
        const button = document.querySelector('sl-dialog[open] [name="openWindowBtn"]');
        if (!(button instanceof HTMLElement)) throw new Error('Open window button not found');
        button.click();
      });
      const popup = await popupPromise;
      await popup.waitForURL(PAGE_URL);
      expect(await whoami(popup)).toEqual({ fetch: 'testuser', xhr: 'testuser' });

      // A reload of the window still works, authenticated by the cookie
      await popup.reload();
      await expect(popup.locator('#result')).toContainText('"fetch":"testuser"');
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

  test('requests of a plugin page keep the session of their tab when another tab opens one', async ({ page, context }) => {
    const consoleLogs = setupTestConsoleCapture(page);
    const stopErrorMonitoring = setupErrorFailure(consoleLogs, ALLOWED_ERROR_PATTERNS);
    const adminPage = await context.newPage();

    try {
      await navigateAndLogin(page, TEST_USER.username, TEST_USER.password);
      const userFrame = await openPluginPage(page);
      expect(await whoami(userFrame)).toEqual({ fetch: 'testuser', xhr: 'testuser' });

      // The admin tab opens a plugin page too, which sets the profile-wide cookie to its session
      await navigateAndLogin(adminPage, TEST_ADMIN.username, TEST_ADMIN.password);
      const adminFrame = await openPluginPage(adminPage);
      expect(await whoami(adminFrame)).toEqual({ fetch: 'testadmin', xhr: 'testadmin' });

      // The user's page still sends the user's session with its requests
      expect(await whoami(userFrame)).toEqual({ fetch: 'testuser', xhr: 'testuser' });

      await performLogout(adminPage);
      await performLogout(page);
    } finally {
      await adminPage.close();
      stopErrorMonitoring();
    }
  });
});
