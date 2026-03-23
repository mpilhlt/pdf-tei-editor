/**
 * Test logging utility for E2E tests.
 * Call `configureTestLog(mode)` once during app initialization before using `testLog`.
 */

import { createTestLogger } from '../../../tests/e2e/tests/helpers/test-logging.js'

/** @type {function(string, any=): void} */
let _testLog = createTestLogger(null)

/**
 * Configure testLog for the given application mode.
 * Must be called once during app initialization after the mode is known.
 * @param {string} applicationMode
 */
export function configureTestLog(applicationMode) {
  _testLog = createTestLogger(applicationMode)
}

/**
 * Log a test event for E2E test assertions.
 * No-op in non-testing mode.
 * @param {string} message - Event identifier (uppercase letters, numbers, underscores)
 * @param {any} [data] - Optional data to include
 */
export function testLog(message, data = {}) {
  _testLog(message, data)
}
