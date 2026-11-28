/**
 * Admin job list E2E tests: the Jobs dialog of the Administration menu lists jobs of all users and cancels or deletes them.
 * Uses the core job type `test.progress`.
 *
 * @testCovers app/src/plugins/jobs-admin.js
 * @testCovers fastapi_app/lib/jobs/routes.py
 */

/**
 * @import { Page } from '@playwright/test'
 */

import { test, expect } from '../fixtures/debug-on-failure.js';
import { setupTestConsoleCapture, setupErrorFailure } from './helpers/test-logging.js';
import { navigateAndLogin } from './helpers/login-helper.js';

const ALLOWED_ERROR_PATTERNS = [
  'Failed to load resource.*401.*Unauthorized',
];

const ADMIN = { username: 'testadmin', password: 'adminpass' };
const ANNOTATOR = { username: 'testannotator', password: 'annotatorpass' };

/**
 * Submit a long `test.progress` job in the page.
 * @param {Page} page
 * @returns {Promise<string>} The job id
 */
async function submitLongJob(page) {
  return page.evaluate(async () => {
    const client = /** @type {any} */ (window).client;
    const job = await client.apiClient.jobsSubmit({ type: 'test.progress', params: { steps: 200, delay_ms: 500 } });
    return job.id;
  });
}

/**
 * @param {Page} page
 * @param {string} jobId
 */
function row(page, jobId) {
  return page.locator(`sl-dialog[name="jobsAdminDialog"] tr[data-job-id="${jobId}"]`);
}

test.describe('Admin job list', () => {

  test('admin sees, cancels and deletes a job', async ({ page }) => {
    const consoleLogs = setupTestConsoleCapture(page);
    const stopErrorMonitoring = setupErrorFailure(consoleLogs, ALLOWED_ERROR_PATTERNS);
    try {
      await navigateAndLogin(page, ADMIN.username, ADMIN.password);
      const jobId = await submitLongJob(page);
      await page.evaluate(() => {
        const item = document.querySelector('sl-menu-item[name="jobsAdminMenuItem"]');
        if (!(item instanceof HTMLElement)) throw new Error('Jobs menu item not found');
        item.click();
      });
      const dialog = page.locator('sl-dialog[name="jobsAdminDialog"]');
      await expect(dialog).toHaveAttribute('open', '', { timeout: 10000 });
      await expect(row(page, jobId)).toContainText('Progress test', { timeout: 10000 });
      await expect(row(page, jobId).locator('[data-column="status"]')).toHaveText('active', { timeout: 10000 });
      await expect(row(page, jobId).locator('[data-column="owner"]')).toHaveText(ADMIN.username);

      await row(page, jobId).locator('[data-action="cancel"]').click();
      // the status filter "unfinished" hides the job once cancelled; switch to all
      await dialog.locator('sl-select[name="statusFilter"]').evaluate((/** @type {any} */ el) => {
        el.value = 'all';
        el.dispatchEvent(new CustomEvent('sl-change', { bubbles: true }));
      });
      await expect(row(page, jobId).locator('[data-column="status"]')).toHaveText('cancelled', { timeout: 15000 });

      await row(page, jobId).locator('[data-action="delete"]').click();
      await expect(row(page, jobId)).toHaveCount(0, { timeout: 15000 });
    } finally {
      stopErrorMonitoring();
    }
  });

  test('non-admin has no Jobs menu entry', async ({ page }) => {
    const consoleLogs = setupTestConsoleCapture(page);
    const stopErrorMonitoring = setupErrorFailure(consoleLogs, ALLOWED_ERROR_PATTERNS);
    try {
      await navigateAndLogin(page, ANNOTATOR.username, ANNOTATOR.password);
      const item = page.locator('sl-menu-item[name="jobsAdminMenuItem"]');
      await expect(item).toHaveCount(1);
      await expect(item).toBeHidden();
    } finally {
      stopErrorMonitoring();
    }
  });
});
