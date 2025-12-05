/**
 * Export workflow end-to-end tests
 *
 * @testCovers app/src/plugins/file-selection-drawer.js
 * @testCovers fastapi_app/routers/files_export.py
 */

import { test, expect } from '../fixtures/debug-on-failure.js';
import { setupTestConsoleCapture, setupErrorFailure } from './helpers/test-logging.js';
import { navigateAndLogin, performLogout } from './helpers/login-helper.js';

// Define allowed error patterns
const ALLOWED_ERROR_PATTERNS = [
  'Failed to load resource.*401.*UNAUTHORIZED',
  'Failed to load resource.*400.*BAD REQUEST',
  'offsetParent is not set.*cannot scroll'
];

// Test credentials
const TEST_ADMIN = { username: 'testadmin', password: 'adminpass' };

test.describe('Export Workflow', () => {

  test('should show export UI in file drawer', async ({ page }) => {
    const consoleLogs = setupTestConsoleCapture(page);
    const stopErrorMonitoring = setupErrorFailure(consoleLogs, ALLOWED_ERROR_PATTERNS);

    try {
      await navigateAndLogin(page, TEST_ADMIN.username, TEST_ADMIN.password);
      await page.waitForTimeout(1000);

      // Open file drawer
      const drawerTrigger = page.locator('sl-button[name="fileDrawerTrigger"]');
      await drawerTrigger.click();
      await page.waitForTimeout(500);

      // Check that file drawer is open
      const drawer = page.locator('sl-drawer[name="fileDrawer"]');
      await expect(drawer).toHaveAttribute('open', '');

      // Wait for drawer content to fully render
      await page.waitForTimeout(300);

      // Check for select all checkbox (should be visible if collections exist)
      const selectAllContainer = page.locator('[name="selectAllContainer"]');
      const isVisible = await selectAllContainer.isVisible();

      if (isVisible) {
        // If collections exist, verify export button and checkboxes
        const exportButton = page.locator('sl-button[name="exportButton"]');
        await expect(exportButton).toBeVisible();

        // Check disabled state via attribute (Shoelace uses disabled attribute)
        await expect(exportButton).toHaveAttribute('disabled', ''); // Should be disabled initially

        // Find collection checkboxes
        const collectionCheckboxes = page.locator('.collection-item sl-checkbox');
        const count = await collectionCheckboxes.count();

        if (count > 0) {
          // Check first collection
          await collectionCheckboxes.first().click();
          await page.waitForTimeout(200);

          // Export button should now be enabled (no disabled attribute)
          await expect(exportButton).not.toHaveAttribute('disabled');

          // Uncheck the collection
          await collectionCheckboxes.first().click();
          await page.waitForTimeout(200);

          // Export button should be disabled again
          await expect(exportButton).toHaveAttribute('disabled', '');
        }
      }

      // Close drawer
      const closeButton = page.locator('sl-button[name="closeDrawer"]');
      await closeButton.click();
      await page.waitForTimeout(500);

      await performLogout(page);
    } finally {
      stopErrorMonitoring();
    }
  });

  test('should toggle all collections with select all checkbox', async ({ page }) => {
    const consoleLogs = setupTestConsoleCapture(page);
    const stopErrorMonitoring = setupErrorFailure(consoleLogs, ALLOWED_ERROR_PATTERNS);

    try {
      await navigateAndLogin(page, TEST_ADMIN.username, TEST_ADMIN.password);
      await page.waitForTimeout(1000);

      // Open file drawer
      const drawerTrigger = page.locator('sl-button[name="fileDrawerTrigger"]');
      await drawerTrigger.click();
      await page.waitForTimeout(500);

      // Check if select all is visible
      const selectAllContainer = page.locator('[name="selectAllContainer"]');
      const isVisible = await selectAllContainer.isVisible();

      if (isVisible) {
        const selectAllCheckbox = page.locator('sl-checkbox[name="selectAllCheckbox"]');
        const collectionCheckboxes = page.locator('.collection-item sl-checkbox');
        const count = await collectionCheckboxes.count();

        if (count > 0) {
          // Click select all
          await selectAllCheckbox.click();
          await page.waitForTimeout(300);

          // All collection checkboxes should be checked
          for (let i = 0; i < count; i++) {
            const checkbox = collectionCheckboxes.nth(i);
            await expect(checkbox).toHaveAttribute('checked', '');
          }

          // Export button should be enabled
          const exportButton = page.locator('sl-button[name="exportButton"]');
          await expect(exportButton).not.toHaveAttribute('disabled');

          // Click select all again to uncheck
          await selectAllCheckbox.click();
          await page.waitForTimeout(300);

          // All collection checkboxes should be unchecked
          for (let i = 0; i < count; i++) {
            const checkbox = collectionCheckboxes.nth(i);
            await expect(checkbox).not.toHaveAttribute('checked');
          }

          // Export button should be disabled
          await expect(exportButton).toHaveAttribute('disabled', '');
        }
      }

      // Close drawer
      const closeButton = page.locator('sl-button[name="closeDrawer"]');
      await closeButton.click();
      await page.waitForTimeout(500);

      await performLogout(page);
    } finally {
      stopErrorMonitoring();
    }
  });

});
