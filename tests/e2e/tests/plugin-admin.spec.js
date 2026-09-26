/**
 * Plugin manager end-to-end tests
 *
 * @testCovers app/src/plugins/plugin-admin.js
 * @testCovers fastapi_app/routers/plugins_admin.py
 * @testCovers fastapi_app/lib/plugins/plugin_manager.py
 */

import { test, expect } from '../fixtures/debug-on-failure.js';
import { setupTestConsoleCapture, setupErrorFailure } from './helpers/test-logging.js';
import { navigateAndLogin, performLogout } from './helpers/login-helper.js';

const TEST_ADMIN = { username: 'testadmin', password: 'adminpass' };

const ALLOWED_ERROR_PATTERNS = [
  'Failed to load resource.*401.*UNAUTHORIZED',
  'Failed to load resource.*404.*NOT FOUND' // requests to a plugin disabled by this test
];

/**
 * Open the plugin manager dialog through its Tools menu item
 * @param {import('@playwright/test').Page} page
 */
async function openPluginManager(page) {
  await page.evaluate(() => {
    const menuItem = document.querySelector('sl-menu-item[name="pluginAdminMenuItem"]');
    if (!(menuItem instanceof HTMLElement)) throw new Error('Manage Plugins menu item not found');
    menuItem.click();
  });
  await page.waitForSelector('sl-dialog[name="pluginAdminDialog"][open]');
  await page.waitForSelector('sl-switch[data-id="tei-wizard"]');
}

/**
 * Fetch plugin admin list via the API client
 * @param {import('@playwright/test').Page} page
 * @returns {Promise<Record<string, string>>} plugin id -> status
 */
async function pluginStatuses(page) {
  return page.evaluate(async () => {
    const client = /** @type {any} */(window).client;
    const { plugins } = await client.apiClient.pluginsAdmin();
    return Object.fromEntries(plugins.map((/** @type {any} */ p) => [p.id, p.status]));
  });
}

test.describe('Plugin manager', () => {

  test('admin can disable a plugin with dependents and re-enable it', async ({ page }) => {
    const consoleLogs = setupTestConsoleCapture(page);
    const stopErrorMonitoring = setupErrorFailure(consoleLogs, ALLOWED_ERROR_PATTERNS);

    try {
      await navigateAndLogin(page, TEST_ADMIN.username, TEST_ADMIN.password);
      await openPluginManager(page);

      const before = await pluginStatuses(page);
      expect(before['tei-wizard']).toBe('active');
      // grobid is only available where a GROBID server URL is configured (not in CI)
      const grobidActive = before['grobid'] === 'active';

      // Disabling tei-wizard warns about its dependents; cancelling changes nothing
      await page.locator('sl-switch[data-id="tei-wizard"]').click();
      const confirm = page.locator('sl-dialog[name="pluginAdminConfirmDialog"]');
      await expect(confirm).toHaveAttribute('open', '');
      if (grobidActive) {
        await expect(confirm.locator('ul[name="affectedList"]')).toContainText('grobid');
      }
      await expect(confirm.locator('ul[name="affectedList"]')).toContainText('metadata-extraction');
      await page.waitForTimeout(500);
      await confirm.locator('sl-button[name="cancelBtn"]').click();
      expect((await pluginStatuses(page))['tei-wizard']).toBe('active');

      // Confirming disables tei-wizard and deactivates its dependents
      await page.waitForTimeout(500);
      await page.locator('sl-switch[data-id="tei-wizard"]').click();
      await page.waitForTimeout(500);
      await confirm.locator('sl-button[name="okBtn"]').click();
      await expect(page.locator('sl-alert[name="reloadBanner"]')).toBeVisible();

      await expect.poll(() => pluginStatuses(page)).toMatchObject({
        'tei-wizard': 'disabled',
        ...(grobidActive ? { 'grobid': 'inactive' } : {}),
        'metadata-extraction': 'inactive'
      });

      // Disabled plugin's endpoints are no longer offered
      const offered = await page.evaluate(async () => {
        const client = /** @type {any} */(window).client;
        const result = await client.apiClient.plugins({});
        return result.plugins.map((/** @type {any} */ p) => p.id);
      });
      expect(offered).not.toContain('tei-wizard');
      if (grobidActive) expect(offered).not.toContain('grobid');
    } finally {
      // Restore state so other tests are not affected
      await page.evaluate(async () => {
        const client = /** @type {any} */(window).client;
        await client.apiClient.pluginsAdminEnable('tei-wizard', { cascade: false });
      });
      expect(await pluginStatuses(page)).toMatchObject({ 'tei-wizard': 'active', 'metadata-extraction': 'active' });
      stopErrorMonitoring();
      try {
        await performLogout(page);
      } catch {
        // ignore logout errors
      }
    }
  });

  test('non-admin does not see the Manage Plugins menu item', async ({ page }) => {
    const consoleLogs = setupTestConsoleCapture(page);
    const stopErrorMonitoring = setupErrorFailure(consoleLogs, ALLOWED_ERROR_PATTERNS);

    try {
      await navigateAndLogin(page, 'testuser', 'testpass');
      const display = await page.evaluate(() => {
        const item = document.querySelector('sl-menu-item[name="pluginAdminMenuItem"]');
        return item instanceof HTMLElement ? item.style.display : 'missing';
      });
      expect(display).toBe('none');
    } finally {
      stopErrorMonitoring();
      try {
        await performLogout(page);
      } catch {
        // ignore logout errors
      }
    }
  });
});
