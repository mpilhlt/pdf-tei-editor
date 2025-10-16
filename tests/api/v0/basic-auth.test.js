/**
 * Basic Authentication Tests - E2E Backend Tests
 *
 * Simple authentication tests to verify fixtures and credentials work
 * before attempting complex permission testing.
 *
 * @testCovers server/api/auth.py
 * @testCovers tests/e2e/fixtures/db/users.json
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { login, logout, checkStatus } from './helpers/test-auth.js';

// Get configuration from environment variables (set by e2e-runner.js)
const HOST = process.env.E2E_HOST || 'localhost';
const PORT = process.env.E2E_PORT || '8000';
const API_BASE = `http://${HOST}:${PORT}/api`;

// Test user credentials from our fixtures
const TEST_USERS = [
  { username: 'testuser', password: 'testpass', roles: ['user'], description: 'Basic user' },
  { username: 'testannotator', password: 'annotatorpass', roles: ['annotator', 'user'], description: 'Annotator' },
  { username: 'testreviewer', password: 'reviewerpass', roles: ['reviewer', 'user'], description: 'Reviewer' },
  { username: 'testadmin', password: 'adminpass', roles: ['admin', 'user'], description: 'Admin' }
];

describe('Basic Authentication Tests', () => {

  test('Should successfully connect to test server', async () => {
    const response = await fetch(`http://${HOST}:${PORT}/`);
    assert.strictEqual(response.status, 200, 'Test server should be accessible');
  });

  test('Should reject invalid credentials', async () => {
    try {
      await login('invaliduser', 'invalidpass');
      assert.fail('Login should have failed for invalid credentials');
    } catch (error) {
      assert(error.message.includes('Login failed'), 'Should get login failure error');
      assert(error.message.includes('401') || error.message.includes('Invalid credentials'),
        'Should get 401 or credentials error');
    }
  });

  // Test each user from fixtures
  for (const user of TEST_USERS) {
    test(`Should authenticate ${user.description} (${user.username})`, async () => {
      let sessionId = null;

      try {
        // Test login
        const loginResult = await login(user.username, user.password);
        assert(loginResult.sessionId, `Login should return session ID for ${user.username}`);
        assert(loginResult.user, `Login should return user data for ${user.username}`);

        sessionId = loginResult.sessionId;

        // Verify returned user has expected roles
        assert(Array.isArray(loginResult.user.roles), 'User should have roles array');
        for (const expectedRole of user.roles) {
          assert(loginResult.user.roles.includes(expectedRole),
            `User ${user.username} should have role: ${expectedRole}`);
        }

        // Test session status check
        const statusResult = await checkStatus(sessionId);
        assert.strictEqual(statusResult.username, user.username, 'Status should return correct username');
        assert(Array.isArray(statusResult.roles), 'Status should return roles array');

      } finally {
        // Clean up session if created
        if (sessionId) {
          await logout(sessionId).catch(() => {}); // Ignore logout errors in cleanup
        }
      }
    });
  }

  test('Should handle session validation correctly', async () => {
    // Test with invalid session
    try {
      await checkStatus('invalid-session-id');
      assert.fail('Status check should fail for invalid session');
    } catch (error) {
      assert(error.message.includes('Status check failed'), 'Should get status check failure');
    }
  });

  test('Should handle logout correctly', async () => {
    // Login first
    const { sessionId } = await login('testuser', 'testpass');

    // Logout
    await logout(sessionId); // Should not throw

    // Session should now be invalid
    try {
      await checkStatus(sessionId);
      assert.fail('Status check should fail after logout');
    } catch (error) {
      assert(error.message.includes('Status check failed'), 'Session should be invalid after logout');
    }
  });

});