/**
 * Garbage collection end-to-end test: the result dialog shows one row per GC task
 *
 * @testCovers app/src/plugins/filedata.js
 * @testCovers app/src/templates/gc-result-dialog.html
 * @testCovers fastapi_app/routers/files_gc.py
 */

import { test, expect } from '../fixtures/debug-on-failure.js';
import { setupTestConsoleCapture, setupErrorFailure } from './helpers/test-logging.js';
import { navigateAndLogin, performLogout } from './helpers/login-helper.js';

const TEST_ADMIN = { username: 'testadmin', password: 'adminpass' };

const ALLOWED_ERROR_PATTERNS = [
  'Failed to load resource.*401.*UNAUTHORIZED'
];

test.describe('Garbage collection', () => {

  test('admin runs garbage collection and sees the result of each task', async ({ page }) => {
    const consoleLogs = setupTestConsoleCapture(page);
    const stopErrorMonitoring = setupErrorFailure(consoleLogs, ALLOWED_ERROR_PATTERNS);

    try {
      await navigateAndLogin(page, TEST_ADMIN.username, TEST_ADMIN.password);
      await page.evaluate(() => {
        const menuItem = document.querySelector('sl-menu-item[name="gcMenuItem"]');
        if (!(menuItem instanceof HTMLElement)) throw new Error('Garbage collection menu item not found');
        menuItem.click();
      });
      const confirmDialog = page.locator('sl-dialog[name="dialog"]');
      await expect(confirmDialog).toHaveAttribute('open', '');
      await page.waitForTimeout(500);
      await confirmDialog.locator('sl-button[name="confirmBtn"]').click();

      const resultDialog = page.locator('sl-dialog[name="gcResultDialog"]');
      await expect(resultDialog).toHaveAttribute('open', '');
      for (const id of ['deleted-files', 'orphaned-xml', 'message-index', 'tmp']) {
        await expect(resultDialog.locator(`tr[data-task-id="${id}"]`)).toHaveCount(1);
      }
      await expect(resultDialog.locator('[name="summary"]')).toContainText('Deleted');
      if (process.env.E2E_GC_SCREENSHOT) {
        await page.waitForTimeout(500);
        await page.screenshot({ path: process.env.E2E_GC_SCREENSHOT });
      }

      await page.waitForTimeout(500);
      await resultDialog.locator('sl-button[name="closeBtn"]').click();
      await expect(resultDialog).not.toHaveAttribute('open', '');
      await performLogout(page);
    } finally {
      stopErrorMonitoring();
    }
  });
});
