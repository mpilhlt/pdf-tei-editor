/**
 * Dashboard Plugin E2E Tests
 *
 * The E2E fixtures set `plugin.dashboard.show-on-login` to false so the dashboard does not
 * cover the UI in other tests; these tests open it with the toolbar button.
 *
 * @testCovers fastapi_app/plugins/dashboard/extensions/dashboard.js
 * @testCovers fastapi_app/plugins/recent_documents/extensions/recent-documents.js
 * @testCovers fastapi_app/plugins/review_queue/extensions/review-queue.js
 * @testCovers fastapi_app/plugins/annotation_progress/extensions/annotation-progress-dashboard.js
 * @testCovers fastapi_app/plugins/edit_history/extensions/edit-history-dashboard.js
 */

import { test, expect } from '../fixtures/debug-on-failure.js';
import { performLogin } from './helpers/login-helper.js';

test.describe('Dashboard Plugin', () => {

  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await performLogin(page);
  });

  test('is not shown on login when disabled in the configuration', async ({ page }) => {
    await expect(page.locator('[data-test-id="dashboard-dialog"]')).not.toHaveAttribute('open', '');
  });

  test('has a toolbar button between the file drawer and the search button', async ({ page }) => {
    await page.waitForTimeout(1000);
    const order = await page.evaluate(() => {
      const toolbar = /** @type {any} */(window).ui.toolbar;
      const children = [...toolbar.children];
      return ['fileDrawerTrigger', 'dashboardBtn', 'searchBtn'].map(name => {
        const el = toolbar.querySelector(`[name="${name}"]`);
        return children.indexOf(el.closest('sl-tooltip') ?? el);
      });
    });
    expect(order[0]).toBeGreaterThanOrEqual(0);
    expect(order).toEqual([order[0], order[0] + 1, order[0] + 2]);
  });

  test('opens from the toolbar button and renders one box per contribution', async ({ page }) => {
    await page.waitForTimeout(1000);
    await page.locator('[data-test-id="dashboard-toolbar-btn"]').click();

    const dialog = page.locator('[data-test-id="dashboard-dialog"]');
    await expect(dialog).toBeVisible();

    const contributionIds = await page.evaluate(async () => {
      const contributions = await /** @type {any} */(window).app.getDependency('dashboard').collectContributions();
      return contributions.map(c => c.id);
    });
    for (const id of contributionIds) {
      await expect(page.locator(`[data-test-id="dashboard-box-${id}"]`)).toBeVisible();
    }
    if (contributionIds.length === 0) {
      await expect(dialog.locator('.dashboard-empty')).toBeVisible();
    }

    await page.waitForTimeout(500);
    await page.locator('[data-test-id="dashboard-close-btn"]').click();
    await expect(dialog).not.toBeVisible();
  });

  test('backend routes of the contributing plugins answer for the logged-in user', async ({ page }) => {
    const sessionId = await page.evaluate(() => /** @type {any} */(window).app.getCurrentState().sessionId);
    const headers = { 'X-Session-ID': sessionId };
    for (const path of [
      '/api/plugins/recent-documents/recent',
      '/api/plugins/review-queue/documents',
      '/api/plugins/annotation-progress/dashboard-summary',
      '/api/plugins/edit-history/recent',
      '/api/plugins/edit-history/all'
    ]) {
      const response = await page.request.get(path, { headers });
      expect(response.status(), path).toBe(200);
    }
  });
});
