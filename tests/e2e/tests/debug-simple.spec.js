/**
 * Debug test - minimal test to see what's happening
 */

import { test, expect } from '@playwright/test';

test.describe('Debug - Simple Load', () => {
  test('should load and show detailed errors', async ({ page }) => {
    // Track all console messages
    const consoleMessages = [];
    page.on('console', msg => {
      const type = msg.type();
      const text = msg.text();
      consoleMessages.push({ type, text });
      console.log(`[Browser ${type}]:`, text);
    });

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

    // Log what we found
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
