/**
 * E2E test login helper functions
 */

/**
 * Performs login flow for E2E tests
 * @param {import('@playwright/test').Page} page - Playwright page object
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
 * Navigates to application and performs login
 * @param {import('@playwright/test').Page} page - Playwright page object
 * @param {string} baseUrl - Base URL of the application
 * @param {string} username - Username to login with
 * @param {string} password - Password to login with
 */
export async function navigateAndLogin(page, baseUrl, username = 'testuser', password = 'testpass') {
  // Navigate to application
  await page.goto(baseUrl);

  // Perform login
  await performLogin(page, username, password);
}