/**
 * Frontend Extension System E2E Tests
 *
 * @testCovers app/src/modules/frontend-extension-registry.js
 * @testCovers app/src/modules/frontend-extension-sandbox.js
 * @testCovers app/src/modules/frontend-extension-wrapper.js
 * @testCovers fastapi_app/lib/frontend_extension_registry.py
 * @testCovers fastapi_app/routers/plugins.py
 * @testCovers fastapi_app/plugins/test_plugin/extensions/hello-world.js
 */

import { test, expect } from '../fixtures/debug-on-failure.js';
import { performLogin } from './helpers/login-helper.js';

test.describe('Frontend Extension System', () => {

  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await performLogin(page);
  });

  test('Hello World button exists in toolbar', async ({ page }) => {
    // Wait for extensions to load and install
    await page.waitForTimeout(1000);

    const button = page.locator('[data-test-id="hello-world-toolbar-btn"]');
    await expect(button).toBeVisible();
  });

  test('Hello World button opens dialog', async ({ page }) => {
    // Wait for extensions to load
    await page.waitForTimeout(1000);

    const button = page.locator('[data-test-id="hello-world-toolbar-btn"]');
    await button.click();

    // Wait for dialog animation
    await page.waitForTimeout(500);

    const dialog = page.locator('sl-dialog[name="dialog"]');
    await expect(dialog).toBeVisible();

    const message = dialog.locator('[name="message"]');
    await expect(message).toContainText('Hello World');

    // Close dialog
    await dialog.locator('[name="closeBtn"]').click();
  });

  test('Extension can invoke other plugin endpoints via sandbox', async ({ page }) => {
    // Wait for extensions to load
    await page.waitForTimeout(1000);

    // Test that extensions can use sandbox.invoke() via PluginManager
    const result = await page.evaluate(async () => {
      const app = /** @type {any} */(window).app;
      if (!app?.pluginManager) return null;

      // Invoke the custom endpoint from the hello-world extension
      const results = await app.pluginManager.invoke('greet', ['Custom greeting from test!']);
      return results;
    });

    // Verify the invoke worked (dialog should have shown)
    await page.waitForTimeout(500);
    const dialog = page.locator('sl-dialog[name="dialog"]');
    await expect(dialog).toBeVisible();

    const message = dialog.locator('[name="message"]');
    await expect(message).toContainText('Custom greeting');
  });

  test('Extensions bundle endpoint returns JavaScript', async ({ page }) => {
    // Fetch extensions bundle directly
    const response = await page.request.get('/api/v1/plugins/extensions.js');

    expect(response.ok()).toBe(true);
    expect(response.headers()['content-type']).toContain('javascript');

    const content = await response.text();
    // Should contain the transformed extension with registration call
    expect(content).toContain('window.registerFrontendExtension');
    expect(content).toContain('hello-world-test');
  });

});
