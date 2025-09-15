/**
 * Authentication workflow end-to-end tests
 *
 * @testCovers app/src/plugins/authentication.js
 * @testCovers server/api/auth.py
 */

/** @import { namedElementsTree } from '../../app/src/ui.js' */

import { test, expect } from '@playwright/test';

// Configuration from environment variables
const E2E_HOST = process.env.E2E_HOST || 'localhost';
const E2E_PORT = process.env.E2E_PORT || '8000';
const E2E_BASE_URL = process.env.E2E_CONTAINER_URL || `http://${E2E_HOST}:${E2E_PORT}`;

test.describe('Authentication Workflow', () => {

  test('should complete full login and logout cycle', async ({ page }) => {
    // Set up console logging capture
    /**
     * @type {any[]}
     */
    const consoleLogs = [];
    page.on('console', msg => {
      if (msg.type() === 'log' || msg.type() === 'info') {
        consoleLogs.push({
          type: msg.type(),
          text: msg.text()
        });
      }
    });

    // Navigate to application
    await page.goto(E2E_BASE_URL);

    // Wait for application to load and show login dialog
    await page.waitForSelector('sl-dialog[open]', { timeout: 10000 });

    // Verify login dialog is visible using UI navigation system
    const loginDialogVisible = await page.evaluate(() => {
      /** @type {namedElementsTree} */
      const ui = /** @type {any} */(window).ui;
      return ui.loginDialog.open === true;
    });
    expect(loginDialogVisible).toBe(true);

    // Fill in login credentials using UI navigation system
    await page.evaluate(() => {
      /** @type {namedElementsTree} */
      const ui = /** @type {any} */(window).ui;
      ui.loginDialog.username.value = 'testuser';
      ui.loginDialog.password.value = 'testpass';
    });

    // Verify credentials were set
    const credentials = await page.evaluate(() => {
      /** @type {namedElementsTree} */
      const ui = /** @type {any} */(window).ui;
      return {
        username: ui.loginDialog.username.value,
        password: ui.loginDialog.password.value
      };
    });
    expect(credentials.username).toBe('testuser');
    expect(credentials.password).toBe('testpass');

    // Submit login form
    await page.evaluate(() => {
      /** @type {namedElementsTree} */
      const ui = /** @type {any} */(window).ui;
      ui.loginDialog.submit.click();
    });

    // Wait for login to complete and dialog to hide
    await page.waitForSelector('sl-dialog:not([open])', { timeout: 5000 });

    // Verify login dialog is now hidden
    const loginDialogHidden = await page.evaluate(() => {
      /** @type {namedElementsTree} */
      const ui = /** @type {any} */(window).ui;
      return ui.loginDialog.open === false;
    });
    expect(loginDialogHidden).toBe(true);

    // Verify successful login message in console logs
    await page.waitForTimeout(1000); // Give time for console logs
    const loginSuccessLog = consoleLogs.find(log =>
      log.text.includes('Login successful for user: testuser')
    );
    expect(loginSuccessLog).toBeDefined();

    // Wait for logout button to be enabled
    await page.waitForTimeout(2000);

    // Verify logout button is now enabled
    const logoutButtonEnabled = await page.evaluate(() => {
      /** @type {namedElementsTree} */
      const ui = /** @type {any} */(window).ui;
      return !ui.toolbar.logoutButton.disabled;
    });
    expect(logoutButtonEnabled).toBe(true);

    // Clear console logs for logout test
    consoleLogs.length = 0;

    // Perform logout using UI navigation system
    await page.evaluate(() => {
      /** @type {namedElementsTree} */
      const ui = /** @type {any} */(window).ui;
      ui.toolbar.logoutButton.click();
    });

    // Wait for logout to complete and login dialog to reappear
    await page.waitForSelector('sl-dialog[open]', { timeout: 5000 });

    // Verify login dialog is visible again after logout
    const loginDialogVisibleAgain = await page.evaluate(() => {
      /** @type {namedElementsTree} */
      const ui = /** @type {any} */(window).ui;
      return ui.loginDialog.open === true;
    });
    expect(loginDialogVisibleAgain).toBe(true);

    // Verify successful logout message in console logs
    await page.waitForTimeout(1000);
    const logoutSuccessLog = consoleLogs.find(log =>
      log.text.includes('User logged out successfully')
    );
    expect(logoutSuccessLog).toBeDefined();

    // Verify logout button is disabled after logout
    const logoutButtonDisabled = await page.evaluate(() => {
      /** @type {namedElementsTree} */
      const ui = /** @type {any} */(window).ui;
      return ui.toolbar.logoutButton.disabled;
    });
    expect(logoutButtonDisabled).toBe(true);
  });

  test('should handle invalid login credentials', async ({ page }) => {
    // Set up console logging capture
    /** @type {{type:string,text:string}[]} */
    const consoleLogs = [];
    page.on('console', msg => {
      if (msg.type() === 'error') {
        consoleLogs.push({
          type: msg.type(),
          text: msg.text()
        });
      }
    });

    // Navigate to application
    await page.goto(E2E_BASE_URL);

    // Wait for login dialog
    await page.waitForSelector('sl-dialog[open]', { timeout: 10000 });

    // Fill in invalid credentials
    await page.evaluate(() => {
      /** @type {namedElementsTree} */
      const ui = /** @type {any} */(window).ui;
      ui.loginDialog.username.value = 'invaliduser';
      ui.loginDialog.password.value = 'invalidpass';
    });

    // Submit login form
    await page.evaluate(() => {
      /** @type {namedElementsTree} */
      const ui = /** @type {any} */(window).ui;
      ui.loginDialog.submit.click();
    });

    // Wait for error message to appear
    await page.waitForTimeout(2000);

    // Verify error message is displayed
    const errorMessage = await page.evaluate(() => {
      /** @type {namedElementsTree} */
      const ui = /** @type {any} */(window).ui;
      return ui.loginDialog.message.textContent;
    });
    expect(errorMessage).toBe('Wrong username or password');

    // Verify login dialog remains open
    const loginDialogStillOpen = await page.evaluate(() => {
      /** @type {namedElementsTree} */
      const ui = /** @type {any} */(window).ui;
      return ui.loginDialog.open === true;
    });
    expect(loginDialogStillOpen).toBe(true);

    // Verify error was logged
    const errorLog = consoleLogs.find(log =>
      log.text.includes('Login failed:')
    );
    expect(errorLog).toBeDefined();
  });

  test('should handle Enter key navigation in login form', async ({ page }) => {
    // Navigate to application
    await page.goto(E2E_BASE_URL);

    // Wait for login dialog
    await page.waitForSelector('sl-dialog[open]', { timeout: 10000 });

    // Focus on username field and enter username
    await page.evaluate(() => {
      /** @type {namedElementsTree} */
      const ui = /** @type {any} */(window).ui;
      ui.loginDialog.username.focus();
      ui.loginDialog.username.value = 'testuser';
    });

    // Press Enter to move to password field
    await page.evaluate(() => {
      /** @type {namedElementsTree} */
      const ui = /** @type {any} */(window).ui;
      const event = new KeyboardEvent('keydown', { key: 'Enter' });
      ui.loginDialog.username.dispatchEvent(event);
    });

    // Verify focus moved to password field
    await page.waitForTimeout(100);
    const passwordFocused = await page.evaluate(() => {
      /** @type {namedElementsTree} */
      const ui = /** @type {any} */(window).ui;
      return document.activeElement === ui.loginDialog.password;
    });
    expect(passwordFocused).toBe(true);

    // Enter password
    await page.evaluate(() => {
      /** @type {namedElementsTree} */
      const ui = /** @type {any} */(window).ui;
      ui.loginDialog.password.value = 'testpass';
    });

    // Press Enter to submit form
    await page.evaluate(() => {
      /** @type {namedElementsTree} */
      const ui = /** @type {any} */(window).ui;
      const event = new KeyboardEvent('keydown', { key: 'Enter' });
      ui.loginDialog.password.dispatchEvent(event);
    });

    // Wait for login to complete
    await page.waitForSelector('sl-dialog:not([open])', { timeout: 5000 });

    // Verify login was successful
    const loginDialogHidden = await page.evaluate(() => {
      /** @type {namedElementsTree} */
      const ui = /** @type {any} */(window).ui;
      return ui.loginDialog.open === false;
    });
    expect(loginDialogHidden).toBe(true);
  });

  test('should preserve login dialog state during failed attempts', async ({ page }) => {
    // Navigate to application
    await page.goto(E2E_BASE_URL);

    // Wait for login dialog
    await page.waitForSelector('sl-dialog[open]', { timeout: 10000 });

    // Try to close dialog (should be prevented)
    await page.evaluate(() => {
      /** @type {namedElementsTree} */
      const ui = /** @type {any} */(window).ui;
      const event = new CustomEvent('sl-request-close');
      ui.loginDialog.dispatchEvent(event);
    });

    // Verify dialog remains open
    const dialogStillOpen = await page.evaluate(() => {
      /** @type {namedElementsTree} */
      const ui = /** @type {any} */(window).ui;
      return ui.loginDialog.open === true;
    });
    expect(dialogStillOpen).toBe(true);

    // Attempt login with invalid credentials
    await page.evaluate(() => {
      /** @type {namedElementsTree} */
      const ui = /** @type {any} */(window).ui;
      ui.loginDialog.username.value = 'wrong';
      ui.loginDialog.password.value = 'wrong';
      ui.loginDialog.submit.click();
    });

    // Wait for error message
    await page.waitForTimeout(2000);

    // Verify form fields are cleared after failed attempt
    const fieldValues = await page.evaluate(() => {
      /** @type {namedElementsTree} */
      const ui = /** @type {any} */(window).ui;
      return {
        username: ui.loginDialog.username.value,
        password: ui.loginDialog.password.value
      };
    });

    // Note: Fields should remain with values for user to retry
    expect(fieldValues.username).toBe('wrong');
    expect(fieldValues.password).toBe('wrong');

    // Verify dialog is still open for retry
    const dialogOpenForRetry = await page.evaluate(() => {
      /** @type {namedElementsTree} */
      const ui = /** @type {any} */(window).ui;
      return ui.loginDialog.open === true;
    });
    expect(dialogOpenForRetry).toBe(true);
  });
});