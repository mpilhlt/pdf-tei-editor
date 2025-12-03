/**
 * Playwright fixture for debug-on-failure functionality
 *
 * When E2E_DEBUG_ON_FAILURE=true, this fixture will:
 * 1. Capture console messages and page errors during test execution
 * 2. Take a screenshot on failure
 * 3. Save all debugging information to test-results/
 * 4. Work with test runner's --debug-on-failure flag to stop after first failure
 *
 * Debug artifacts are saved to: tests/e2e/test-results/<test-name>/
 *
 * For interactive debugging, use:
 *   npm run test:e2e:debug -- --grep "test name"
 */

import { test as base, expect } from '@playwright/test';
import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

const DEBUG_ON_FAILURE = process.env.E2E_DEBUG_ON_FAILURE === 'true';

/**
 * Extended test fixture that captures comprehensive failure information
 */
export const test = base.extend({
  page: async ({ page }, use, testInfo) => {
    const consoleMessages = [];
    const pageErrors = [];
    const networkLog = [];

    if (DEBUG_ON_FAILURE) {
      // Capture console messages
      page.on('console', msg => {
        consoleMessages.push({
          type: msg.type(),
          text: msg.text(),
          location: msg.location(),
          timestamp: new Date().toISOString()
        });
      });

      // Capture page errors
      page.on('pageerror', error => {
        pageErrors.push({
          message: error.message,
          stack: error.stack,
          timestamp: new Date().toISOString()
        });
      });

      // Capture network requests
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

      // Capture network responses
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
    }

    // Provide page to test
    await use(page);

    // After test completes, check if it failed
    if (DEBUG_ON_FAILURE && testInfo.status !== 'passed') {
      console.log('\n🔍 Test failed - Capturing debug information');
      console.log(`   Test: ${testInfo.title}`);
      console.log(`   Status: ${testInfo.status}`);
      console.log(`   Error: ${testInfo.error?.message || 'Unknown error'}`);

      const outputDir = testInfo.outputDir;

      // Ensure output directory exists
      try {
        mkdirSync(outputDir, { recursive: true });
      } catch (error) {
        console.log(`   Could not create output directory: ${error.message}`);
        return;
      }

      // Save console messages
      if (consoleMessages.length > 0) {
        const consolePath = join(outputDir, 'console-messages.json');
        writeFileSync(consolePath, JSON.stringify(consoleMessages, null, 2));
        console.log(`   Console messages: ${consolePath}`);
      }

      // Save page errors
      if (pageErrors.length > 0) {
        const errorsPath = join(outputDir, 'page-errors.json');
        writeFileSync(errorsPath, JSON.stringify(pageErrors, null, 2));
        console.log(`   Page errors: ${errorsPath}`);
      }

      // Save network log
      if (networkLog.length > 0) {
        const networkPath = join(outputDir, 'network-log.json');
        writeFileSync(networkPath, JSON.stringify(networkLog, null, 2));
        console.log(`   Network log: ${networkPath}`);
      }

      console.log(`   Test output directory: ${outputDir}`);
      console.log('   Screenshots and videos (if any) are saved by Playwright automatically');
      console.log('\n   For interactive debugging, use:');
      console.log(`   npm run test:e2e:debug -- --grep "${testInfo.title}"\n`);
    }
  },
});

export { expect };
