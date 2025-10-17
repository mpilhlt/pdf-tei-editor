/**
 * End-to-end tests for application loading and basic functionality.
 * These tests ensure the application loads without critical errors.
 *
 * @testCovers app/src/*
 * 
 */

import { test, expect } from '@playwright/test';
/** @import { namedElementsTree } from '../../app/src/ui.js' */

test.describe('Application Loading', () => {
  test('should load application without critical console errors', async ({ page }) => {
    // Set up console error tracking
    /**
     * @type {any[]}
     */
    const consoleErrors = [];
    /**
     * @type {string[]}
     */
    const consoleWarnings = [];

    page.on('console', msg => {
      if (msg.type() === 'error') {
        const errorText = msg.text();
        // Filter out expected/non-critical errors
        if (!errorText.includes('offsetParent is not set') &&
            !errorText.includes('Failed to load resource: the server responded with a status of 404') &&
            !errorText.includes('Failed to load resource: the server responded with a status of 401')) {
          consoleErrors.push(errorText);
        }
      } else if (msg.type() === 'warning') {
        consoleWarnings.push(msg.text());
      }
    });

    // Track uncaught exceptions
    /**
     * @type {any[]}
     */
    const pageErrors = [];
    page.on('pageerror', error => {
      pageErrors.push(error.message);
    });

    // Navigate to application
    await page.goto('/');

    // Wait for application to be ready - look for the main application container
    await expect(page.locator('body')).toBeVisible();

    // Wait a bit for any async loading to complete
    await page.waitForTimeout(2000);

    // Check that no critical console errors occurred
    expect(consoleErrors, `Critical console errors found: ${consoleErrors.join(', ')}`).toHaveLength(0);

    // Check that no page errors occurred
    expect(pageErrors, `Page errors found: ${pageErrors.join(', ')}`).toHaveLength(0);

    // Verify basic application structure is present
    // The app should have loaded and show either the login form or main interface

    const hasLoginForm = await page.evaluate(() => {
      /** @type {namedElementsTree} */ 
      const ui = /** @type {any} */(window).ui;
      return ui.loginDialog.hidden === false;
    });
    
    expect(hasLoginForm, `Application should show login form`).toBeTruthy();

    // Log any warnings for informational purposes (but don't fail the test)
    if (consoleWarnings.length > 0) {
      console.log(`Console warnings (informational): ${consoleWarnings.join(', ')}`);
    }
  });

});