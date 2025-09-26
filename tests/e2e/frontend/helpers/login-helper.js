/**
 * E2E test login helper functions
 */

import Application from '../../../app/src/modules/application';

/**
 * @import {Page} from '@playwright/test'
 * @import {api as ClientApi} from '../../../app/src/plugins/client'
 */


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
        /** @type {namedElementsTree} */
        const ui = /** @type {any} */(window).ui;
        return ui.logoutButton && ui.logoutButton.style.display !== 'none';
      } catch (error) {
        return false;
      }
    });

    if (loggedIn) {
      // Click logout button
      await page.evaluate(() => {
        /** @type {namedElementsTree} */
        const ui = /** @type {any} */(window).ui;
        if (ui.logoutButton) {
          ui.logoutButton.click();
        }
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
    await page.evaluate(async () => {
      try {
        /** @type {ClientApi} */
        const client = /** @type {any} */(window).client;
        for (fileId in await client.getAllLockedFileIds()) {
          await client.releaseLock(fileId)
        }
      } catch (error) {
        // Ignore all errors during lock cleanup
        console.debug('Lock cleanup failed:', error);
      }
    });
  } catch (evalError) {
    // Even page.evaluate might fail, just continue
    console.debug('Lock cleanup evaluation failed:', evalError);
  }
}

/**
 * Navigates to application and performs login
 * @param {import('Page} page - Playwright page object
 * @param {string} baseUrl - Base URL of the application
 * @param {string} username - Username to login with
 * @param {string} password - Password to login with
 */
export async function navigateAndLogin(page, baseUrl, username = 'testuser', password = 'testpass') {
  // Ensure clean state before starting
  await ensureCleanState(page);

  // Navigate to application
  await page.goto(baseUrl);

  // Perform login
  await performLogin(page, username, password);
}