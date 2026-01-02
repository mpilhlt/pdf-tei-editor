/**
 * Debug test - minimal test to see what's happening
 */

import { test, expect } from '../fixtures/debug-on-failure.js';
import { setupTestConsoleCapture, setupErrorFailure } from './helpers/test-logging.js';

// Define allowed error patterns
const ALLOWED_ERROR_PATTERNS = [
  'Failed to load resource.*401.*Unauthorized', // Expected when checking auth status without login
];

test.describe('Debug - Simple Load', () => {
  test('should load and show detailed errors', async ({ page }) => {
    // Use our test logging helper which strips formatting codes
    const consoleLogs = setupTestConsoleCapture(page);

    // Set up automatic error failure detection
    const stopErrorMonitoring = setupErrorFailure(consoleLogs, ALLOWED_ERROR_PATTERNS);

    try {
      // Print console messages in real-time for debugging
      let lastIndex = 0;
      const printInterval = setInterval(() => {
        while (lastIndex < consoleLogs.length) {
          const { type, text } = consoleLogs[lastIndex];
          console.log(`[Browser ${type}]:`, text);
          lastIndex++;
        }
      }, 100);

      // Track page errors with full details
      const pageErrors = [];
      page.on('pageerror', error => {
        console.log('[Page Error]:', error.message);
        console.log('[Error Stack]:', error.stack);
        pageErrors.push({ message: error.message, stack: error.stack });
      });

      // Navigate
      console.log('Navigating to /...');
      await page.goto('/');

      // Wait for body
      await expect(page.locator('body')).toBeVisible();
      console.log('Body is visible');

      // Wait for app to load
      await page.waitForTimeout(3000);

      // Stop the print interval
      clearInterval(printInterval);

      // Print any remaining messages
      while (lastIndex < consoleLogs.length) {
        const { type, text } = consoleLogs[lastIndex];
        console.log(`[Browser ${type}]:`, text);
        lastIndex++;
      }

      // Log summary
      console.log('\n=== Console Messages ===');
      consoleLogs.forEach(({ type, text }) => {
        console.log(`  [${type}] ${text}`);
      });

      console.log('\n=== Page Errors ===');
      pageErrors.forEach(({ message, stack }) => {
        console.log(`  Message: ${message}`);
        console.log(`  Stack: ${stack}`);
      });

      // Check for JavaScript page errors (uncaught exceptions)
      expect(pageErrors, `Page errors: ${JSON.stringify(pageErrors)}`).toHaveLength(0);
    } finally {
      // Clean up error monitoring
      stopErrorMonitoring();
    }
  });
});
