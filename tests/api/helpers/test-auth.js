/**
 * Test Authentication Helper for FastAPI
 *
 * Provides utilities for authenticating in E2E tests by calling the FastAPI v1 endpoints.
 * This helper does not know about implementation details and uses the same login flow
 * as the frontend application will use.
 */

import { createHash } from 'crypto';

// Get base URL from environment
const BASE_URL = process.env.E2E_BASE_URL || 'http://localhost:8000';
const API_BASE = `${BASE_URL}/api/v1`;

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
 * @param {string} [baseUrl] - Optional base URL override
 * @returns {Promise<{sessionId: string, user: object}>} Session ID and user data
 */
async function login(username, password, baseUrl = null) {
  const apiBase = baseUrl ? `${baseUrl}/api/v1` : API_BASE;
  const passwd_hash = hashPassword(password);

  const response = await fetch(`${apiBase}/auth/login`, {
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
    const errorData = await response.json().catch(() => ({ detail: 'Unknown error' }));
    throw new Error(`Login failed: ${response.status} ${response.statusText} - ${errorData.detail || errorData.error || 'Unknown error'}`);
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
 * @param {string} [baseUrl] - Optional base URL override
 * @returns {Promise<void>}
 */
async function logout(sessionId, baseUrl = null) {
  const apiBase = baseUrl ? `${baseUrl}/api/v1` : API_BASE;
  const response = await fetch(`${apiBase}/auth/logout`, {
    method: 'POST',
    headers: {
      'X-Session-Id': sessionId
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
      'X-Session-Id': sessionId
    }
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({ detail: 'Unknown error' }));
    throw new Error(`Status check failed: ${response.status} ${response.statusText} - ${errorData.detail || errorData.error || 'Unknown error'}`);
  }

  return await response.json();
}

/**
 * Make an authenticated API call
 * @param {string} sessionId - Session ID for authentication
 * @param {string} endpoint - API endpoint (e.g., '/config/list')
 * @param {string} method - HTTP method (GET, POST, etc.)
 * @param {object} [body] - Request body for POST/PUT requests
 * @param {string} [baseUrl] - Optional base URL override
 * @returns {Promise<Response>} Fetch response object
 */
async function authenticatedRequest(sessionId, endpoint, method = 'GET', body = null, baseUrl = null) {
  // If endpoint already starts with /api, don't add the /api/v1 prefix
  const base = baseUrl || BASE_URL;
  const url = endpoint.startsWith('/api') ? `${base}${endpoint}` : `${base}/api/v1${endpoint}`;
  const options = {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Session-Id': sessionId
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
 * @param {string} endpoint - API endpoint (e.g., '/config/list')
 * @param {string} method - HTTP method (GET, POST, etc.)
 * @param {object} [body] - Request body for POST/PUT requests
 * @param {string} [baseUrl] - Optional base URL override
 * @returns {Promise<object|string>} JSON response or text for non-JSON content types
 */
async function authenticatedApiCall(sessionId, endpoint, method = 'GET', body = null, baseUrl = null) {
  const response = await authenticatedRequest(sessionId, endpoint, method, body, baseUrl);

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({ detail: 'Unknown error' }));
    throw new Error(`API call failed: ${method} ${endpoint} - ${response.status} ${response.statusText} - ${errorData.detail || errorData.error || 'Unknown error'}`);
  }

  // Check content type to determine how to parse response
  const contentType = response.headers.get('content-type') || '';

  // Return text for XML and other non-JSON content types
  if (contentType.includes('xml') || contentType.includes('text/plain')) {
    return await response.text();
  }

  // Default to JSON
  return await response.json();
}

/**
 * Create a test admin session with default credentials
 * @param {string} [baseUrl] - Optional base URL override
 * @returns {Promise<{sessionId: string, user: object}>} Session data
 */
async function createAdminSession(baseUrl = null) {
  return await login('admin', 'admin', baseUrl);
}

/**
 * Create a test session with specified credentials
 * @param {string} username - Username
 * @param {string} password - Password
 * @param {string} [baseUrl] - Optional base URL override
 * @returns {Promise<{sessionId: string, user: object}>} Session data
 */
async function createTestSession(username, password, baseUrl = null) {
  return await login(username, password, baseUrl);
}

/**
 * Create a test user with specified roles
 * @param {string} username - Username
 * @param {string} password - Plain text password
 * @param {string[]} roles - User roles
 * @param {string} [baseUrl] - Optional base URL override
 * @returns {Promise<void>}
 */
async function createTestUser(username, password, roles = ['user'], baseUrl = null) {
  const apiBase = baseUrl ? `${baseUrl}/api/v1` : API_BASE;

  // Login as admin to create users
  const adminSession = await createAdminSession(baseUrl);

  // Create the user - server will hash the password
  const response = await fetch(`${apiBase}/users`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Session-ID': adminSession.sessionId
    },
    body: JSON.stringify({
      username,
      password,  // Server will hash this
      roles,
      fullname: `Test User ${username}`,
      email: `${username}@test.local`
    })
  });

  // Logout admin
  await logout(adminSession.sessionId, baseUrl);

  if (!response.ok) {
    const error = await response.json().catch(() => ({ detail: 'Unknown error' }));
    throw new Error(`Failed to create user ${username}: ${error.detail || error.error}`);
  }
}

/**
 * Delete a test user
 * @param {string} username - Username to delete
 * @param {string} [baseUrl] - Optional base URL override
 * @returns {Promise<void>}
 */
async function deleteTestUser(username, baseUrl = null) {
  const apiBase = baseUrl ? `${baseUrl}/api/v1` : API_BASE;

  // Login as admin to delete users
  const adminSession = await createAdminSession(baseUrl);

  // Delete the user
  const response = await fetch(`${apiBase}/users/${username}`, {
    method: 'DELETE',
    headers: { 'X-Session-ID': adminSession.sessionId }
  });

  // Logout admin
  await logout(adminSession.sessionId, baseUrl);

  if (!response.ok) {
    console.warn(`Failed to delete user ${username}: ${response.status}`);
  }
}

/**
 * Login as a specific user and return session ID
 * @param {string} username - Username
 * @param {string} password - Plain text password
 * @param {string} [baseUrl] - Optional base URL override
 * @returns {Promise<string>} Session ID
 */
async function loginAsUser(username, password, baseUrl = null) {
  const session = await login(username, password, baseUrl);
  return session.sessionId;
}

/**
 * Try to acquire a lock on a file
 * @param {string} sessionId - Session ID for authentication
 * @param {string} fileId - File stable_id to lock
 * @param {string} [baseUrl] - Optional base URL override
 * @returns {Promise<Response>} Fetch response object (use .status to check success)
 */
async function tryAcquireLock(sessionId, fileId, baseUrl = null) {
  return await authenticatedRequest(
    sessionId,
    '/files/acquire_lock',
    'POST',
    { file_id: fileId },
    baseUrl
  );
}

/**
 * Acquire a lock on a file (throws on failure)
 * @param {string} sessionId - Session ID for authentication
 * @param {string} fileId - File stable_id to lock
 * @param {string} [baseUrl] - Optional base URL override
 * @returns {Promise<void>}
 */
async function acquireLock(sessionId, fileId, baseUrl = null) {
  const response = await tryAcquireLock(sessionId, fileId, baseUrl);
  if (!response.ok) {
    const errorData = await response.json().catch(() => ({ detail: 'Unknown error' }));
    throw new Error(`Failed to acquire lock: ${response.status} - ${errorData.detail || 'Unknown error'}`);
  }
}

/**
 * Release a lock on a file
 * @param {string} sessionId - Session ID for authentication
 * @param {string} fileId - File stable_id to unlock
 * @param {string} [baseUrl] - Optional base URL override
 * @returns {Promise<void>}
 */
async function releaseLock(sessionId, fileId, baseUrl = null) {
  await authenticatedApiCall(
    sessionId,
    '/files/release_lock',
    'POST',
    { file_id: fileId },
    baseUrl
  );
}

/**
 * Check if a file is locked
 * @param {string} sessionId - Session ID for authentication
 * @param {string} fileId - File stable_id to check
 * @param {string} [baseUrl] - Optional base URL override
 * @returns {Promise<{is_locked: boolean, locked_by: string|null}>}
 */
async function checkLock(sessionId, fileId, baseUrl = null) {
  return await authenticatedApiCall(
    sessionId,
    '/files/check_lock',
    'POST',
    { file_id: fileId },
    baseUrl
  );
}

// ============================================================================
// Role-based login helpers (using standard fixture users)
// ============================================================================

/**
 * Login as admin user
 * @param {string} [baseUrl] - Optional base URL override
 * @returns {Promise<{sessionId: string, user: object}>}
 */
async function loginAsAdmin(baseUrl = null) {
  return await login('admin', 'admin', baseUrl);
}

/**
 * Login as reviewer user
 * @param {string} [baseUrl] - Optional base URL override
 * @returns {Promise<{sessionId: string, user: object}>}
 */
async function loginAsReviewer(baseUrl = null) {
  return await login('reviewer', 'reviewer', baseUrl);
}

/**
 * Login as annotator user
 * @param {string} [baseUrl] - Optional base URL override
 * @returns {Promise<{sessionId: string, user: object}>}
 */
async function loginAsAnnotator(baseUrl = null) {
  return await login('annotator', 'annotator', baseUrl);
}

/**
 * Login as basic user (no special roles)
 * @param {string} [baseUrl] - Optional base URL override
 * @returns {Promise<{sessionId: string, user: object}>}
 */
async function loginAsBasicUser(baseUrl = null) {
  return await login('user', 'user', baseUrl);
}

export {
  hashPassword,
  login,
  logout,
  checkStatus,
  authenticatedRequest,
  authenticatedApiCall,
  createAdminSession,
  createTestSession,
  createTestUser,
  deleteTestUser,
  loginAsUser,
  tryAcquireLock,
  acquireLock,
  releaseLock,
  checkLock,
  loginAsAdmin,
  loginAsReviewer,
  loginAsAnnotator,
  loginAsBasicUser,
  API_BASE
};
