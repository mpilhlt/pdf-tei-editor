/**
 * API keys dialog end-to-end tests
 *
 * Uses the secret service `test-secret-service` registered by the test plugin
 * (tests/fixtures/plugins/test_plugin/).
 *
 * @testCovers app/src/plugins/api-keys.js
 * @testCovers app/src/templates/api-keys-dialog.html
 */

/**
 * @import { Page } from '@playwright/test'
 */

import { test, expect } from '../fixtures/debug-on-failure.js';
import { setupTestConsoleCapture, setupErrorFailure } from './helpers/test-logging.js';
import { navigateAndLogin, performLogout } from './helpers/login-helper.js';

const SERVICE = 'test-secret-service';

const ALLOWED_ERROR_PATTERNS = [
  'Failed to load resource.*401.*UNAUTHORIZED'
];

/**
 * Whether the current user has a key for the test service
 * @param {Page} page
 * @returns {Promise<boolean>}
 */
async function hasKey(page) {
  return page.evaluate(async (service) => {
    const client = /** @type {any} */ (window).client;
    const services = await client.apiClient.secretsList();
    return services.find((/** @type {{id: string}} */ s) => s.id === service)?.is_set === true;
  }, SERVICE);
}

/**
 * Open the API keys dialog through its menu item
 * @param {Page} page
 */
async function openApiKeysDialog(page) {
  await page.evaluate(() => {
    const menuItem = document.querySelector('sl-menu-item[name="apiKeysMenuItem"]');
    if (!(menuItem instanceof HTMLElement)) throw new Error('API Keys menu item not found');
    menuItem.click();
  });
  await page.waitForSelector('sl-dialog[name="apiKeysDialog"][open]');
}

test.describe('API keys dialog', () => {

  test('user can remove all stored keys after confirmation', async ({ page }) => {
    const consoleLogs = setupTestConsoleCapture(page);
    const stopErrorMonitoring = setupErrorFailure(consoleLogs, ALLOWED_ERROR_PATTERNS);

    try {
      await navigateAndLogin(page, 'testuser', 'testpass');
      await page.evaluate(async (service) => {
        const client = /** @type {any} */ (window).client;
        await client.apiClient.secretsSet(service, { value: 'e2e-test-key' });
      }, SERVICE);
      expect(await hasKey(page)).toBe(true);

      await openApiKeysDialog(page);
      const apiKeysDialog = page.locator('sl-dialog[name="apiKeysDialog"]');
      const removeAll = apiKeysDialog.locator('sl-button[name="removeAllBtn"]');
      await expect(removeAll).toBeVisible();
      await expect(apiKeysDialog.locator('sl-input[label="Test Service"]'))
        .toHaveAttribute('placeholder', /^Stored/);

      // Cancelling the confirmation keeps the key
      const confirmDialog = page.locator('sl-dialog[name="dialog"]');
      await page.waitForTimeout(500);
      await removeAll.click();
      await expect(confirmDialog).toHaveAttribute('open', '');
      await expect(confirmDialog).toHaveAttribute('label', 'Remove all API keys');
      await page.waitForTimeout(500);
      await confirmDialog.locator('sl-button[name="cancelBtn"]').click();
      await expect(confirmDialog).not.toHaveAttribute('open', '');
      expect(await hasKey(page)).toBe(true);

      // Confirming removes the key and updates the list
      await page.waitForTimeout(500);
      await removeAll.click();
      await expect(confirmDialog).toHaveAttribute('open', '');
      await page.waitForTimeout(500);
      await confirmDialog.locator('sl-button[name="confirmBtn"]').click();
      await expect(page.locator('sl-alert[variant="success"]')).toContainText('Removed 1 key');
      await expect(apiKeysDialog.locator('sl-input[label="Test Service"]'))
        .toHaveAttribute('placeholder', 'Enter your API key');
      expect(await hasKey(page)).toBe(false);

      await page.waitForTimeout(500);
      await apiKeysDialog.locator('sl-button[name="closeBtn"]').click();
      await performLogout(page);
    } finally {
      stopErrorMonitoring();
    }
  });
});
