/**
 * Playwright fixture for pause-on-failure functionality
 *
 * When E2E_PAUSE_ON_FAILURE=true, this fixture will:
 * 1. Disable test timeouts on failure
 * 2. Keep the browser open indefinitely for inspection
 * 3. Log helpful debugging information
 */

import { test as base } from '@playwright/test';

const PAUSE_ON_FAILURE = process.env.E2E_PAUSE_ON_FAILURE === 'true';

/**
 * Extended test fixture that pauses on failure
 */
export const test = base.extend({
  page: async ({ page }, use, testInfo) => {
    // Run the test
    await use(page);

    // After test completes, check if it failed and pause if enabled
    if (PAUSE_ON_FAILURE && testInfo.status !== 'passed') {
      console.log('\n🔍 Test failed - Pausing for inspection');
      console.log(`   Test: ${testInfo.title}`);
      console.log(`   Status: ${testInfo.status}`);
      console.log(`   Error: ${testInfo.error?.message || 'Unknown error'}`);
      console.log('\n   Browser will remain open for inspection.');
      console.log('   To continue:');
      console.log('   - Inspect the UI state in the browser');
      console.log('   - Use browser DevTools to examine elements and console');
      console.log('   - Press Ctrl+C in this terminal when done\n');

      // Disable timeout and pause indefinitely
      testInfo.setTimeout(0);
      await new Promise(() => {}); // Never resolves - keeps browser open
    }
  },
});

export { expect } from '@playwright/test';
