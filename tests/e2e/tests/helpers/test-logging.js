/**
 * Test logging utilities for E2E testing
 *
 * Provides conditional logging functionality that only outputs when
 * application.mode is set to "testing"
 * 
 * NOTE: This code is also included into the client-side app bundle, so 
 * do not use any code that depends on a NodeJS context
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
     * @param {string} message - Test message identifier (must match [A-Z_][A-Z0-9_]* pattern)
     * @param {any} [data] - Optional data to include
     */
    return function testLog(message, data = {}) {
      if (typeof message !== 'string' || !/^[A-Z_][A-Z0-9_]*$/.test(message)) {
        throw new Error(`testLog message must match pattern [A-Z_][A-Z0-9_]* (uppercase letters, numbers, underscores only, starting with letter or underscore): "${message}"`);
      }
      console.log(`TEST: ${message} ${JSON.stringify(data)}`);
    };
  } else {
    // Return no-op function for production
    return function testLog() {
      // No logging in non-test mode
    };
  }
}

/**
 * @typedef {object} LogEntry
 * @property {string} type
 * @property {string} text
 * @property {number} [timestamp] - Timestamp when log was captured
 * @property {string} [message]
 * @property {string} [value]
 */

/**
 * Strips console formatting codes (%c) and CSS styles from console message text
 * @param {string} text - Raw console message text with formatting codes
 * @returns {string} Cleaned text without formatting codes
 */
function stripConsoleFormatting(text) {
  // Browser console.log with %c formatting results in Playwright capturing text like:
  // "%cMessage text %c[location] color: ...; color: ...;"
  // We want to extract just "Message text"

  // Remove all %c codes
  let cleaned = text.replace(/%c/g, '');

  // Remove CSS property patterns (color:, font-size:, etc.)
  cleaned = cleaned.replace(/\b(color|font-size|font-weight|font-family|background|padding|margin):\s*[^;]+;?/gi, '');

  // Remove multiple spaces first
  cleaned = cleaned.replace(/\s+/g, ' ').trim();

  // Remove square bracket content that looks like file locations [filename (line:col)]
  // This handles nested brackets like: [install$g [as install] (app.js:17677)]
  // Strategy: remove from " [" to the end if it contains both brackets and parens (looks like a stack trace)
  cleaned = cleaned.replace(/\s+\[.*\(.*\).*\]$/g, '').trim();

  return cleaned;
}

/**
 * @typedef {object} NetworkRequest
 * @property {string} url - Request URL
 * @property {string} method - HTTP method
 * @property {number} [status] - Response status code (if available)
 * @property {string} [statusText] - Response status text (if available)
 * @property {string} [failure] - Failure message (if request failed)
 * @property {number} timestamp - Request timestamp
 */

/**
 * Sets up network request tracking for E2E tests
 * @param {import('@playwright/test').Page} page - Playwright page object
 * @returns {NetworkRequest[]} Array of tracked network requests
 */
export function setupNetworkTracking(page) {
  /** @type {NetworkRequest[]} */
  const requests = [];

  page.on('request', request => {
    requests.push({
      url: request.url(),
      method: request.method(),
      timestamp: Date.now()
    });
  });

  page.on('response', response => {
    const request = requests.find(r => r.url === response.url() && !r.status);
    if (request) {
      request.status = response.status();
      request.statusText = response.statusText();
    }
  });

  page.on('requestfailed', request => {
    const trackedRequest = requests.find(r => r.url === request.url() && !r.status);
    if (trackedRequest) {
      trackedRequest.failure = request.failure()?.errorText || 'Unknown error';
    }
  });

  return requests;
}

/**
 * Finds recent failed network requests
 * @param {NetworkRequest[]} requests - Array of tracked requests
 * @param {number} [since] - Timestamp to filter requests after (default: last 5 seconds)
 * @returns {NetworkRequest[]} Array of failed requests
 */
export function findRecentFailedRequests(requests, since = Date.now() - 5000) {
  return requests.filter(r =>
    r.timestamp >= since &&
    (r.status >= 400 || r.failure)
  );
}

/**
 * Sets up enhanced console log capture for E2E tests with TEST message parsing
 * and network request tracking
 * @param {import('@playwright/test').Page} page - Playwright page object
 * @returns {{logs: any[], requests: NetworkRequest[]}} Captured console logs and network requests
 */
export function setupTestConsoleCapture(page) {
  /** @type {LogEntry[]} */
  const consoleLogs = [];
  const networkRequests = setupNetworkTracking(page);

  page.on('console', msg => {
    // Capture log, info, warn, and error messages
    if (['log', 'info', 'warn', 'error'].includes(msg.type())) {
      const rawText = msg.text();
      const text = stripConsoleFormatting(rawText);

      // Skip messages that are only formatting codes (empty after stripping)
      // or that only contain CSS styles
      if (!text || text.trim().length === 0) {
        return;
      }

      /** @type {LogEntry} */
      const logEntry = {
        type: msg.type(),
        text: text,
        timestamp: Date.now()
      };

      // Parse TEST messages using regex: "TEST: MESSAGE_NAME JSON_DATA"
      if (text.startsWith('TEST: ')) {
        // Match pattern: TEST: followed by word characters (message), optional space and JSON data
        const match = text.match(/^TEST:\s+([A-Z_][A-Z0-9_]*)\s*(.*)?$/);
        if (match) {
          logEntry.message = match[1]; // Message name (group 1)

          // If there's JSON data (group 2), try to parse it
          if (match[2] && match[2].trim()) {
            try {
              logEntry.value = JSON.parse(match[2].trim());
            } catch (error) {
              // If JSON parsing fails, store as string
              logEntry.value = match[2].trim();
            }
          }
        }
      }

      consoleLogs.push(logEntry);
    }
  });

  // Return both logs and requests for backward compatibility
  // Support both array access (old) and object access (new)
  const result = consoleLogs;
  result.requests = networkRequests;
  return result;
}

/**
 * Searches for error messages in console logs
 * @param {LogEntry[]} consoleLogs - Array of captured console logs
 * @param {string} [pattern] - Optional regex pattern to match against error text
 * @returns {LogEntry[]} Array of error log entries matching the pattern
 */
export function findErrorLogs(consoleLogs, pattern) {
  const errorLogs = consoleLogs.filter(log => log.type === 'error');

  if (pattern) {
    const regex = new RegExp(pattern, 'i');
    return errorLogs.filter(log => regex.test(log.text));
  }

  return errorLogs;
}

/**
 * Searches for warning messages in console logs
 * @param {LogEntry[]} consoleLogs - Array of captured console logs
 * @param {string} [pattern] - Optional regex pattern to match against warning text
 * @returns {LogEntry[]} Array of warning log entries matching the pattern
 */
export function findWarningLogs(consoleLogs, pattern) {
  const warningLogs = consoleLogs.filter(log => log.type === 'warn');

  if (pattern) {
    const regex = new RegExp(pattern, 'i');
    return warningLogs.filter(log => regex.test(log.text));
  }

  return warningLogs;
}

/**
 * Sets up automatic test failure on unexpected console errors
 * @param {LogEntry[]} consoleLogs - Array of captured console logs (with optional .requests property)
 * @param {string[]} allowedErrorPatterns - Array of regex patterns for expected/ignorable errors
 * @returns {() => void} Cleanup function to stop error monitoring
 */
export function setupErrorFailure(consoleLogs, allowedErrorPatterns = []) {
  const checkedErrors = new Set();

  // Check for unexpected errors every 500ms
  const checkInterval = setInterval(() => {
    const errorLogs = findErrorLogs(consoleLogs);

    for (const errorLog of errorLogs) {
      // Skip if already checked
      if (checkedErrors.has(errorLog.text)) continue;

      // Check if this error matches any allowed patterns
      const isAllowed = allowedErrorPatterns.some(pattern => {
        const regex = new RegExp(pattern, 'i');
        return regex.test(errorLog.text);
      });

      if (!isAllowed) {
        // Mark as checked to avoid duplicate failures
        checkedErrors.add(errorLog.text);
        clearInterval(checkInterval);

        // Build detailed error message
        let errorMessage = `Unexpected console error detected: ${errorLog.text}`;

        // If network requests were tracked, find recent failures
        if (consoleLogs.requests) {
          const errorTime = errorLog.timestamp || Date.now();
          const recentFailures = findRecentFailedRequests(consoleLogs.requests, errorTime - 5000);

          if (recentFailures.length > 0) {
            errorMessage += '\n\nRecent failed network requests:';
            recentFailures.forEach(req => {
              errorMessage += `\n  ${req.method} ${req.url}`;
              if (req.status) {
                errorMessage += ` → ${req.status} ${req.statusText}`;
              }
              if (req.failure) {
                errorMessage += ` (${req.failure})`;
              }
            });
          }

          // Also show recent successful requests that might be related
          const recentRequests = consoleLogs.requests.filter(r =>
            r.timestamp >= errorTime - 2000 && r.timestamp <= errorTime
          ).slice(-5);

          if (recentRequests.length > 0) {
            errorMessage += '\n\nRecent network activity (last 2 seconds):';
            recentRequests.forEach(req => {
              errorMessage += `\n  ${req.method} ${req.url}`;
              if (req.status) {
                errorMessage += ` → ${req.status}`;
              }
            });
          }
        }

        errorMessage += `\n\nAllowed patterns: ${JSON.stringify(allowedErrorPatterns, null, 2)}`;

        // Force test failure with detailed error info
        throw new Error(errorMessage);
      } else {
        // Mark allowed errors as checked too
        checkedErrors.add(errorLog.text);
      }
    }
  }, 500);

  // Return cleanup function
  return () => clearInterval(checkInterval);
}

/**
 * Helper function to wait for a specific TEST console message
 * @param {any[]} consoleLogs - Array of captured console logs
 * @param {string} message - Message to wait for (without "TEST: " prefix)
 * @param {number} timeout - Timeout in milliseconds
 * @returns {Promise<any>} The log entry with parsed value if available
 */
export async function waitForTestMessage(consoleLogs, message, timeout = 10000) {
  const startTime = Date.now();

  while (Date.now() - startTime < timeout) {
    const found = consoleLogs.find(log => log.message === message);
    if (found) {
      return found;
    }
    // Poll every 100ms
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  const availableMessages = consoleLogs
    .filter(log => log.message)
    .map(log => `${log.message}${log.value ? ` (with value)` : ''}`);

  throw new Error(`Timeout waiting for TEST message: ${message}. Available TEST messages: ${JSON.stringify(availableMessages, null, 2)}`);
}

/**
 * Helper function to find a TEST message with specific value
 * @param {any[]} consoleLogs - Array of captured console logs
 * @param {string} message - Message to search for
 * @param {any} expectedValue - Expected value to match
 * @returns {any|null} The log entry if found, null otherwise
 */
export function findTestMessageWithValue(consoleLogs, message, expectedValue) {
  return consoleLogs.find(log =>
    log.message === message &&
    JSON.stringify(log.value) === JSON.stringify(expectedValue)
  ) || null;
}