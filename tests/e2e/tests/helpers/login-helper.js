/**
 * E2E test login helper functions
 */

/**
 * @import {Page} from '@playwright/test'
 * @import {api as ClientApi} from '../../../../app/src/plugins/client.js'
 * @import {namedElementsTree} from '../../../../app/src/ui.js'
 * @import {Application} from '../../../../app/src/modules/application.js'
 */

import { debugLog } from './debug-helpers.js';

/**
 * Performs login flow for E2E tests
 * @param {Page} page - Playwright page object
 * @param {string} username - Username to login with
 * @param {string} password - Password to login with
 */
export async function performLogin(page, username = 'testuser', password = 'testpass') {
  // Wait for application to load and show login dialog
  await page.waitForSelector('sl-dialog[name="loginDialog"][open]', { timeout: 10000 });

  // Fast login
  await page.evaluate((credentials) => {
    /** @type {namedElementsTree} */
    const ui = /** @type {any} */(window).ui;
    ui.loginDialog.username.value = credentials.username;
    ui.loginDialog.password.value = credentials.password;
    ui.loginDialog.submit.click();
  }, { username, password });

  // Wait for login to complete
  await page.waitForSelector('sl-dialog[name="loginDialog"]:not([open])', { timeout: 5000 });

  // Wait for UI to be fully ready
  await page.waitForTimeout(2000);
}

/**
 * Performs logout flow for E2E tests
 * @param {Page} page - Playwright page object
 */
export async function performLogout(page) {
  try {
    // Check if user is logged in by looking for logout button
    const loggedIn = await page.evaluate(() => {
      try {
        /** @type {Application} */
        const app = /** @type {any} */(window).app;
        return app.getCurrentState().user !== null
      } catch (error) {
        return false;
      }
    });

    if (loggedIn) {
      // Click logout button
      await page.evaluate(() => {
        /** @type {namedElementsTree} */
        const ui = /** @type {any} */(window).ui;
        ui.toolbar.logoutButton.click();
      });

      // Wait for logout to complete - login dialog should appear
      await page.waitForSelector('sl-dialog[name="loginDialog"][open]', { timeout: 5000 });
    }
  } catch (error) {
    // If logout fails, try to clear storage as fallback (but handle SecurityErrors gracefully)
    try {
      await page.evaluate(() => {
        try {
          localStorage.clear();
          sessionStorage.clear();
        } catch (storageError) {
          // Storage might not be accessible, ignore this error
        }
      });
    } catch (evalError) {
      // Even page.evaluate might fail, just continue
    }
  }
}

/**
 * Ensures clean test state by clearing browser storage and logging out
 * @param {Page} page - Playwright page object
 */
export async function ensureCleanState(page) {
  // Clear browser storage (handle SecurityErrors gracefully)
  try {
    await page.evaluate(() => {
      try {
        localStorage.clear();
        sessionStorage.clear();
      } catch (storageError) {
        // Storage might not be accessible, ignore this error
      }
    });
  } catch (evalError) {
    // Even page.evaluate might fail, just continue
  }

  // Clear cookies
  try {
    await page.context().clearCookies();
  } catch (cookieError) {
    // Cookie clearing might fail, continue anyway
  }

  // If already on the page, perform logout
  try {
    await performLogout(page);
  } catch (error) {
    // Ignore logout errors - we're cleaning state anyway
  }
}

/**
 * Releases all locks held by the current user session
 * @param {Page} page - Playwright page object
 */
export async function releaseAllLocks(page) {
  try {
    debugLog('Starting lock cleanup...');
    // Add timeout to prevent hanging
    const result = await Promise.race([
      page.evaluate(async () => {
        try {
          /** @type {ClientApi} */
          const client = /** @type {any} */(window).client;
          if (!client) {
            return { success: false, reason: 'No client object found' };
          }

          const response = await client.getAllLockedFileIds();

          // The API returns {locked_files: [...]} not a plain array
          const lockedFileIds = response?.locked_files || [];

          for (const fileId of lockedFileIds) {
            await client.releaseLock(fileId);
          }
          return { success: true, count: lockedFileIds.length };
        } catch (error) {
          // Ignore all errors during lock cleanup
          return { success: false, error: String(error) };
        }
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Lock cleanup timeout after 10 seconds')), 10000))
    ]);
    debugLog('Lock cleanup completed:', result);
  } catch (evalError) {
    // Even page.evaluate might fail, just continue
    debugLog('Lock cleanup evaluation failed:', evalError.message);
  }
}

/**
 * Navigates to application and performs login
 * @param {import('Page} page - Playwright page object
 * @param {string} [baseUrl] - Base URL of the application (deprecated, uses Playwright baseURL by default)
 * @param {string} username - Username to login with
 * @param {string} password - Password to login with
 */
export async function navigateAndLogin(page, baseUrl, username = 'testuser', password = 'testpass') {
  // If baseUrl is actually a username (for backwards compatibility when baseUrl is omitted)
  if (baseUrl && !baseUrl.startsWith('http')) {
    password = username;
    username = baseUrl;
    baseUrl = '/';
  }

  // Navigate to application first (use relative URL to leverage Playwright's baseURL config)
  await page.goto(baseUrl || '/');

  // Perform login (app will handle if already logged in)
  await performLogin(page, username, password);
}