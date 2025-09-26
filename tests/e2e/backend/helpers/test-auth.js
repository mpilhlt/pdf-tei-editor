/**
 * Test Authentication Helper
 *
 * Provides utilities for authenticating in E2E tests by calling the public API endpoints.
 * This helper does not know about implementation details and uses the same login flow
 * as the frontend application.
 */

import { createHash } from 'crypto';

// Get configuration from environment variables (set by e2e-runner.js)
const HOST = process.env.E2E_HOST || 'localhost';
const PORT = process.env.E2E_PORT || '8000';
const API_BASE = `http://${HOST}:${PORT}/api`;

/**
 * Hash a password using SHA-256 (matches frontend implementation)
 * @param {string} password - Plain text password
 * @returns {string} Hex-encoded SHA-256 hash
 */
function hashPassword(password) {
  return createHash('sha256').update(password, 'utf8').digest('hex');
}

/**
 * Login with username and password, returns session ID for subsequent API calls
 * @param {string} username - Username
 * @param {string} password - Plain text password
 * @returns {Promise<{sessionId: string, user: object}>} Session ID and user data
 */
async function login(username, password) {
  const passwd_hash = hashPassword(password);

  const response = await fetch(`${API_BASE}/auth/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      username,
      passwd_hash
    })
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({ error: 'Unknown error' }));
    throw new Error(`Login failed: ${response.status} ${response.statusText} - ${errorData.error || 'Unknown error'}`);
  }

  const userData = await response.json();

  if (!userData.sessionId) {
    throw new Error('Login response missing sessionId');
  }

  return {
    sessionId: userData.sessionId,
    user: userData
  };
}

/**
 * Logout and invalidate the session
 * @param {string} sessionId - Session ID to logout
 * @returns {Promise<void>}
 */
async function logout(sessionId) {
  const response = await fetch(`${API_BASE}/auth/logout`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Cookie': `sessionId=${sessionId}`
    }
  });

  if (!response.ok) {
    console.warn(`Logout failed: ${response.status} ${response.statusText}`);
  }
}

/**
 * Check authentication status for a session
 * @param {string} sessionId - Session ID to check
 * @returns {Promise<object>} User data if authenticated
 */
async function checkStatus(sessionId) {
  const response = await fetch(`${API_BASE}/auth/status`, {
    method: 'GET',
    headers: {
      'Cookie': `sessionId=${sessionId}`
    }
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({ error: 'Unknown error' }));
    throw new Error(`Status check failed: ${response.status} ${response.statusText} - ${errorData.error || 'Unknown error'}`);
  }

  return await response.json();
}

/**
 * Make an authenticated API call
 * @param {string} sessionId - Session ID for authentication
 * @param {string} endpoint - API endpoint (e.g., '/files/locks')
 * @param {string} method - HTTP method (GET, POST, etc.)
 * @param {object} [body] - Request body for POST/PUT requests
 * @returns {Promise<Response>} Fetch response object
 */
async function authenticatedRequest(sessionId, endpoint, method = 'GET', body = null) {
  const url = `${API_BASE}${endpoint}`;
  const options = {
    method,
    headers: {
      'Content-Type': 'application/json',
      'Cookie': `sessionId=${sessionId}`
    }
  };

  if (body && (method === 'POST' || method === 'PUT' || method === 'PATCH')) {
    options.body = JSON.stringify(body);
  }

  return await fetch(url, options);
}

/**
 * Make an authenticated API call and return JSON response
 * @param {string} sessionId - Session ID for authentication
 * @param {string} endpoint - API endpoint (e.g., '/files/locks')
 * @param {string} method - HTTP method (GET, POST, etc.)
 * @param {object} [body] - Request body for POST/PUT requests
 * @returns {Promise<object>} JSON response
 */
async function authenticatedApiCall(sessionId, endpoint, method = 'GET', body = null) {
  const response = await authenticatedRequest(sessionId, endpoint, method, body);

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({ error: 'Unknown error' }));
    throw new Error(`API call failed: ${method} ${endpoint} - ${response.status} ${response.statusText} - ${errorData.error || 'Unknown error'}`);
  }

  return await response.json();
}

/**
 * Create a test user session with default credentials
 * Uses test user credentials that should exist in the test environment
 * @returns {Promise<{sessionId: string, user: object}>} Session data
 */
async function createTestSession() {
  // Default test user credentials - these should be created in the test environment
  const DEFAULT_TEST_USER = 'testuser';
  const DEFAULT_TEST_PASSWORD = 'testpass';

  try {
    return await login(DEFAULT_TEST_USER, DEFAULT_TEST_PASSWORD);
  } catch (error) {
    throw new Error(`Failed to create test session with default user '${DEFAULT_TEST_USER}'. ` +
      `Ensure the test user exists in the container. Original error: ${error.message}`);
  }
}

/**
 * Delete test files for cleanup between tests
 * @param {string} sessionId - Session ID for authentication
 * @param {string[]} fileIds - Array of file identifiers to delete
 * @returns {Promise<void>}
 */
async function deleteTestFiles(sessionId, fileIds) {
  if (!fileIds || fileIds.length === 0) {
    return;
  }

  try {
    const response = await authenticatedRequest(sessionId, '/files/delete', 'POST', fileIds);

    // Don't throw on 404 or 403 - files might not exist or user might not have permission
    if (response.ok) {
      console.log(`✓ Cleaned up ${fileIds.length} test file(s)`);
    } else if (response.status === 404) {
      console.log(`⚠ Some test files were already deleted (404) - this is okay`);
    } else if (response.status === 403) {
      console.log(`⚠ Insufficient permissions to delete some test files (403) - this might be expected`);
    } else {
      console.warn(`⚠ File cleanup warning: ${response.status} ${response.statusText} - continuing anyway`);
    }
  } catch (error) {
    // Log warning but don't throw - cleanup failures shouldn't break tests
    console.warn(`⚠ File cleanup failed: ${error.message} - continuing anyway`);
  }
}

export {
  hashPassword,
  login,
  logout,
  checkStatus,
  authenticatedRequest,
  authenticatedApiCall,
  createTestSession,
  deleteTestFiles
};