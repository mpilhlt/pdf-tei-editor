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
 * @returns {Promise<void>}
 */
async function logout(sessionId) {
  const response = await fetch(`${API_BASE}/auth/logout`, {
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
 * @returns {Promise<Response>} Fetch response object
 */
async function authenticatedRequest(sessionId, endpoint, method = 'GET', body = null) {
  const url = `${API_BASE}${endpoint}`;
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
 * @returns {Promise<object>} JSON response
 */
async function authenticatedApiCall(sessionId, endpoint, method = 'GET', body = null) {
  const response = await authenticatedRequest(sessionId, endpoint, method, body);

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({ detail: 'Unknown error' }));
    throw new Error(`API call failed: ${method} ${endpoint} - ${response.status} ${response.statusText} - ${errorData.detail || errorData.error || 'Unknown error'}`);
  }

  return await response.json();
}

/**
 * Create a test admin session with default credentials
 * @returns {Promise<{sessionId: string, user: object}>} Session data
 */
async function createAdminSession() {
  return await login('admin', 'admin');
}

export {
  hashPassword,
  login,
  logout,
  checkStatus,
  authenticatedRequest,
  authenticatedApiCall,
  createAdminSession,
  API_BASE
};
