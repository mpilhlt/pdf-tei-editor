/**
 * End-to-end tests for application loading and basic functionality.
 * These tests ensure the application loads without critical errors.
 *
 * @testCovers app/src/*
 */

import { test, expect } from '@playwright/test';

test.describe('Application Loading', () => {
  test('should load application without critical console errors', async ({ page }) => {
    // Set up console error tracking
    const consoleErrors = [];
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
    const hasLoginForm = await page.locator('sl-input[name="username"]').isVisible();
    const hasMainInterface = await page.locator('[name="app-container"]').isVisible();

    expect(hasLoginForm || hasMainInterface, 'Application should show either login form or main interface').toBeTruthy();

    // Log any warnings for informational purposes (but don't fail the test)
    if (consoleWarnings.length > 0) {
      console.log(`Console warnings (informational): ${consoleWarnings.join(', ')}`);
    }
  });

  test('should load development mode without critical console errors', async ({ page }) => {
    // Set up console error tracking
    const consoleErrors = [];

    page.on('console', msg => {
      if (msg.type() === 'error') {
        const errorText = msg.text();
        // Filter out expected/non-critical errors
        if (!errorText.includes('offsetParent is not set') &&
            !errorText.includes('Failed to load resource: the server responded with a status of 404') &&
            !errorText.includes('Failed to load resource: the server responded with a status of 401')) {
          consoleErrors.push(errorText);
        }
      }
    });

    // Track uncaught exceptions
    const pageErrors = [];
    page.on('pageerror', error => {
      pageErrors.push(error.message);
    });

    // Navigate to application in development mode
    await page.goto('/?dev');

    // Wait for application to be ready
    await expect(page.locator('body')).toBeVisible();

    // Wait for development mode specific loading (import maps, etc.)
    await page.waitForTimeout(3000);

    // Check that no critical console errors occurred
    expect(consoleErrors, `Critical console errors in dev mode: ${consoleErrors.join(', ')}`).toHaveLength(0);

    // Check that no page errors occurred
    expect(pageErrors, `Page errors in dev mode: ${pageErrors.join(', ')}`).toHaveLength(0);

    // Verify application loaded in development mode
    const hasLoginForm = await page.locator('sl-input[name="username"]').isVisible();
    const hasMainInterface = await page.locator('[name="app-container"]').isVisible();

    expect(hasLoginForm || hasMainInterface, 'Application should load in development mode').toBeTruthy();
  });
});