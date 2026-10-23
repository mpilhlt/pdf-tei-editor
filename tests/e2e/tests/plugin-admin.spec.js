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
  await page.waitForSelector('sl-switch[data-id="test-base-plugin"]');
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

  // Uses the fixture plugins test-base-plugin and test-dependent-plugin (tests/fixtures/plugins/),
  // where the second depends on the first
  test('admin can disable a plugin with dependents and re-enable it', async ({ page }) => {
    const consoleLogs = setupTestConsoleCapture(page);
    const stopErrorMonitoring = setupErrorFailure(consoleLogs, ALLOWED_ERROR_PATTERNS);

    try {
      await navigateAndLogin(page, TEST_ADMIN.username, TEST_ADMIN.password);
      await openPluginManager(page);

      const before = await pluginStatuses(page);
      expect(before['test-base-plugin']).toBe('active');
      expect(before['test-dependent-plugin']).toBe('active');

      // Disabling the base plugin warns about its dependents; cancelling changes nothing
      await page.locator('sl-switch[data-id="test-base-plugin"]').click();
      const confirm = page.locator('sl-dialog[name="pluginAdminConfirmDialog"]');
      await expect(confirm).toHaveAttribute('open', '');
      await expect(confirm.locator('ul[name="affectedList"]')).toContainText('test-dependent-plugin');
      await page.waitForTimeout(500);
      await confirm.locator('sl-button[name="cancelBtn"]').click();
      expect((await pluginStatuses(page))['test-base-plugin']).toBe('active');

      // Confirming disables the base plugin and deactivates its dependents
      await page.waitForTimeout(500);
      await page.locator('sl-switch[data-id="test-base-plugin"]').click();
      await page.waitForTimeout(500);
      await confirm.locator('sl-button[name="okBtn"]').click();
      await expect(page.locator('sl-alert[name="reloadBanner"]')).toBeVisible();

      await expect.poll(() => pluginStatuses(page)).toMatchObject({
        'test-base-plugin': 'disabled',
        'test-dependent-plugin': 'inactive'
      });

      // Disabled plugin's endpoints are no longer offered
      const offered = await page.evaluate(async () => {
        const client = /** @type {any} */(window).client;
        const result = await client.apiClient.plugins({});
        return result.plugins.map((/** @type {any} */ p) => p.id);
      });
      expect(offered).not.toContain('test-base-plugin');
      expect(offered).not.toContain('test-dependent-plugin');
    } finally {
      // Restore state so other tests are not affected
      await page.evaluate(async () => {
        const client = /** @type {any} */(window).client;
        await client.apiClient.pluginsAdminEnable('test-base-plugin', { cascade: false });
      });
      expect(await pluginStatuses(page)).toMatchObject({ 'test-base-plugin': 'active', 'test-dependent-plugin': 'active' });
      stopErrorMonitoring();
      try {
        await performLogout(page);
      } catch {
        // ignore logout errors
      }
    }
  });

  // The E2E server does not enable runtime install, so the admin API is mocked:
  // the list reports install_enabled, the Available tab lists a trusted and an untrusted plugin
  test('admin installs a plugin from the Available tab, confirming an untrusted repository', async ({ page }) => {
    const consoleLogs = setupTestConsoleCapture(page);
    const stopErrorMonitoring = setupErrorFailure(consoleLogs, ALLOWED_ERROR_PATTERNS);
    /** @type {any[]} */
    const installRequests = [];

    try {
      await page.route('**/api/v1/plugins/admin', async route => {
        const response = await route.fetch();
        const json = await response.json();
        await route.fulfill({ response, json: { ...json, install_enabled: true } });
      });
      await page.route('**/api/v1/plugins/admin/available*', route => route.fulfill({
        json: {
          fetched_at: Date.now() / 1000,
          errors: {},
          trusted_owners: ['mpilhlt'],
          trusted_only: false,
          plugins: [
            {
              id: 'demo-plugin', repository: 'mpilhlt/pte-plugins', description: 'A trusted plugin', index_version: '1.0.0',
              latest_version: '1.0.0', latest_tag: 'demo-plugin-v1.0.0', versions: ['1.0.0'], installed_version: null,
              installed_source: null, requires: [], unmet_requirements: [], trusted: true, compatible: true, incompatible_reason: null,
              installable: true, update_available: false
            },
            {
              id: 'stranger-plugin', repository: 'stranger/plugins', description: 'An unverified plugin', index_version: '0.1.0',
              latest_version: '0.1.0', latest_tag: 'stranger-plugin-v0.1.0', versions: ['0.1.0'], installed_version: null,
              installed_source: null, requires: [], unmet_requirements: [], trusted: false, compatible: true, incompatible_reason: null,
              installable: true, update_available: false
            }
          ]
        }
      }));
      await page.route('**/api/v1/plugins/admin/install', async route => {
        installRequests.push(route.request().postDataJSON());
        await route.fulfill({ json: { plugin: 'stranger-plugin', version: '0.1.0', action: 'install', restart_required: false, generation: 1 } });
      });

      await navigateAndLogin(page, TEST_ADMIN.username, TEST_ADMIN.password);
      await openPluginManager(page);

      const availableTab = page.locator('sl-tab[name="availableTab"]');
      await expect(availableTab).toBeVisible();
      await availableTab.click();
      await expect(page.locator('[data-available="demo-plugin"]')).toContainText('Trusted');
      await expect(page.locator('[data-available="stranger-plugin"]')).toContainText('Unverified');

      // Installing from an untrusted repository requires typing its name
      await page.locator('sl-button[data-install="stranger-plugin"]').click();
      const confirm = page.locator('sl-dialog[name="pluginAdminConfirmDialog"]');
      await expect(confirm).toHaveAttribute('open', '');
      const okBtn = confirm.locator('sl-button[name="okBtn"]');
      await expect(okBtn).toHaveAttribute('disabled', '');
      await confirm.locator('sl-input[name="confirmInput"] input').fill('stranger/plugins');
      await expect(okBtn).not.toHaveAttribute('disabled', '');
      await page.waitForTimeout(500);
      await okBtn.click();

      await expect.poll(() => installRequests.length).toBe(1);
      expect(installRequests[0]).toMatchObject({ repository: 'stranger/plugins', id: 'stranger-plugin', version: '0.1.0', confirm: 'stranger/plugins' });
    } finally {
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
