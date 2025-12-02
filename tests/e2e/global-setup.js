/**
 * Global setup for Playwright E2E tests
 *
 * This file configures global test behavior including:
 * - Pause-on-failure mode for debugging
 */

import { test as base } from '@playwright/test';

// Check if pause-on-failure mode is enabled
const PAUSE_ON_FAILURE = process.env.E2E_PAUSE_ON_FAILURE === 'true';

if (PAUSE_ON_FAILURE) {
  console.log('\n⚠️  Pause-on-failure mode enabled');
  console.log('   Tests will pause when they fail, allowing you to inspect the browser state');
  console.log('   Browser will remain open until you manually close it\n');
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
