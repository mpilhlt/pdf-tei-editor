/**
 * Debug test - minimal test to see what's happening
 */

import { test, expect } from '../fixtures/pause-on-failure.js';
import { setupTestConsoleCapture } from './helpers/test-logging.js';

test.describe('Debug - Simple Load', () => {
  test('should load and show detailed errors', async ({ page }) => {
    // Use our test logging helper which strips formatting codes
    const consoleMessages = setupTestConsoleCapture(page);

    // Print console messages in real-time for debugging
    let lastIndex = 0;
    const printInterval = setInterval(() => {
      while (lastIndex < consoleMessages.length) {
        const { type, text } = consoleMessages[lastIndex];
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
    while (lastIndex < consoleMessages.length) {
      const { type, text } = consoleMessages[lastIndex];
      console.log(`[Browser ${type}]:`, text);
      lastIndex++;
    }

    // Log summary
    console.log('\n=== Console Messages ===');
    consoleMessages.forEach(({ type, text }) => {
      console.log(`  [${type}] ${text}`);
    });

    console.log('\n=== Page Errors ===');
    pageErrors.forEach(({ message, stack }) => {
      console.log(`  Message: ${message}`);
      console.log(`  Stack: ${stack}`);
    });

    // Check for errors
    expect(pageErrors, `Page errors: ${JSON.stringify(pageErrors)}`).toHaveLength(0);
  });
});
