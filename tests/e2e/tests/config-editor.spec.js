/**
 * Configuration editor end-to-end tests: clearing masked values and deleting plugin keys
 *
 * @testCovers app/src/plugins/config-editor.js
 * @testCovers fastapi_app/api/config.py
 */

/**
 * @import { Page } from '@playwright/test'
 */

import { test, expect } from '../fixtures/debug-on-failure.js';
import { setupTestConsoleCapture, setupErrorFailure } from './helpers/test-logging.js';
import { navigateAndLogin, performLogout } from './helpers/login-helper.js';

const TEST_ADMIN = { username: 'testadmin', password: 'adminpass' };

const MASKED_KEY = 'plugin.e2e-config-test.api.key';
const PLUGIN_KEY = 'plugin.e2e-config-test.setting';

const ALLOWED_ERROR_PATTERNS = [
  'Failed to load resource.*401.*UNAUTHORIZED'
];

/**
 * Open the configuration editor through its menu item and filter it to the test keys
 * @param {Page} page
 */
async function openConfigEditor(page) {
  await page.evaluate(() => {
    const menuItem = document.querySelector('sl-menu-item[name="configEditorMenuItem"]');
    if (!(menuItem instanceof HTMLElement)) throw new Error('Configuration editor menu item not found');
    menuItem.click();
  });
  await page.waitForSelector('sl-dialog[name="configEditorDialog"][open]');
  await page.locator('sl-dialog[name="configEditorDialog"] sl-input[name="searchInput"] input').fill('e2e-config-test');
}

/**
 * Load the raw (masked) configuration via the API client
 * @param {Page} page
 * @returns {Promise<Record<string, any>>}
 */
async function configList(page) {
  return page.evaluate(async () => /** @type {any} */ (window).client.apiClient.configList());
}

test.describe('Configuration editor', () => {

  test('admin can clear a masked value and delete a plugin key', async ({ page }) => {
    const consoleLogs = setupTestConsoleCapture(page);
    const stopErrorMonitoring = setupErrorFailure(consoleLogs, ALLOWED_ERROR_PATTERNS);

    try {
      await navigateAndLogin(page, TEST_ADMIN.username, TEST_ADMIN.password);
      await page.evaluate(async ({ maskedKey, pluginKey }) => {
        const api = /** @type {any} */ (window).client.apiClient;
        await api.configSet({ key: maskedKey, value: 'secret', masked: true });
        await api.configSet({ key: pluginKey, value: 'value', description: 'E2E test setting' });
      }, { maskedKey: MASKED_KEY, pluginKey: PLUGIN_KEY });

      await openConfigEditor(page);
      const editor = page.locator('sl-dialog[name="configEditorDialog"]');
      const confirmDialog = page.locator('sl-dialog[name="dialog"]');
      const maskedRow = editor.locator(`tr[data-key="${MASKED_KEY}"]`);
      const pluginRow = editor.locator(`tr[data-key="${PLUGIN_KEY}"]`);

      // Clear the masked value
      await expect(maskedRow.locator('sl-input')).toHaveAttribute('placeholder', '(set but hidden)');
      await page.waitForTimeout(500);
      await maskedRow.locator('sl-icon-button[data-action="clear"]').click();
      await expect(confirmDialog).toHaveAttribute('open', '');
      await expect(confirmDialog).toHaveAttribute('label', 'Clear configuration value');
      await page.waitForTimeout(500);
      await confirmDialog.locator('sl-button[name="confirmBtn"]').click();
      await expect(maskedRow.locator('sl-input')).toHaveAttribute('placeholder', '(not set)');
      await expect(maskedRow.locator('sl-icon-button[data-action="clear"]')).toHaveCount(0);
      expect((await configList(page))[MASKED_KEY]).toBe('');

      // Cancelling the delete warning keeps the key
      await page.waitForTimeout(500);
      await pluginRow.locator('sl-icon-button[data-action="delete"]').click();
      await expect(confirmDialog).toHaveAttribute('open', '');
      await expect(confirmDialog).toHaveAttribute('label', 'Delete configuration value');
      await page.waitForTimeout(500);
      await confirmDialog.locator('sl-button[name="cancelBtn"]').click();
      await expect(confirmDialog).not.toHaveAttribute('open', '');
      expect((await configList(page))[PLUGIN_KEY]).toBe('value');

      // Confirming deletes the key and its metadata
      await page.waitForTimeout(500);
      await pluginRow.locator('sl-icon-button[data-action="delete"]').click();
      await expect(confirmDialog).toHaveAttribute('open', '');
      await page.waitForTimeout(500);
      await confirmDialog.locator('sl-button[name="confirmBtn"]').click();
      await expect(pluginRow).toHaveCount(0);
      const config = await configList(page);
      expect(PLUGIN_KEY in config).toBe(false);
      expect(`${PLUGIN_KEY}.description` in config).toBe(false);

      // Core settings have no delete button
      await page.locator('sl-dialog[name="configEditorDialog"] sl-input[name="searchInput"] input').fill('session.timeout');
      await expect(editor.locator('tr[data-key="session.timeout"]')).toHaveCount(1);
      await expect(editor.locator('tr[data-key="session.timeout"] sl-icon-button[data-action="delete"]')).toHaveCount(0);

      await page.evaluate(async (maskedKey) => {
        await /** @type {any} */ (window).client.apiClient.configDelete(maskedKey);
      }, MASKED_KEY);
      await page.waitForTimeout(500);
      await editor.locator('sl-button[name="closeBtn"]').click();
      await performLogout(page);
    } finally {
      stopErrorMonitoring();
    }
  });
});
