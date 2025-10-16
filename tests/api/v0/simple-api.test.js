/**
 * Simple API Endpoints Tests - E2E Backend Tests
 *
 * Test basic authenticated endpoints to ensure authentication middleware
 * works properly with our new test users before testing complex permissions.
 *
 * @testCovers server/api/auth.py
 * @testCovers server/lib/decorators.py
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { login, logout, authenticatedRequest, authenticatedApiCall } from './helpers/test-auth.js';

// Get configuration from environment variables (set by e2e-runner.js)
const HOST = process.env.E2E_HOST || 'localhost';
const PORT = process.env.E2E_PORT || '8000';
const API_BASE = `http://${HOST}:${PORT}/api`;

// Test user credentials
const TEST_USERS = [
  { username: 'testuser', password: 'testpass', roles: ['user'], description: 'Basic user' },
  { username: 'testannotator', password: 'annotatorpass', roles: ['annotator', 'user'], description: 'Annotator' },
  { username: 'testreviewer', password: 'reviewerpass', roles: ['reviewer', 'user'], description: 'Reviewer' },
  { username: 'testadmin', password: 'adminpass', roles: ['admin', 'user'], description: 'Admin' }
];

describe('Simple API Endpoints Tests', () => {

  test('Should access auth status endpoint without authentication', async () => {
    const response = await fetch(`${API_BASE}/auth/status`);
    // Should return 401 or similar for unauthenticated request
    assert(response.status === 401 || response.status === 403,
      'Unauthenticated status request should return 401 or 403');
  });

  test('Should access config endpoints without authentication', async () => {
    // Test publicly accessible config endpoints
    const stateResponse = await fetch(`${API_BASE}/config/state`);
    assert.strictEqual(stateResponse.status, 200, 'State config should be publicly accessible');

    const stateData = await stateResponse.json();
    assert(typeof stateData === 'object', 'State config should return object');
  });

  // Test authenticated endpoints for each user
  for (const user of TEST_USERS) {
    test(`Should access authenticated endpoints as ${user.description}`, async () => {
      let sessionId = null;

      try {
        // Login
        const { sessionId: sid } = await login(user.username, user.password);
        sessionId = sid;

        // Test auth status with valid session
        const statusResponse = await authenticatedRequest(sessionId, '/auth/status');
        assert.strictEqual(statusResponse.status, 200,
          `Auth status should be accessible for ${user.username}`);

        const statusData = await statusResponse.json();
        assert.strictEqual(statusData.username, user.username, 'Status should return correct username');
        assert(Array.isArray(statusData.roles), 'Status should return roles array');

        // Test that roles match expected roles
        for (const expectedRole of user.roles) {
          assert(statusData.roles.includes(expectedRole),
            `User ${user.username} should have role: ${expectedRole}`);
        }

      } finally {
        // Clean up session
        if (sessionId) {
          await logout(sessionId).catch(() => {}); // Ignore cleanup errors
        }
      }
    });
  }

  test('Should handle malformed session cookies', async () => {
    // Test with malformed session cookie
    const response = await fetch(`${API_BASE}/auth/status`, {
      headers: {
        'Cookie': 'sessionId=invalid-session-format'
      }
    });

    assert(response.status === 401 || response.status === 403,
      'Malformed session should return 401 or 403');
  });

  test('Should handle expired/invalid session', async () => {
    // Test with fake session ID
    const response = await fetch(`${API_BASE}/auth/status`, {
      headers: {
        'Cookie': 'sessionId=definitely-not-a-valid-session-id'
      }
    });

    assert(response.status === 401 || response.status === 403,
      'Invalid session should return 401 or 403');
  });

  test('Should handle missing session gracefully', async () => {
    // Test endpoints that require authentication without session
    const response = await fetch(`${API_BASE}/auth/status`);

    assert(response.status === 401 || response.status === 403,
      'Missing session should return 401 or 403');
  });

});