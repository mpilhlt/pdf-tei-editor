/**
 * E2E tests for batch move/copy feature in the file selection drawer.
 *
 * @testCovers app/src/plugins/file-selection-drawer.js
 * @testCovers app/src/plugins/move-files.js
 */

import { test, expect } from '../fixtures/debug-on-failure.js';
import { setupTestConsoleCapture, setupErrorFailure } from './helpers/test-logging.js';
import { navigateAndLogin, performLogout } from './helpers/login-helper.js';

// Define allowed error patterns
const ALLOWED_ERROR_PATTERNS = [
  'Failed to load resource.*404',
  'Failed to load resource.*401.*UNAUTHORIZED',
  'Failed to load resource.*400.*BAD REQUEST',
  'Failed to load resource.*ERR_NETWORK_IO_SUSPENDED',
  'offsetParent is not set.*cannot scroll'
];

// Test user with reviewer role (needed to see moveCopyButton)
const TEST_REVIEWER = { username: 'testreviewer', password: 'reviewerpass' };

/**
 * Expands all collection items in the file tree so their pdf-item children become visible.
 * sl-tree-item children are hidden (in a slot) when the item is collapsed, making their
 * checkboxes invisible to Playwright. This helper programmatically expands all collection
 * items so pdf-item checkboxes become interactable.
 *
 * @param {import('@playwright/test').Page} page
 */
async function expandAllCollections(page) {
  const collectionItems = page.locator('.collection-item');
  const count = await collectionItems.count();
  for (let i = 0; i < count; i++) {
    await collectionItems.nth(i).evaluate(el => { /** @type {any} */(el).expanded = true; });
  }
  await page.waitForTimeout(300);
}

test.describe('File Drawer Batch Move/Copy', () => {

  test('document checkboxes appear on PDF items in the file drawer', async ({ page }) => {
    const consoleLogs = setupTestConsoleCapture(page);
    const stopErrorMonitoring = setupErrorFailure(consoleLogs, ALLOWED_ERROR_PATTERNS);

    try {
      await navigateAndLogin(page, TEST_REVIEWER.username, TEST_REVIEWER.password);
      await page.waitForTimeout(1000);

      // Open file drawer
      const drawerTrigger = page.locator('sl-button[name="fileDrawerTrigger"]');
      await drawerTrigger.click();
      await page.waitForTimeout(500);

      // Verify drawer is open
      const drawer = page.locator('sl-drawer[name="fileDrawer"]');
      await expect(drawer).toHaveAttribute('open', '');
      await page.waitForTimeout(300);

      // Check if any PDF items exist
      const pdfItems = page.locator('.pdf-item');
      const pdfCount = await pdfItems.count();
      if (pdfCount === 0) {
        // No test data — skip gracefully
        const closeButton = page.locator('sl-button[name="closeDrawer"]');
        await closeButton.click();
        await page.waitForTimeout(300);
        await performLogout(page);
        return;
      }

      // Expand collections so pdf-item checkboxes become visible
      await expandAllCollections(page);

      // First pdf-item should contain a visible sl-checkbox
      const firstPdfCheckbox = pdfItems.first().locator('sl-checkbox');
      await expect(firstPdfCheckbox).toBeVisible();

      // moveCopyButton should be visible (reviewer role makes it visible)
      const moveCopyButton = page.locator('sl-button[name="moveCopyButton"]');
      await expect(moveCopyButton).toBeVisible();

      // moveCopyButton should be disabled (no docs selected yet)
      await expect(moveCopyButton).toHaveAttribute('disabled', '');

      // Close drawer
      const closeButton = page.locator('sl-button[name="closeDrawer"]');
      await closeButton.click();
      await page.waitForTimeout(300);

      await performLogout(page);
    } finally {
      stopErrorMonitoring();
    }
  });

  test('checking a document checkbox enables the move/copy button', async ({ page }) => {
    const consoleLogs = setupTestConsoleCapture(page);
    const stopErrorMonitoring = setupErrorFailure(consoleLogs, ALLOWED_ERROR_PATTERNS);

    try {
      await navigateAndLogin(page, TEST_REVIEWER.username, TEST_REVIEWER.password);
      await page.waitForTimeout(1000);

      // Open file drawer
      const drawerTrigger = page.locator('sl-button[name="fileDrawerTrigger"]');
      await drawerTrigger.click();
      await page.waitForTimeout(500);

      const pdfItems = page.locator('.pdf-item');
      const pdfCount = await pdfItems.count();
      if (pdfCount === 0) {
        const closeButton = page.locator('sl-button[name="closeDrawer"]');
        await closeButton.click();
        await page.waitForTimeout(300);
        await performLogout(page);
        return;
      }

      // Expand collections so pdf-item checkboxes become visible
      await expandAllCollections(page);

      const moveCopyButton = page.locator('sl-button[name="moveCopyButton"]');

      // Should be disabled initially
      await expect(moveCopyButton).toHaveAttribute('disabled', '');

      // Click the first pdf-item's checkbox
      const firstPdfCheckbox = pdfItems.first().locator('sl-checkbox');
      await firstPdfCheckbox.click();
      await page.waitForTimeout(300);

      // moveCopyButton should now be enabled
      await expect(moveCopyButton).not.toHaveAttribute('disabled');

      // Click the same checkbox again to uncheck
      await firstPdfCheckbox.click();
      await page.waitForTimeout(300);

      // moveCopyButton should be disabled again
      await expect(moveCopyButton).toHaveAttribute('disabled', '');

      // Close drawer
      const closeButton = page.locator('sl-button[name="closeDrawer"]');
      await closeButton.click();
      await page.waitForTimeout(300);

      await performLogout(page);
    } finally {
      stopErrorMonitoring();
    }
  });

  test('collection checkbox toggles all document checkboxes and move/copy button', async ({ page }) => {
    const consoleLogs = setupTestConsoleCapture(page);
    const stopErrorMonitoring = setupErrorFailure(consoleLogs, ALLOWED_ERROR_PATTERNS);

    try {
      await navigateAndLogin(page, TEST_REVIEWER.username, TEST_REVIEWER.password);
      await page.waitForTimeout(1000);

      // Open file drawer
      const drawerTrigger = page.locator('sl-button[name="fileDrawerTrigger"]');
      await drawerTrigger.click();
      await page.waitForTimeout(500);

      const collectionItems = page.locator('.collection-item');
      const collectionCount = await collectionItems.count();
      if (collectionCount === 0) {
        const closeButton = page.locator('sl-button[name="closeDrawer"]');
        await closeButton.click();
        await page.waitForTimeout(300);
        await performLogout(page);
        return;
      }

      // Find a collection that has pdf-items; use the first one that does
      let firstCollectionWithPdfs = null;
      let pdfCheckboxCount = 0;
      for (let i = 0; i < collectionCount; i++) {
        const item = collectionItems.nth(i);
        const count = await item.locator('.pdf-item sl-checkbox').count();
        if (count > 0) {
          firstCollectionWithPdfs = item;
          pdfCheckboxCount = count;
          break;
        }
      }

      if (!firstCollectionWithPdfs || pdfCheckboxCount === 0) {
        const closeButton = page.locator('sl-button[name="closeDrawer"]');
        await closeButton.click();
        await page.waitForTimeout(300);
        await performLogout(page);
        return;
      }

      const moveCopyButton = page.locator('sl-button[name="moveCopyButton"]');
      const pdfCheckboxesInCollection = firstCollectionWithPdfs.locator('.pdf-item sl-checkbox');

      // Get the collection-level checkbox (first sl-checkbox directly in collection-item, not in pdf-item)
      const collectionCheckbox = firstCollectionWithPdfs.locator('sl-checkbox').first();

      // Check the collection checkbox
      await collectionCheckbox.click();
      await page.waitForTimeout(300);

      // All pdf-item checkboxes in that collection should now be checked
      for (let i = 0; i < pdfCheckboxCount; i++) {
        await expect(pdfCheckboxesInCollection.nth(i)).toHaveJSProperty('checked', true);
      }

      // moveCopyButton should be enabled
      await expect(moveCopyButton).not.toHaveAttribute('disabled');

      // Uncheck the collection checkbox
      await collectionCheckbox.click();
      await page.waitForTimeout(300);

      // All pdf-item checkboxes should be unchecked
      for (let i = 0; i < pdfCheckboxCount; i++) {
        await expect(pdfCheckboxesInCollection.nth(i)).toHaveJSProperty('checked', false);
      }

      // moveCopyButton should be disabled
      await expect(moveCopyButton).toHaveAttribute('disabled', '');

      // Close drawer
      const closeButton = page.locator('sl-button[name="closeDrawer"]');
      await closeButton.click();
      await page.waitForTimeout(300);

      await performLogout(page);
    } finally {
      stopErrorMonitoring();
    }
  });

  test('batch dialog opens and Move button is disabled with 0 collections selected', async ({ page }) => {
    const consoleLogs = setupTestConsoleCapture(page);
    const stopErrorMonitoring = setupErrorFailure(consoleLogs, ALLOWED_ERROR_PATTERNS);

    try {
      await navigateAndLogin(page, TEST_REVIEWER.username, TEST_REVIEWER.password);
      await page.waitForTimeout(1000);

      // Open file drawer
      const drawerTrigger = page.locator('sl-button[name="fileDrawerTrigger"]');
      await drawerTrigger.click();
      await page.waitForTimeout(500);

      const pdfItems = page.locator('.pdf-item');
      const pdfCount = await pdfItems.count();
      if (pdfCount === 0) {
        const closeButton = page.locator('sl-button[name="closeDrawer"]');
        await closeButton.click();
        await page.waitForTimeout(300);
        await performLogout(page);
        return;
      }

      // Expand collections so pdf-item checkboxes become visible
      await expandAllCollections(page);

      // Check first pdf-item checkbox
      const firstPdfCheckbox = pdfItems.first().locator('sl-checkbox');
      await firstPdfCheckbox.click();
      await page.waitForTimeout(300);

      // Click moveCopyButton to open the dialog
      const moveCopyButton = page.locator('sl-button[name="moveCopyButton"]');
      await moveCopyButton.click();
      await page.waitForTimeout(500);

      // Dialog should be open
      const dialog = page.locator('sl-dialog[name="moveFilesDialog"]');
      await expect(dialog).toHaveAttribute('open', '');

      // moveBtn and copyBtn should both be disabled (no collections selected yet)
      const moveBtn = dialog.locator('sl-button[name="moveBtn"]');
      const copyBtn = dialog.locator('sl-button[name="copyBtn"]');
      await expect(moveBtn).toHaveAttribute('disabled', '');
      await expect(copyBtn).toHaveAttribute('disabled', '');

      // If there are collection checkboxes in the dialog, test their interaction
      const collectionCheckboxes = dialog.locator('[name="collectionsList"] sl-checkbox');
      const dialogCollectionCount = await collectionCheckboxes.count();

      if (dialogCollectionCount > 0) {
        // Check first collection checkbox
        await collectionCheckboxes.first().click();
        await page.waitForTimeout(200);

        // With exactly 1 collection selected: moveBtn enabled, copyBtn enabled
        await expect(moveBtn).not.toHaveAttribute('disabled');
        await expect(copyBtn).not.toHaveAttribute('disabled');

        if (dialogCollectionCount > 1) {
          // Check second collection checkbox
          await collectionCheckboxes.nth(1).click();
          await page.waitForTimeout(200);

          // With >1 collections selected: moveBtn disabled (move only works to 1 target), copyBtn enabled
          await expect(moveBtn).toHaveAttribute('disabled', '');
          await expect(copyBtn).not.toHaveAttribute('disabled');
        }
      }

      // Cancel the dialog
      const cancelBtn = dialog.locator('sl-button[name="cancel"]');
      await cancelBtn.click();
      await page.waitForTimeout(300);

      // Close drawer
      const closeButton = page.locator('sl-button[name="closeDrawer"]');
      await closeButton.click();
      await page.waitForTimeout(300);

      await performLogout(page);
    } finally {
      stopErrorMonitoring();
    }
  });

  test('dismiss dialog with cancel returns without moving', async ({ page }) => {
    const consoleLogs = setupTestConsoleCapture(page);
    const stopErrorMonitoring = setupErrorFailure(consoleLogs, ALLOWED_ERROR_PATTERNS);

    try {
      await navigateAndLogin(page, TEST_REVIEWER.username, TEST_REVIEWER.password);
      await page.waitForTimeout(1000);

      // Open file drawer
      const drawerTrigger = page.locator('sl-button[name="fileDrawerTrigger"]');
      await drawerTrigger.click();
      await page.waitForTimeout(500);

      const pdfItems = page.locator('.pdf-item');
      const pdfCount = await pdfItems.count();
      if (pdfCount === 0) {
        const closeButton = page.locator('sl-button[name="closeDrawer"]');
        await closeButton.click();
        await page.waitForTimeout(300);
        await performLogout(page);
        return;
      }

      // Expand collections so pdf-item checkboxes become visible
      await expandAllCollections(page);

      // Check first pdf-item checkbox
      const firstPdfCheckbox = pdfItems.first().locator('sl-checkbox');
      await firstPdfCheckbox.click();
      await page.waitForTimeout(300);

      // Open the dialog
      const moveCopyButton = page.locator('sl-button[name="moveCopyButton"]');
      await moveCopyButton.click();
      await page.waitForTimeout(500);

      const dialog = page.locator('sl-dialog[name="moveFilesDialog"]');
      await expect(dialog).toHaveAttribute('open', '');

      // Click cancel button
      const cancelBtn = dialog.locator('sl-button[name="cancel"]');
      await cancelBtn.click();
      await page.waitForTimeout(300);

      // Dialog should no longer be open
      await expect(dialog).not.toHaveAttribute('open', '');

      // moveCopyButton should still be present in the drawer
      await expect(moveCopyButton).toBeVisible();

      // Close drawer
      const closeButton = page.locator('sl-button[name="closeDrawer"]');
      await closeButton.click();
      await page.waitForTimeout(300);

      await performLogout(page);
    } finally {
      stopErrorMonitoring();
    }
  });

});
