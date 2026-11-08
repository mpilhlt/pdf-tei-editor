/**
 * Inference model submenu E2E tests
 *
 * Covers the admin-only button in each model entry of the Tools menu's
 * inference submenu that copies the full "<provider id>/<model id>" to the
 * clipboard without selecting the model. The provider list is mocked, since
 * the test installation has no LLM provider configured.
 *
 * @testCovers app/src/plugins/inference-settings.js
 */

/**
 * @import { Page } from '@playwright/test'
 */

import { test, expect } from '../fixtures/debug-on-failure.js';
import { setupTestConsoleCapture, setupErrorFailure } from './helpers/test-logging.js';
import { navigateAndLogin, performLogout } from './helpers/login-helper.js';

const ALLOWED_ERROR_PATTERNS = [
  'Failed to load resource.*401.*UNAUTHORIZED', // will always be thrown when first loading without a saved state
];

const PROVIDERS = [{
  id: 'e2e-provider',
  label: 'E2E Provider',
  models: [
    { id: 'gemma-3-27b-it', label: 'Gemma 3 27B Instruct', capabilities: ['chat'], status: null },
    { id: 'glm-4.7', label: 'GLM 4.7', capabilities: ['chat'], status: { availability: 'busy', detail: 'demand: 3' } },
  ],
  key_required: false,
  secret_service: null,
  error: null,
}];

/**
 * Serve the mocked provider list and no configured default model.
 * @param {Page} page
 */
async function mockProviders(page) {
  await page.route('**/api/v1/llm/providers', route => route.fulfill({ json: PROVIDERS }));
  await page.route('**/api/v1/llm/default-model', route => route.fulfill({ json: null }));
}

/**
 * Open the Tools menu and the inference submenu.
 * @param {Page} page
 */
async function openInferenceSubmenu(page) {
  await page.click('sl-dropdown[name="toolsDropdown"] sl-button[name="toolsBtn"]');
  const parent = page.locator('sl-menu[name="toolsMenu"] sl-menu-item:has(> sl-menu[slot="submenu"] [data-model-id])');
  await expect(parent).toBeVisible();
  await parent.hover();
  await expect(page.locator('sl-menu-item[data-model-id="gemma-3-27b-it"]')).toBeVisible();
}

test.describe('Inference model submenu', () => {

  test('admins can copy the full model id without selecting the model', async ({ page, context, browserName }) => {
    test.skip(browserName !== 'chromium', 'clipboard permissions are only grantable in Chromium');
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    const consoleLogs = setupTestConsoleCapture(page);
    const stopErrorMonitoring = setupErrorFailure(consoleLogs, ALLOWED_ERROR_PATTERNS);

    try {
      await mockProviders(page);
      await navigateAndLogin(page, 'testadmin', 'adminpass');
      await openInferenceSubmenu(page);

      const item = page.locator('sl-menu-item[data-model-id="gemma-3-27b-it"]');
      const copyButton = item.locator('sl-icon-button[data-copy-model-id]');
      await expect(copyButton).toBeVisible();
      await expect(copyButton).toHaveAttribute('data-copy-model-id', 'e2e-provider/gemma-3-27b-it');
      if (process.env.E2E_SCREENSHOT_DIR) {
        await page.screenshot({ path: `${process.env.E2E_SCREENSHOT_DIR}/inference-copy-model-id.png` });
      }

      await copyButton.click();
      await expect(page.locator('sl-alert[variant="success"]')).toContainText('e2e-provider/gemma-3-27b-it');
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('e2e-provider/gemma-3-27b-it');
      // Copying must not select the model, which would ask to change the default for all users
      await expect(page.locator('sl-dialog[name="dialog"]')).not.toHaveAttribute('open', '');
      await expect(item).not.toHaveAttribute('checked', '');

      await page.keyboard.press('Escape');
      await performLogout(page);
    } finally {
      stopErrorMonitoring();
    }
  });

  test('other users see no copy button', async ({ page }) => {
    const consoleLogs = setupTestConsoleCapture(page);
    const stopErrorMonitoring = setupErrorFailure(consoleLogs, ALLOWED_ERROR_PATTERNS);

    try {
      await mockProviders(page);
      await navigateAndLogin(page, 'testuser', 'testpass');
      await openInferenceSubmenu(page);
      await expect(page.locator('sl-menu-item[data-model-id] sl-icon-button')).toHaveCount(0);

      await page.keyboard.press('Escape');
      await performLogout(page);
    } finally {
      stopErrorMonitoring();
    }
  });
});
