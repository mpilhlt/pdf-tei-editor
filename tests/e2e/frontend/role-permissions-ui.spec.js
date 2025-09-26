/**
 * E2E Frontend Tests for Role-based UI Permissions
 * @testCovers app/src/plugins/access-control.js
 * @testCovers app/src/state.js
 */

import { test, expect } from '@playwright/test';
import { navigateAndLogin, performLogout, releaseAllLocks } from '../helpers/login-helper.js';
import { setupTestConsoleCapture, setupErrorFailure } from '../helpers/test-logging.js';
import Application from '../../app/src/modules/application.js';

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
  user: { username: 'testuser', password: 'testpass', expectedReadOnly: true },
  annotator: { username: 'testannotator', password: 'annotatorpass', expectedReadOnly: false },
  reviewer: { username: 'testreviewer', password: 'reviewerpass', expectedReadOnly: false },
  admin: { username: 'testadmin', password: 'adminpass', expectedReadOnly: false }
};

test.describe('Role-based UI Permissions', () => {

  test('User role: Can login and access application', async ({ page }) => {
    // Set up enhanced console log capture for TEST messages
    const consoleLogs = setupTestConsoleCapture(page);

    // Set up automatic error failure detection
    const stopErrorMonitoring = setupErrorFailure(consoleLogs, ALLOWED_ERROR_PATTERNS);

    try {
      // Navigate and login as user
      await navigateAndLogin(page, E2E_BASE_URL, TEST_USERS.user.username, TEST_USERS.user.password);

    // Wait for complete application state to be ready, including user data and access control
    const loginState = await page.evaluate(async () => {
      /** @type {namedElementsTree} */
      const ui = /** @type {any} */(window).ui;
      const app = /** @type {any} */(window).app;

      // Wait for application state to be fully ready, max 15 seconds
      let attempts = 0;
      const maxAttempts = 150; // 15 seconds with 100ms intervals

      while (attempts < maxAttempts) {
        // Get current state using the public API
        let currentState = null;
        try {
          currentState = app?.getCurrentState?.();
        } catch (error) {
          // State not initialized yet
        }

        // Check if user is authenticated and roles are set
        const hasUser = currentState?.user;
        const hasRoles = currentState?.user?.roles && currentState.user.roles.length > 0;
        const hasSessionId = currentState?.sessionId;

        if (hasUser && hasRoles && hasSessionId) {
          // User state is ready, now wait a bit longer for access control to complete
          // The editorReadOnly state might still be updating
          await new Promise(resolve => setTimeout(resolve, 500));
          break;
        }

        await new Promise(resolve => setTimeout(resolve, 100));
        attempts++;
      }

      // Get final state for return
      let finalState = null;
      try {
        finalState = app?.getCurrentState?.();
      } catch (error) {
        // State not initialized yet
      }

      return {
        hasUI: !!ui,
        hasApp: !!app,
        hasLogoutButton: !!(ui?.toolbar?.logoutButton),
        loginDialogOpen: !!(ui?.loginDialog?.open),
        userRoles: finalState?.user?.roles || null,
        editorReadOnly: finalState?.editorReadOnly,
        // Debug info
        hasUser: !!(finalState?.user),
        username: finalState?.user?.username || null,
        sessionId: finalState?.sessionId || null,
        attempts: attempts
      };
    });


    // Verify the testing environment is working correctly
    expect(loginState.hasUI).toBe(true);
    expect(loginState.hasApp).toBe(true);

    // Verify successful login
    expect(loginState.hasLogoutButton).toBe(true);
    expect(loginState.loginDialogOpen).toBe(false);
    expect(loginState.userRoles).toEqual(['user']);
    expect(loginState.username).toBe('testuser');

    // For user role with no document loaded, editor defaults to false
    // Note: editorReadOnly is set to true only when a specific document is loaded
    // and access control determines the user cannot edit that specific document
    expect(loginState.editorReadOnly).toBe(false);

      // logout
      await performLogout(page);
    } finally {
      // Release all locks before cleanup
      await releaseAllLocks(page);
      // Clean up error monitoring
      stopErrorMonitoring();
      await page.close();
    }
  });

  test('Annotator role: Can login and access application', async ({ page }) => {
    // Set up enhanced console log capture for TEST messages
    const consoleLogs = setupTestConsoleCapture(page);

    // Set up automatic error failure detection
    const stopErrorMonitoring = setupErrorFailure(consoleLogs, ALLOWED_ERROR_PATTERNS);

    try {
      // Navigate and login as annotator
      await navigateAndLogin(page, E2E_BASE_URL, TEST_USERS.annotator.username, TEST_USERS.annotator.password);

    // Wait for complete application state to be ready, including user data and access control
    const loginState = await page.evaluate(async () => {
      /** @type {namedElementsTree} */
      const ui = /** @type {any} */(window).ui;
      const app = /** @type {any} */(window).app;

      // Wait for application state to be fully ready, max 15 seconds
      let attempts = 0;
      const maxAttempts = 150; // 15 seconds with 100ms intervals

      while (attempts < maxAttempts) {
        // Get current state using the public API
        let currentState = null;
        try {
          currentState = app?.getCurrentState?.();
        } catch (error) {
          // State not initialized yet
        }

        // Check if user is authenticated and roles are set
        const hasUser = currentState?.user;
        const hasRoles = currentState?.user?.roles && currentState.user.roles.length > 0;
        const hasSessionId = currentState?.sessionId;

        if (hasUser && hasRoles && hasSessionId) {
          // User state is ready, now wait a bit longer for access control to complete
          await new Promise(resolve => setTimeout(resolve, 500));
          break;
        }

        await new Promise(resolve => setTimeout(resolve, 100));
        attempts++;
      }

      // Get final state for return
      let finalState = null;
      try {
        finalState = app?.getCurrentState?.();
      } catch (error) {
        // State not initialized yet
      }

      return {
        hasLogoutButton: !!(ui?.toolbar?.logoutButton),
        loginDialogOpen: !!(ui?.loginDialog?.open),
        userRoles: finalState?.user?.roles || null,
        editorReadOnly: finalState?.editorReadOnly,
        username: finalState?.user?.username || null
      };
    });

    // Verify successful login and role permissions
    expect(loginState.hasLogoutButton).toBe(true);
    expect(loginState.loginDialogOpen).toBe(false);
    expect(loginState.userRoles).toEqual(['annotator', 'user']);
    expect(loginState.username).toBe('testannotator');

    // For annotator role, editor should NOT be read-only
    expect(loginState.editorReadOnly).toBe(false);

      // logout
      await performLogout(page);
    } finally {
      // Release all locks before cleanup
      await releaseAllLocks(page);
      // Clean up error monitoring
      stopErrorMonitoring();
      await page.close();
    }
  });

  test('Reviewer role: Can login and access application', async ({ page }) => {
    // Set up enhanced console log capture for TEST messages
    const consoleLogs = setupTestConsoleCapture(page);

    // Set up automatic error failure detection
    const stopErrorMonitoring = setupErrorFailure(consoleLogs, ALLOWED_ERROR_PATTERNS);

    try {
      // Navigate and login as reviewer
      await navigateAndLogin(page, E2E_BASE_URL, TEST_USERS.reviewer.username, TEST_USERS.reviewer.password);

    // Wait for complete application state to be ready, including user data and access control
    const loginState = await page.evaluate(async () => {
      /** @type {namedElementsTree} */
      const ui = /** @type {any} */(window).ui;
      const app = /** @type {any} */(window).app;

      // Wait for application state to be fully ready, max 15 seconds
      let attempts = 0;
      const maxAttempts = 150; // 15 seconds with 100ms intervals

      while (attempts < maxAttempts) {
        // Get current state using the public API
        let currentState = null;
        try {
          currentState = app?.getCurrentState?.();
        } catch (error) {
          // State not initialized yet
        }

        // Check if user is authenticated and roles are set
        const hasUser = currentState?.user;
        const hasRoles = currentState?.user?.roles && currentState.user.roles.length > 0;
        const hasSessionId = currentState?.sessionId;

        if (hasUser && hasRoles && hasSessionId) {
          // User state is ready, now wait a bit longer for access control to complete
          await new Promise(resolve => setTimeout(resolve, 500));
          break;
        }

        await new Promise(resolve => setTimeout(resolve, 100));
        attempts++;
      }

      // Get final state for return
      let finalState = null;
      try {
        finalState = app?.getCurrentState?.();
      } catch (error) {
        // State not initialized yet
      }

      return {
        hasLogoutButton: !!(ui?.toolbar?.logoutButton),
        loginDialogOpen: !!(ui?.loginDialog?.open),
        userRoles: finalState?.user?.roles || null,
        editorReadOnly: finalState?.editorReadOnly,
        username: finalState?.user?.username || null
      };
    });

    // Verify successful login and role permissions
    expect(loginState.hasLogoutButton).toBe(true);
    expect(loginState.loginDialogOpen).toBe(false);
    expect(loginState.userRoles).toEqual(['reviewer', 'user']);
    expect(loginState.username).toBe('testreviewer');

    // For reviewer role, editor should NOT be read-only
    expect(loginState.editorReadOnly).toBe(false);

      // logout
      await performLogout(page);
    } finally {
      // Release all locks before cleanup
      await releaseAllLocks(page);
      // Clean up error monitoring
      stopErrorMonitoring();
      await page.close();
    }
  });

  test('Admin role: Can login and access application', async ({ page }) => {
    // Set up enhanced console log capture for TEST messages
    const consoleLogs = setupTestConsoleCapture(page);

    // Set up automatic error failure detection
    const stopErrorMonitoring = setupErrorFailure(consoleLogs, ALLOWED_ERROR_PATTERNS);

    try {
      // Navigate and login as admin
      await navigateAndLogin(page, E2E_BASE_URL, TEST_USERS.admin.username, TEST_USERS.admin.password);

    // Wait for complete application state to be ready, including user data and access control
    const loginState = await page.evaluate(async () => {
      /** @type {namedElementsTree} */
      const ui = /** @type {any} */(window).ui;
      /** @type {Application} */
      const app = /** @type {any} */(window).app;

      // Wait for application state to be fully ready, max 15 seconds
      let attempts = 0;
      const maxAttempts = 150; // 15 seconds with 100ms intervals

      while (attempts < maxAttempts) {
        // Get current state using the public API
        let currentState = null;
        try {
          currentState = app.getCurrentState();
        } catch (error) {
          // State not initialized yet
        }

        // Check if user is authenticated and roles are set
        const hasUser = currentState?.user;
        const hasRoles = currentState?.user?.roles && currentState.user.roles.length > 0;
        const hasSessionId = currentState?.sessionId;

        if (hasUser && hasRoles && hasSessionId) {
          // User state is ready, now wait a bit longer for access control to complete
          await new Promise(resolve => setTimeout(resolve, 500));
          break;
        }

        await new Promise(resolve => setTimeout(resolve, 100));
        attempts++;
      }

      // Get final state for return
      let finalState = null;
      try {
        finalState = app?.getCurrentState?.();
      } catch (error) {
        // State not initialized yet
      }

      return {
        hasLogoutButton: !!(ui?.toolbar?.logoutButton),
        loginDialogOpen: !!(ui?.loginDialog?.open),
        userRoles: finalState?.user?.roles || null,
        editorReadOnly: finalState?.editorReadOnly,
        username: finalState?.user?.username || null
      };
    });

    // Verify successful login and role permissions
    expect(loginState.hasLogoutButton).toBe(true);
    expect(loginState.loginDialogOpen).toBe(false);
    expect(loginState.userRoles).toEqual(['admin', 'reviewer', 'annotator', 'user']);
    expect(loginState.username).toBe('testadmin');

    // For admin role, editor should NOT be read-only
    expect(loginState.editorReadOnly).toBe(false);

      // cleanup
      await performLogout(page);
    } finally {
      // Release all locks before cleanup
      await releaseAllLocks(page);
      // Clean up error monitoring
      stopErrorMonitoring();
      await page.close();
    }
  });

});