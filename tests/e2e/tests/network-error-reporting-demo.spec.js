/**
 * Demonstration of enhanced network error reporting in E2E tests
 *
 * This test intentionally triggers a 404 error to demonstrate the
 * improved error reporting that includes network request details.
 */

import { test } from '../fixtures/debug-on-failure.js';
import { setupTestConsoleCapture, setupErrorFailure } from './helpers/test-logging.js';
import { navigateAndLogin, performLogout } from './helpers/login-helper.js';

test.describe('Network Error Reporting Demo', () => {
  // This test is intentionally skipped - it's a demo that shows enhanced error reporting
  // Run manually with: npm run test:e2e -- --grep "demonstrates enhanced 404"
  test.skip('demonstrates enhanced 404 error reporting', async ({ page }) => {
    // Set up enhanced console log capture with network tracking
    const consoleLogs = setupTestConsoleCapture(page);

    // Allow expected 401 errors during login
    const allowedErrors = [
      'Failed to load resource.*401.*UNAUTHORIZED'
    ];
    const stopErrorMonitoring = setupErrorFailure(consoleLogs, allowedErrors);

    try {
      // Navigate and login with correct credentials
      await navigateAndLogin(page, 'testreviewer', 'reviewerpass');

      // Intentionally trigger a 404 by fetching a non-existent resource
      // The browser will log an error to console when fetch fails
      await page.evaluate(() => {
        fetch('/api/v1/nonexistent-endpoint');
      });

      // Wait a bit for the error to be logged
      await page.waitForTimeout(2000);

      // This test will fail with enhanced error details showing:
      // 1. The console error message
      // 2. Recent failed network requests (including the 404)
      // 3. Recent network activity

    } finally {
      await performLogout(page);
      stopErrorMonitoring();
      await page.close();
    }
  });
});
