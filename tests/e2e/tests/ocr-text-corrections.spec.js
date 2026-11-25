/**
 * Tools action "Write text corrections to PDF": for a document without text layout, the dialog
 * shows why nothing can be written and offers no Write button. The full write path needs the
 * GROBID service and is covered by the backend tests.
 *
 * @testCovers app/src/plugins/text-corrections.js
 * @testCovers app/src/modules/text-corrections.js
 * @testCovers fastapi_app/routers/ocr.py
 */

import { test, expect } from '../fixtures/debug-on-failure.js';
import { setupTestConsoleCapture, waitForTestMessage, setupErrorFailure } from './helpers/test-logging.js';
import { navigateAndLogin, releaseAllLocks } from './helpers/login-helper.js';

const ALLOWED_ERROR_PATTERNS = [
  'Failed to load resource.*401.*UNAUTHORIZED'
];

test.describe('Text corrections', () => {
  test('text corrections dialog shows the reason and no Write button without layout', async ({ page }) => {
    test.setTimeout(90000);
    const consoleLogs = setupTestConsoleCapture(page);
    const stopErrorMonitoring = setupErrorFailure(consoleLogs, ALLOWED_ERROR_PATTERNS);

    try {
      await navigateAndLogin(page, 'testreviewer', 'reviewerpass');

      const stableId = await page.evaluate(async () => {
        const result = await /** @type {any} */ (window).client.apiClient.filesList();
        const group = result.files.find((/** @type {any} */ f) => f.doc_id === 'document-rules-fixture');
        return group ? group.source.id : null;
      });
      expect(stableId).toBeTruthy();
      await page.evaluate(
        (id) => /** @type {any} */ (window).app.getDependency('services').load({ xml: id }),
        stableId
      );
      await page.waitForFunction(() => {
        const view = /** @type {any} */ (window).app.getDependency('xmleditor').getView();
        return view && view.state.doc.length > 0;
      }, { timeout: 15000 });
      await page.waitForTimeout(500);

      await page.click('sl-dropdown[name="toolsDropdown"] sl-button[name="toolsBtn"]');
      await page.waitForTimeout(500);
      const item = page.locator('sl-menu-item:has-text("Write text corrections to PDF")');
      await item.waitFor({ state: 'visible', timeout: 15000 });
      await item.click();

      const opened = await waitForTestMessage(consoleLogs, 'TEXT_CORRECTIONS_DIALOG_OPENED', 20000);
      expect(opened.value.canApply).toBe(false);

      const dialog = page.locator('sl-dialog[name="textCorrectionsDialog"]');
      await expect(dialog).toHaveAttribute('open', '');
      await expect(dialog.locator('[name="summary"]')).not.toBeEmpty();
      await expect(dialog.locator('sl-button[name="write"]')).toBeHidden();

      await page.waitForTimeout(500);
      await dialog.locator('sl-button[name="close"]').click();
      await expect(dialog).not.toHaveAttribute('open', '');
    } finally {
      stopErrorMonitoring();
      await releaseAllLocks(page);
    }
  });
});
