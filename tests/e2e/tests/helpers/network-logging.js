/**
 * Network logging helper for E2E tests
 *
 * Captures all network requests and responses during test execution
 * and saves them to a JSON file on test failure when --debug-on-failure flag is set.
 */

import fs from 'fs';
import path from 'path';

/**
 * Sets up network request/response logging for a page
 *
 * @param {import('@playwright/test').Page} page - The Playwright page instance
 * @param {import('@playwright/test').TestInfo} testInfo - The Playwright test info
 * @returns {() => Promise<void>} Cleanup function to save logs on failure
 */
export function setupNetworkLogging(page, testInfo) {
  const networkLog = [];

  // Capture all requests
  page.on('request', request => {
    networkLog.push({
      type: 'request',
      timestamp: new Date().toISOString(),
      method: request.method(),
      url: request.url(),
      headers: request.headers(),
      postData: request.postData()
    });
  });

  // Capture all responses
  page.on('response', async response => {
    const request = response.request();
    let responseBody = null;
    let responseError = null;

    // Try to capture response body
    try {
      const contentType = response.headers()['content-type'] || '';
      if (contentType.includes('application/json') ||
          contentType.includes('text/') ||
          contentType.includes('application/xml')) {
        responseBody = await response.text();
      } else {
        responseBody = `<binary content, type: ${contentType}>`;
      }
    } catch (error) {
      responseError = error.message;
    }

    networkLog.push({
      type: 'response',
      timestamp: new Date().toISOString(),
      method: request.method(),
      url: response.url(),
      status: response.status(),
      statusText: response.statusText(),
      headers: response.headers(),
      body: responseBody,
      bodyError: responseError
    });
  });

  // Capture request failures
  page.on('requestfailed', request => {
    networkLog.push({
      type: 'request-failed',
      timestamp: new Date().toISOString(),
      method: request.method(),
      url: request.url(),
      failure: request.failure()?.errorText
    });
  });

  // Return cleanup function
  return async () => {
    // Only save network log if test failed and debug-on-failure is enabled
    if (testInfo.status !== 'passed' && process.env.E2E_DEBUG === 'true') {
      const testResultsDir = path.join(process.cwd(), 'test-results');

      // Create test-results directory if it doesn't exist
      if (!fs.existsSync(testResultsDir)) {
        fs.mkdirSync(testResultsDir, { recursive: true });
      }

      // Generate filename based on test info
      const sanitizedTitle = testInfo.title.replace(/[^a-z0-9]/gi, '-').toLowerCase();
      const filename = `network-log-${sanitizedTitle}-${Date.now()}.json`;
      const filepath = path.join(testResultsDir, filename);

      // Save network log
      fs.writeFileSync(filepath, JSON.stringify(networkLog, null, 2));
      console.log(`[NETWORK LOG] Saved to ${filepath}`);

      // Also attach to test results if available
      if (testInfo.attach) {
        await testInfo.attach('network-log', {
          body: JSON.stringify(networkLog, null, 2),
          contentType: 'application/json'
        });
      }
    }
  };
}

/**
 * Filters network log entries by URL pattern
 *
 * @param {Array} networkLog - The network log array
 * @param {string|RegExp} pattern - URL pattern to match
 * @returns {Array} Filtered network log entries
 */
export function filterNetworkLog(networkLog, pattern) {
  const regex = typeof pattern === 'string' ? new RegExp(pattern) : pattern;
  return networkLog.filter(entry => regex.test(entry.url));
}

/**
 * Gets all failed requests from network log
 *
 * @param {Array} networkLog - The network log array
 * @returns {Array} Failed request entries
 */
export function getFailedRequests(networkLog) {
  return networkLog.filter(entry =>
    entry.type === 'request-failed' ||
    (entry.type === 'response' && entry.status >= 400)
  );
}
