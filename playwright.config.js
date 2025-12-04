import { defineConfig, devices } from '@playwright/test';
import { detectContainerTool } from './tests/lib/detect-container-tool.js';

// Detect container tool (docker or podman)
// Skip detection if E2E_SKIP_WEBSERVER is set (running inside container)
let composeCmd = 'docker';
if (!process.env.E2E_SKIP_WEBSERVER) {
  ({ composeCmd } = detectContainerTool());
}

// Configuration from environment variables
// Priority: E2E_BASE_URL > E2E_CONTAINER_URL > constructed from E2E_HOST:E2E_PORT
const E2E_HOST = process.env.E2E_HOST || 'localhost';
const E2E_PORT = process.env.E2E_PORT || '8000';
const E2E_BASE_URL = process.env.E2E_BASE_URL || process.env.E2E_CONTAINER_URL || `http://${E2E_HOST}:${E2E_PORT}`;

/**
 * @see https://playwright.dev/docs/test-configuration
 */
export default defineConfig({
  testDir: './tests/e2e',
  /* Global setup for configuration */
  globalSetup: './tests/e2e/global-setup.js',
  /* Run tests in files in parallel */
  fullyParallel: true,
  /* Fail the build on CI if you accidentally left test.only in the source code. */
  forbidOnly: !!process.env.CI,
  /* Retry on CI only */
  retries: process.env.CI ? 2 : 0,
  /* Opt out of parallel tests on CI. */
  workers: process.env.CI ? 1 : undefined,
  /* Reporter to use. See https://playwright.dev/docs/test-reporters */
  /* reporter: [['html', { outputFolder: 'tests/e2e/playwright-report' }]],*/
  reporter: [['list']], 
  /* Shared settings for all the projects below. See https://playwright.dev/docs/api/class-testoptions. */
  use: {
    /* Base URL to use in actions like `await page.goto('/')`. */
    baseURL: E2E_BASE_URL,

    /* Collect trace when retrying the failed test. See https://playwright.dev/docs/trace-viewer */
    trace: 'on-first-retry',

    /* Capture screenshot on failure */
    screenshot: process.env.E2E_DEBUG_ON_FAILURE === 'true' ? 'only-on-failure' : 'off',

    /* Capture video on failure (optional, can be heavy) */
    video: process.env.E2E_DEBUG_ON_FAILURE === 'true' ? 'retain-on-failure' : 'off',
  },

  /* Configure output directories */
  outputDir: 'tests/e2e/test-results',

  /* Configure projects for major browsers */
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },

    {
      name: 'firefox',
      use: { ...devices['Desktop Firefox'] },
    },

    {
      name: 'webkit',
      use: { ...devices['Desktop Safari'] },
    },
  ],

  /* Run your local dev server before starting the tests */
  ...(process.env.E2E_SKIP_WEBSERVER ? {} : {
    webServer: {
      command: `${composeCmd} -f docker-compose.test.yml up --build`,
      url: E2E_BASE_URL,
      reuseExistingServer: !process.env.CI,
      timeout: 120 * 1000, // 2 minutes for container startup
      stdout: 'pipe',
      stderr: 'pipe',
    },
  }),
});
