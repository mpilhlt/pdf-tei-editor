/**
 * E2E Frontend Tests for Role-based UI Permissions
 * @testCovers app/src/plugins/access-control.js
 * @testCovers app/src/state.js
 */

import { test, expect } from '@playwright/test';
import { navigateAndLogin, performLogout } from './helpers/login-helper.js';
import { setupTestConsoleCapture, setupErrorFailure, waitForTestMessage } from './helpers/test-logging.js';

// Configuration from environment variables
const E2E_HOST = process.env.E2E_HOST || 'localhost';
const E2E_PORT = process.env.E2E_PORT || '8000';
const E2E_BASE_URL = process.env.E2E_CONTAINER_URL || `http://${E2E_HOST}:${E2E_PORT}`;

// Define allowed error patterns for role permission tests
const ALLOWED_ERROR_PATTERNS = [
  'Failed to load resource.*401.*UNAUTHORIZED', // will always be thrown when first loading without a saved state
  'Failed to load resource.*400.*BAD REQUEST', // Autocomplete validation errors
  'Failed to load autocomplete data.*No schema location found', // Expected validation warnings
  'api/validate/autocomplete-data.*400.*BAD REQUEST', // Schema validation API errors
  'offsetParent is not set.*cannot scroll', // UI scrolling errors in browser automation
  'Failed to load resource.*403.*FORBIDDEN', // Access control errors
  'Failed to load resource.*423.*LOCKED', // File locking conflicts between tests
];

// Test user credentials (passwords: testpass/annotatorpass/reviewerpass/adminpass)
const TEST_USERS = {
  user: { username: 'testuser', password: 'testpass', expectedRoles: ['user'] },
  annotator: { username: 'testannotator', password: 'annotatorpass', expectedRoles: ['annotator', 'user'] },
  reviewer: { username: 'testreviewer', password: 'reviewerpass', expectedRoles: ['reviewer', 'user'] },
  admin: { username: 'testadmin', password: 'adminpass', expectedRoles: ['admin', 'reviewer', 'annotator', 'user'] }
};

test.describe('Role-based UI Permissions', () => {

  test('User role: Can login and access application', async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    const consoleLogs = setupTestConsoleCapture(page);
    const stopErrorMonitoring = setupErrorFailure(consoleLogs, ALLOWED_ERROR_PATTERNS);

    try {
      await navigateAndLogin(page, E2E_BASE_URL, TEST_USERS.user.username, TEST_USERS.user.password);

      // Wait for user authentication to complete
      await waitForTestMessage(consoleLogs, 'USER_AUTHENTICATED', 10000);

      const state = await page.evaluate(() => {
        const app = /** @type {any} */(window).app;
        const ui = /** @type {any} */(window).ui;
        return {
          hasApp: !!app,
          hasUI: !!ui,
          state: app?.getCurrentState?.() || null
        };
      });

      // Basic checks
      expect(state.hasApp).toBe(true);
      expect(state.hasUI).toBe(true);
      expect(state.state).toBeTruthy();
      expect(state.state.user).toBeTruthy();

      // Role-specific checks
      expect(state.state.user.username).toBe(TEST_USERS.user.username);
      expect(state.state.user.roles).toEqual(TEST_USERS.user.expectedRoles);

    } finally {
      stopErrorMonitoring();
      try {
        await performLogout(page);
      } catch (error) {
        // Ignore logout errors
      }
      await context.close();
    }
  });

  test('Annotator role: Can login and access application', async ({ browser }) => {
    test.setTimeout(45000); // Increase timeout for this specific test

    const context = await browser.newContext();
    const page = await context.newPage();
    const consoleLogs = setupTestConsoleCapture(page);
    const stopErrorMonitoring = setupErrorFailure(consoleLogs, ALLOWED_ERROR_PATTERNS);

    try {
      await navigateAndLogin(page, E2E_BASE_URL, TEST_USERS.annotator.username, TEST_USERS.annotator.password);

      // Wait for user authentication to complete with longer timeout
      await waitForTestMessage(consoleLogs, 'USER_AUTHENTICATED', 15000);

      const state = await page.evaluate(() => {
        const app = /** @type {any} */(window).app;
        const ui = /** @type {any} */(window).ui;
        return {
          hasApp: !!app,
          hasUI: !!ui,
          state: app?.getCurrentState?.() || null
        };
      });

      // Basic checks
      expect(state.hasApp).toBe(true);
      expect(state.hasUI).toBe(true);
      expect(state.state).toBeTruthy();
      expect(state.state.user).toBeTruthy();

      // Role-specific checks
      expect(state.state.user.username).toBe(TEST_USERS.annotator.username);
      expect(state.state.user.roles).toEqual(TEST_USERS.annotator.expectedRoles);

    } finally {
      stopErrorMonitoring();
      try {
        await performLogout(page);
      } catch (error) {
        // Ignore logout errors
      }
      try {
        await context.close();
      } catch (error) {
        // Ignore context close errors during cleanup
      }
    }
  });

  test('Reviewer role: Can login and access application', async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    const consoleLogs = setupTestConsoleCapture(page);
    const stopErrorMonitoring = setupErrorFailure(consoleLogs, ALLOWED_ERROR_PATTERNS);

    try {
      await navigateAndLogin(page, E2E_BASE_URL, TEST_USERS.reviewer.username, TEST_USERS.reviewer.password);

      // Wait for user authentication to complete
      await waitForTestMessage(consoleLogs, 'USER_AUTHENTICATED', 10000);

      const state = await page.evaluate(() => {
        const app = /** @type {any} */(window).app;
        const ui = /** @type {any} */(window).ui;
        return {
          hasApp: !!app,
          hasUI: !!ui,
          state: app?.getCurrentState?.() || null
        };
      });

      // Basic checks
      expect(state.hasApp).toBe(true);
      expect(state.hasUI).toBe(true);
      expect(state.state).toBeTruthy();
      expect(state.state.user).toBeTruthy();

      // Role-specific checks
      expect(state.state.user.username).toBe(TEST_USERS.reviewer.username);
      expect(state.state.user.roles).toEqual(TEST_USERS.reviewer.expectedRoles);

    } finally {
      stopErrorMonitoring();
      try {
        await performLogout(page);
      } catch (error) {
        // Ignore logout errors
      }
      await context.close();
    }
  });

  test('Admin role: Can login and access application', async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    const consoleLogs = setupTestConsoleCapture(page);
    const stopErrorMonitoring = setupErrorFailure(consoleLogs, ALLOWED_ERROR_PATTERNS);

    try {
      await navigateAndLogin(page, E2E_BASE_URL, TEST_USERS.admin.username, TEST_USERS.admin.password);

      // Wait for user authentication to complete
      await waitForTestMessage(consoleLogs, 'USER_AUTHENTICATED', 10000);

      const state = await page.evaluate(() => {
        const app = /** @type {any} */(window).app;
        const ui = /** @type {any} */(window).ui;
        return {
          hasApp: !!app,
          hasUI: !!ui,
          state: app?.getCurrentState?.() || null
        };
      });

      // Basic checks
      expect(state.hasApp).toBe(true);
      expect(state.hasUI).toBe(true);
      expect(state.state).toBeTruthy();
      expect(state.state.user).toBeTruthy();

      // Role-specific checks
      expect(state.state.user.username).toBe(TEST_USERS.admin.username);
      expect(state.state.user.roles).toEqual(TEST_USERS.admin.expectedRoles);

    } finally {
      stopErrorMonitoring();
      try {
        await performLogout(page);
      } catch (error) {
        // Ignore logout errors
      }
      await context.close();
    }
  });

});