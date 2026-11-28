/**
 * Backup & Restore page: a backup runs as a job, its progress is shown, the finished ZIP downloads
 * through the plugin route, and the backup can be cancelled.
 *
 * @testCovers fastapi_app/plugins/backup_restore/routes.py
 * @testCovers fastapi_app/plugins/backup_restore/static/view.html
 */

import { test, expect } from '../fixtures/debug-on-failure.js';
import { setupTestConsoleCapture, setupErrorFailure } from './helpers/test-logging.js';
import { navigateAndLogin, performLogout } from './helpers/login-helper.js';

/**
 * @import { Page, Frame } from '@playwright/test'
 */

const TEST_ADMIN = { username: 'testadmin', password: 'adminpass' };
const STATUS_URL = /\/api\/plugins\/backup-restore\/backup\/[^/]+$/;
const CANCEL_URL = /\/api\/plugins\/backup-restore\/backup\/[^/]+\/cancel$/;

const ALLOWED_ERROR_PATTERNS = [
  'Failed to load resource.*401' // auth status check before login
];

/**
 * Open the Backup & Restore page in the result dialog and return its frame
 * @param {Page} page
 * @returns {Promise<Frame>}
 */
async function openBackupPage(page) {
  await page.evaluate(() => { window.location.hash = 'plugin=backup-restore/manage'; });
  const iframeHandle = await page.waitForSelector('sl-dialog[open] iframe');
  const frame = await iframeHandle.contentFrame();
  if (!frame) throw new Error('Plugin iframe has no frame');
  await expect(frame.locator('#downloadBtn')).toBeVisible();
  return frame;
}

test.describe('Backup as a job', () => {

  test('a backup is created as a job and downloaded through the plugin route', async ({ page }) => {
    const consoleLogs = setupTestConsoleCapture(page);
    const stopErrorMonitoring = setupErrorFailure(consoleLogs, ALLOWED_ERROR_PATTERNS);
    try {
      await navigateAndLogin(page, TEST_ADMIN.username, TEST_ADMIN.password);
      const frame = await openBackupPage(page);

      const downloadPromise = page.waitForEvent('download');
      await frame.locator('#downloadBtn').click();
      await expect(frame.locator('#downloadStatus')).toContainText('Creating backup');
      const download = await downloadPromise;
      expect(download.suggestedFilename()).toMatch(/^backup_\d{8}_\d{6}\.zip$/);
      expect(download.url()).toMatch(/\/api\/plugins\/backup-restore\/backup\/[^/]+\/file$/);
      await expect(frame.locator('#downloadStatus')).toContainText('Download started');
      await expect(frame.locator('#downloadBtn')).toBeEnabled();

      await performLogout(page);
    } finally {
      stopErrorMonitoring();
    }
  });

  test('the progress of the job is shown and the backup can be cancelled', async ({ page }) => {
    const consoleLogs = setupTestConsoleCapture(page);
    const stopErrorMonitoring = setupErrorFailure(consoleLogs, ALLOWED_ERROR_PATTERNS);
    try {
      await navigateAndLogin(page, TEST_ADMIN.username, TEST_ADMIN.password);
      const frame = await openBackupPage(page);

      // The job of a small data directory finishes at once; stand in for a long-running one
      let cancelled = false;
      await page.route(STATUS_URL, route => route.request().method() !== 'GET' ? route.fallback() : route.fulfill({
        json: cancelled
          ? { id: 'j', status: 'cancelled', progress: {} }
          : { id: 'j', status: 'active', progress: { phase: 'Adding files', done: 3, total: 10 } },
        headers: { ETag: cancelled ? '"j-2"' : '"j-1"' }
      }));
      await page.route(CANCEL_URL, route => {
        cancelled = true;
        return route.fulfill({ json: { id: 'j', status: 'active', progress: {} } });
      });

      await frame.locator('#downloadBtn').click();
      await expect(frame.locator('#downloadStatus')).toContainText('Adding files, 3 of 10 files');
      await expect(frame.locator('#cancelBtn')).toBeVisible();
      await frame.locator('#cancelBtn').click();
      await expect(frame.locator('#downloadStatus')).toContainText('Backup cancelled', { timeout: 10000 });
      await expect(frame.locator('#downloadBtn')).toBeEnabled();

      await performLogout(page);
    } finally {
      stopErrorMonitoring();
    }
  });
});
