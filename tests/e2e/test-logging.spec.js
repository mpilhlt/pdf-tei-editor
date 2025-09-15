/**
 * E2E test demonstrating the testLog functionality
 * Tests initial application startup and state transitions
 *
 * @testCovers app/src/plugins/start.js
 * @testCovers app/src/modules/test-logging.js
 */

import { test, expect } from '@playwright/test';

// Configuration from environment variables
const E2E_HOST = process.env.E2E_HOST || 'localhost';
const E2E_PORT = process.env.E2E_PORT || '8000';
const E2E_BASE_URL = process.env.E2E_CONTAINER_URL || `http://${E2E_HOST}:${E2E_PORT}`;

test.describe('Test Logging Functionality', () => {

  test('should capture test logs during application startup', async ({ page }) => {
    // Set up console capture for test messages
    /** @type {string[]} */
    const testMessages = [];
    page.on('console', msg => {
      if (msg.text().startsWith('TEST:')) {
        testMessages.push(msg.text());
      }
    });

    // Navigate to the application
    await page.goto(E2E_BASE_URL);

    // Wait for login dialog to appear
    await page.waitForSelector('sl-dialog[open]', { timeout: 10000 });

    // Login using UI navigation system
    await page.evaluate(() => {
      // @ts-ignore - window.ui is available in browser context
      window.ui.loginDialog.username.value = 'testuser';
      // @ts-ignore - window.ui is available in browser context
      window.ui.loginDialog.password.value = 'testpass';
      // @ts-ignore - window.ui is available in browser context
      window.ui.loginDialog.submit.click();
    });

    // Wait for login to complete and startup to finish
    await page.waitForSelector('sl-dialog:not([open])', { timeout: 10000 });

    // Wait a bit more for all startup logs to complete
    await page.waitForTimeout(3000);

    // Verify test log messages were captured
    expect(testMessages.length).toBeGreaterThan(0);

    // Check for specific startup events
    const startInitiated = testMessages.find(msg => msg.includes('APP_START_INITIATED'));
    const userAuthenticated = testMessages.find(msg => msg.includes('USER_AUTHENTICATED'));
    const startCompleted = testMessages.find(msg => msg.includes('APP_START_COMPLETED'));

    expect(startInitiated).toBeTruthy();
    expect(userAuthenticated).toBeTruthy();
    expect(startCompleted).toBeTruthy();

    // Parse and verify the user authentication data
    if (userAuthenticated) {
      const dataMatch = userAuthenticated.match(/TEST: USER_AUTHENTICATED (.+)/);
      if (dataMatch) {
        const userData = JSON.parse(dataMatch[1]);
        expect(userData.username).toBe('testuser');
        expect(userData.fullname).toBe('Test User');
      }
    }

    // Parse and verify the completion data structure
    if (startCompleted) {
      const dataMatch = startCompleted.match(/TEST: APP_START_COMPLETED (.+)/);
      if (dataMatch) {
        const completionData = JSON.parse(dataMatch[1]);
        expect(completionData).toHaveProperty('pdf');
        expect(completionData).toHaveProperty('xml');
        expect(completionData).toHaveProperty('diff');
      }
    }

    console.log('Captured test messages:', testMessages);
  });


});