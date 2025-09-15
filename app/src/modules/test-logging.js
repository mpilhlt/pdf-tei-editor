/**
 * Test logging utilities for E2E testing
 *
 * Provides conditional logging functionality that only outputs when
 * application.mode is set to "testing"
 */

/**
 * Creates a test logging function based on application mode
 * @param {string} applicationMode - The application mode from config
 * @returns {function} Test logging function (either active or no-op)
 */
export function createTestLogger(applicationMode) {
  const isTestingMode = applicationMode === "testing";

  if (isTestingMode) {
    /**
     * Logs messages for E2E testing
     * @param {string} message - Test message identifier
     * @param {any} [data] - Optional data to include
     */
    return function testLog(message, data = {}) {
      console.log(`TEST: ${message}`, JSON.stringify(data));
    };
  } else {
    // Return no-op function for production
    return function testLog() {
      // No logging in non-test mode
    };
  }
}