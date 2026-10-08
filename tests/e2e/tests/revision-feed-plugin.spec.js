/**
 * Revision Feed Plugin E2E Tests
 *
 * @testCovers fastapi_app/plugins/revision_feed/extensions/revision-feed.js
 * @testCovers fastapi_app/plugins/revision_feed/routes.py
 */

import { test, expect } from '../fixtures/debug-on-failure.js';
import { performLogin } from './helpers/login-helper.js';

test.describe('Revision Feed Plugin', () => {

  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await performLogin(page);
  });

  test('Revision Feeds menu item exists in user menu', async ({ page }) => {
    await page.waitForTimeout(1000);
    const menuItem = page.locator('[data-test-id="revision-feed-menu-item"]');
    await expect(menuItem).toBeAttached();
  });

  test('Clicking the menu item opens the feed dialog', async ({ page }) => {
    await page.waitForTimeout(1000);

    // The menu item lives inside the user menu's sl-dropdown, which must be
    // opened before its contents become visible/clickable (see
    // tests/e2e/tests/auth-workflow.spec.js and helpers/login-helper.js for
    // the same pattern).
    await page.evaluate(() => {
      /** @type {any} */(window).ui.toolbar.toolbarMenu.menuBtn.click();
    });
    await page.waitForTimeout(500);

    await page.locator('[data-test-id="revision-feed-menu-item"]').click();
    await page.waitForTimeout(500);

    const dialog = page.locator('[data-test-id="revision-feed-dialog"]');
    await expect(dialog).toBeVisible();

    // Either at least one feed URL input, or the "no projects" message —
    // depends on the logged-in test user's project membership fixture data.
    const hasFeedRow = await page.locator('[data-test-id^="revision-feed-url-"]').count();
    const hasEmptyMessage = await page.locator('[data-test-id="revision-feed-empty-message"]').count();
    expect(hasFeedRow + hasEmptyMessage).toBeGreaterThan(0);
  });

  test('Feed endpoint rejects an invalid token', async ({ page }) => {
    const response = await page.request.get(
      '/api/plugins/revision-feed/feed/some-project.atom?token=not-a-real-token'
    );
    expect(response.status()).toBe(401);
  });

  test('Regenerating the token requires confirmation', async ({ page }) => {
    await page.waitForTimeout(1000);

    await page.evaluate(() => {
      /** @type {any} */(window).ui.toolbar.toolbarMenu.menuBtn.click();
    });
    await page.waitForTimeout(500);
    await page.locator('[data-test-id="revision-feed-menu-item"]').click();
    await page.waitForTimeout(500);

    const regenerateBtn = page.locator('[data-test-id="revision-feed-regenerate-btn"]');
    // The confirm prompt reuses the DialogPlugin's single generic dialog
    // (name="dialog"), the same element used for confirm prompts elsewhere
    // (see tests/e2e/tests/document-rules.spec.js for the same locator
    // pattern), which stacks on top of the still-open revision-feed-dialog.
    const confirmDialog = page.locator('sl-dialog[name="dialog"]');

    // Cancelling the prompt must not call the regenerate endpoint.
    await regenerateBtn.click();
    await page.waitForTimeout(500);
    await expect(confirmDialog).toHaveAttribute('open', '', { timeout: 5000 });
    await confirmDialog.locator('sl-button[name="cancelBtn"]').click();
    await page.waitForTimeout(500);
    await expect(confirmDialog).not.toHaveAttribute('open', '');
    await expect(regenerateBtn).not.toBeDisabled();

    // Confirming proceeds with the actual regeneration.
    await regenerateBtn.click();
    await page.waitForTimeout(500);
    await expect(confirmDialog).toHaveAttribute('open', '', { timeout: 5000 });
    await confirmDialog.locator('sl-button[name="confirmBtn"]').click();
    await page.waitForTimeout(1000);

    // DialogPlugin.info() re-shows the same dialog element with the
    // success message once the regenerate call completes.
    await expect(confirmDialog).toHaveAttribute('open', '', { timeout: 5000 });
    await expect(confirmDialog).toContainText('regenerated');
  });

});
