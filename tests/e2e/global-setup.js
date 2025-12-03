/**
 * Global setup for Playwright E2E tests
 *
 * This file configures global test behavior including:
 * - Debug-on-failure mode for capturing extended debug artifacts
 */

import { test as base } from '@playwright/test';

// Check if debug-on-failure mode is enabled
const DEBUG_ON_FAILURE = process.env.E2E_DEBUG_ON_FAILURE === 'true';

if (DEBUG_ON_FAILURE) {
  console.log('\n⚠️  Debug-on-failure mode enabled');
  console.log('   Tests will stop on first failure and capture extended debug artifacts');
  console.log('   Debug data saved to tests/e2e/test-results/<test-name>/\n');
}

/**
 * Configure test behavior based on environment variables
 */
export default async function globalSetup() {
  // Global setup tasks can be added here if needed
  return async () => {
    // Global teardown tasks can be added here if needed
  };
}
