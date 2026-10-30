/**
 * Frontend Extension System E2E Tests
 *
 * @testCovers app/src/modules/frontend-extension-registry.js
 * @testCovers app/src/modules/frontend-extension-plugin.js
 * @testCovers fastapi_app/lib/frontend_extension_registry.py
 * @testCovers fastapi_app/routers/plugins.py
 * @testCovers tests/fixtures/plugins/test_plugin/extensions/hello-world.js
 * @testCovers tests/fixtures/plugins/reference_plugin/extensions/reference-dialog.js
 * @testCovers fastapi_app/lib/plugins/extension_templates.py
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

    // Close dialog - use first() to handle Shoelace shadow DOM duplicates
    await dialog.locator('[name="closeBtn"]').first().click();
  });

  test('Extension custom endpoint is invocable via plugin manager', async ({ page }) => {
    // Wait for extensions to load
    await page.waitForTimeout(1000);

    // Test that class-based extensions expose custom endpoints via static extensionPoints
    await page.evaluate(async () => {
      const app = /** @type {any} */(window).app;
      if (!app) throw new Error('No app');

      // Invoke the 'hello-world-test.greet' endpoint registered by the class extension
      await app.invokePluginEndpoint('hello-world-test.greet', ['Custom greeting from test!']);
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
    // Should contain class-based IIFE with window.FrontendExtensionPlugin reference
    expect(content).toContain('window.registerFrontendExtension(HelloWorldExtension');
    expect(content).toContain('extends window.FrontendExtensionPlugin');
    expect(content).toContain('hello-world-test');
  });

  test('Reference plugin renders its UI from plugin templates', async ({ page }) => {
    const button = page.locator('[data-test-id="reference-plugin-toolbar-btn"]');
    await expect(button).toBeVisible();

    // The dialog was appended to a parent and the button inserted by the extension
    // followed by updateUi(): both are reachable through `ui`
    const named = await page.evaluate(() => {
      const ui = /** @type {any} */(window).ui;
      return {
        button: Boolean(ui.toolbar?.referencePluginToolbarBtn),
        dialog: Boolean(ui.referencePluginDialog?.closeBtn)
      };
    });
    expect(named).toEqual({ button: true, dialog: true });

    await button.click();
    const dialog = page.locator('sl-dialog[name="referencePluginDialog"]');
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAttribute('label', 'Reference Plugin');
    await expect(dialog.locator('[name="message"]')).toHaveText('Rendered from a plugin template');

    // The plugin stylesheet applies to the dialog
    const width = await dialog.evaluate(el => getComputedStyle(el).getPropertyValue('--width').trim());
    expect(width).toBe('24rem');

    // first(): Shoelace forwards the name to the button in its shadow DOM
    await dialog.locator('sl-button[name="closeBtn"]').first().click();
    await expect(dialog).toBeHidden();
  });

});
