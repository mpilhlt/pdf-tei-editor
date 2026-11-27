/**
 * Jobs plugin E2E tests: progress widgets of jobs, cancel, reload and error notifications.
 * Uses the core job type `test.progress` (params `steps`, `delay_ms`, `fail`).
 *
 * @testCovers app/src/plugins/jobs.js
 * @testCovers app/src/modules/job-client.js
 * @testCovers fastapi_app/lib/jobs/core_types.py
 */

/**
 * @import { api as Client } from '../../../app/src/plugins/client.js'
 * @import { Page } from '@playwright/test'
 */

import { test, expect } from '../fixtures/debug-on-failure.js';
import { setupTestConsoleCapture, setupErrorFailure, waitForTestMessage } from './helpers/test-logging.js';
import { navigateAndLogin } from './helpers/login-helper.js';

const ALLOWED_ERROR_PATTERNS = [
  'Failed to load resource.*401.*Unauthorized',
];

// a user of its own, so that the jobs of these tests do not show up in other specs
const USERNAME = 'testannotator';
const PASSWORD = 'annotatorpass';

/**
 * Submit a `test.progress` job in the page.
 * @param {Page} page
 * @param {{steps?: number, delay_ms?: number, fail?: boolean}} params
 * @returns {Promise<string>} The job id
 */
async function submitProgressJob(page, params) {
  return page.evaluate(async (params) => {
    /** @type {Client} */
    const client = /** @type {any} */ (window).client;
    const job = await client.apiClient.jobsSubmit({ type: 'test.progress', params });
    return job.id;
  }, params);
}

/**
 * @param {Page} page
 * @param {string} jobId
 */
function widget(page, jobId) {
  return page.locator(`.progress-widget[data-progress-id="job-${jobId}"]`);
}

test.describe('Jobs progress widgets', () => {

  test('shows a widget for a running job and hides it when done', async ({ page }) => {
    const consoleLogs = setupTestConsoleCapture(page);
    const stopErrorMonitoring = setupErrorFailure(consoleLogs, ALLOWED_ERROR_PATTERNS);
    try {
      await navigateAndLogin(page, USERNAME, PASSWORD);
      await waitForTestMessage(consoleLogs, 'JOBS_SUBSCRIBED', 15000);
      const jobId = await submitProgressJob(page, { steps: 4, delay_ms: 400 });

      await expect(widget(page, jobId)).toBeVisible({ timeout: 10000 });
      await expect(widget(page, jobId).locator('[name="titleRow"]')).toHaveText('Progress test');
      await expect(widget(page, jobId).locator('[name="labelRow"]')).toContainText('of 4', { timeout: 10000 });
      await expect(widget(page, jobId)).toHaveCount(0, { timeout: 15000 });
    } finally {
      stopErrorMonitoring();
    }
  });

  test('cancel button cancels the job', async ({ page }) => {
    const consoleLogs = setupTestConsoleCapture(page);
    const stopErrorMonitoring = setupErrorFailure(consoleLogs, ALLOWED_ERROR_PATTERNS);
    try {
      await navigateAndLogin(page, USERNAME, PASSWORD);
      await waitForTestMessage(consoleLogs, 'JOBS_SUBSCRIBED', 15000);
      const jobId = await submitProgressJob(page, { steps: 50, delay_ms: 300 });

      await expect(widget(page, jobId)).toBeVisible({ timeout: 10000 });
      await page.waitForTimeout(500);
      await widget(page, jobId).locator('[data-name="cancelBtn"]').click();

      await expect.poll(async () => page.evaluate(async (id) => {
        /** @type {Client} */
        const client = /** @type {any} */ (window).client;
        return (await client.apiClient.jobsGet(id)).status;
      }, jobId), { timeout: 15000 }).toBe('cancelled');
      await expect(widget(page, jobId)).toHaveCount(0, { timeout: 10000 });
    } finally {
      stopErrorMonitoring();
    }
  });

  test('widget comes back after reload', async ({ page }) => {
    const consoleLogs = setupTestConsoleCapture(page);
    const stopErrorMonitoring = setupErrorFailure(consoleLogs, ALLOWED_ERROR_PATTERNS);
    try {
      await navigateAndLogin(page, USERNAME, PASSWORD);
      await waitForTestMessage(consoleLogs, 'JOBS_SUBSCRIBED', 15000);
      const jobId = await submitProgressJob(page, { steps: 20, delay_ms: 300 });
      await expect(widget(page, jobId)).toBeVisible({ timeout: 10000 });

      consoleLogs.length = 0;
      await page.reload();
      if (await page.locator('sl-dialog[name="loginDialog"][open]').isVisible({ timeout: 5000 }).catch(() => false)) {
        await navigateAndLogin(page, USERNAME, PASSWORD);
      }
      await waitForTestMessage(consoleLogs, 'JOBS_SUBSCRIBED', 15000);

      await expect(widget(page, jobId)).toBeVisible({ timeout: 10000 });
      const result = await page.evaluate(async (id) => /** @type {any} */ (window).jobs.wait(id), jobId);
      expect(result).toEqual({ steps: 20 });
      await expect(widget(page, jobId)).toHaveCount(0, { timeout: 10000 });
    } finally {
      stopErrorMonitoring();
    }
  });

  test('error is notified', async ({ page }) => {
    const consoleLogs = setupTestConsoleCapture(page);
    const stopErrorMonitoring = setupErrorFailure(consoleLogs, ALLOWED_ERROR_PATTERNS);
    try {
      await navigateAndLogin(page, USERNAME, PASSWORD);
      await waitForTestMessage(consoleLogs, 'JOBS_SUBSCRIBED', 15000);
      const jobId = await submitProgressJob(page, { steps: 2, delay_ms: 200, fail: true });

      await expect(page.locator('sl-alert[variant="danger"]')).toContainText('Test failure', { timeout: 15000 });
      await expect(widget(page, jobId)).toHaveCount(0, { timeout: 10000 });
    } finally {
      stopErrorMonitoring();
    }
  });
});
