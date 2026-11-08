/**
 * Access tokens dialog end-to-end tests
 *
 * @testCovers app/src/plugins/access-tokens.js
 * @testCovers app/src/templates/access-tokens-dialog.html
 */

/**
 * @import { Page } from '@playwright/test'
 */

import { test, expect } from '../fixtures/debug-on-failure.js';
import { setupTestConsoleCapture, setupErrorFailure } from './helpers/test-logging.js';
import { navigateAndLogin, performLogout } from './helpers/login-helper.js';

const ALLOWED_ERROR_PATTERNS = [
  'Failed to load resource.*401.*UNAUTHORIZED'
];

/**
 * Whether the access tokens menu item is shown
 * @param {Page} page
 * @returns {Promise<boolean>}
 */
async function menuItemVisible(page) {
  return page.evaluate(() => {
    const menuItem = document.querySelector('sl-menu-item[name="accessTokensMenuItem"]');
    if (!(menuItem instanceof HTMLElement)) throw new Error('Access Tokens menu item not found');
    return menuItem.style.display !== 'none';
  });
}

/**
 * Open the access tokens dialog through its menu item
 * @param {Page} page
 */
async function openAccessTokensDialog(page) {
  await page.evaluate(() => {
    const menuItem = document.querySelector('sl-menu-item[name="accessTokensMenuItem"]');
    if (!(menuItem instanceof HTMLElement)) throw new Error('Access Tokens menu item not found');
    menuItem.click();
  });
  await page.waitForSelector('sl-dialog[name="accessTokensDialog"][open]');
}

test.describe('Access tokens dialog', () => {

  test('annotator does not see the menu entry', async ({ page }) => {
    const consoleLogs = setupTestConsoleCapture(page);
    const stopErrorMonitoring = setupErrorFailure(consoleLogs, ALLOWED_ERROR_PATTERNS);
    try {
      await navigateAndLogin(page, 'testannotator', 'annotatorpass');
      expect(await menuItemVisible(page)).toBe(false);
      await performLogout(page);
    } finally {
      stopErrorMonitoring();
    }
  });

  test('reviewer creates a token, uses it and revokes it', async ({ page }) => {
    const consoleLogs = setupTestConsoleCapture(page);
    const stopErrorMonitoring = setupErrorFailure(consoleLogs, ALLOWED_ERROR_PATTERNS);

    try {
      await navigateAndLogin(page, 'testreviewer', 'reviewerpass');
      expect(await menuItemVisible(page)).toBe(true);
      await openAccessTokensDialog(page);

      const dialog = page.locator('sl-dialog[name="accessTokensDialog"]');
      const label = `e2e token ${Date.now()}`;
      await page.waitForTimeout(500);
      await dialog.locator('sl-input[name="labelInput"] input').fill(label);
      await dialog.locator('sl-button[name="createBtn"]').click();

      const newTokenInput = dialog.locator('sl-input[name="newTokenInput"]');
      await expect(newTokenInput).toBeVisible();
      const token = await newTokenInput.evaluate(el => /** @type {HTMLInputElement} */ (/** @type {unknown} */ (el)).value);
      expect(token).toMatch(/^pte_[a-z2-7]{8}_/);
      await expect(dialog.locator('sl-input[name="envLineInput"]')).toHaveJSProperty('value', `API_TOKEN=${token}`);
      const row = dialog.locator('table.access-tokens-table tbody tr', { hasText: label });
      await expect(row).toHaveCount(1);

      // The token logs in as the reviewer
      const login = await page.evaluate(async (token) => {
        const client = /** @type {any} */ (window).client;
        return client.apiClient.authTokenLogin({ token });
      }, token);
      expect(login.username).toBe('testreviewer');
      const statusBefore = await page.request.get('/api/v1/auth/status', { headers: { 'X-Session-ID': login.sessionId } });
      expect(statusBefore.status()).toBe(200);

      // Revoking ends the token's session
      const confirmDialog = page.locator('sl-dialog[name="dialog"]');
      await page.waitForTimeout(500);
      await row.locator('sl-button').click();
      await expect(confirmDialog).toHaveAttribute('open', '');
      await expect(confirmDialog).toHaveAttribute('label', 'Revoke access token');
      await page.waitForTimeout(500);
      await confirmDialog.locator('sl-button[name="confirmBtn"]').click();
      await expect(row).toHaveCount(0);
      const statusAfter = await page.request.get('/api/v1/auth/status', { headers: { 'X-Session-ID': login.sessionId } });
      expect(statusAfter.status()).toBe(401);

      await page.waitForTimeout(500);
      await dialog.locator('sl-button[name="closeBtn"]').click();
      await performLogout(page);
    } finally {
      stopErrorMonitoring();
    }
  });
});
