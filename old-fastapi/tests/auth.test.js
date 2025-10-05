/**
 * FastAPI Authentication endpoint tests
 * @testCovers backend/api/auth.py
 * @testCovers backend/lib/auth.py
 * @testCovers backend/lib/sessions.py
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import {
  login,
  logout,
  checkStatus,
  hashPassword,
  createTestSession
} from '../backend/helpers/test-auth.js';

const E2E_BASE_URL = process.env.E2E_BASE_URL || 'http://localhost:8000';
const API_BASE = `${E2E_BASE_URL}/api`;

describe('FastAPI Authentication API', () => {

  test('should successfully login with valid credentials', async () => {
    const { sessionId, user } = await createTestSession();

    // Verify session ID format (should be UUID)
    assert.match(sessionId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);

    // Verify user data structure
    assert.strictEqual(typeof user.username, 'string');
    assert.strictEqual(user.username, 'testuser');
    assert.strictEqual(typeof user.sessionId, 'string');
    assert.strictEqual(user.sessionId, sessionId);

    // Cleanup session
    await logout(sessionId);
  });

  test('should fail login with invalid credentials', async () => {
    try {
      await login('invalid_user', 'invalid_password');
      assert.fail('Expected login to fail with invalid credentials');
    } catch (error) {
      assert.match(error.message, /401.*Invalid credentials/);
    }
  });

  test('should fail login with missing username', async () => {
    const response = await fetch(`${API_BASE}/auth/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        passwd_hash: hashPassword('testpass')
      })
    });

    assert.strictEqual(response.status, 422); // FastAPI validation error
  });

  test('should fail login with missing password hash', async () => {
    const response = await fetch(`${API_BASE}/auth/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        username: 'testuser'
      })
    });

    assert.strictEqual(response.status, 422); // FastAPI validation error
  });

  test('should check status for authenticated user', async () => {
    const { sessionId } = await createTestSession();

    const user = await checkStatus(sessionId);

    // Verify user data structure
    assert.strictEqual(typeof user.username, 'string');
    assert.strictEqual(user.username, 'testuser');

    // Verify no sensitive data is exposed
    assert.strictEqual(user.passwd_hash, undefined);
    assert.strictEqual(user.session_id, undefined);

    // Cleanup session
    await logout(sessionId);
  });

  test('should fail status check for unauthenticated user', async () => {
    try {
      await checkStatus('invalid_session_id');
      assert.fail('Expected status check to fail with invalid session');
    } catch (error) {
      assert.match(error.message, /401.*Not authenticated/);
    }
  });

  test('should fail status check without session ID', async () => {
    const response = await fetch(`${API_BASE}/auth/status`, {
      method: 'GET'
    });

    assert.strictEqual(response.status, 401);
    const errorData = await response.json();
    assert.match(errorData.detail, /Not authenticated/);
  });

  test('should successfully logout with valid session', async () => {
    const { sessionId } = await createTestSession();

    // Verify session is valid before logout
    await checkStatus(sessionId);

    // Logout
    await logout(sessionId);

    // Verify session is invalid after logout
    try {
      await checkStatus(sessionId);
      assert.fail('Expected status check to fail after logout');
    } catch (error) {
      assert.match(error.message, /401.*Not authenticated/);
    }
  });

  test('should handle logout without session ID gracefully', async () => {
    const response = await fetch(`${API_BASE}/auth/logout`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      }
    });

    assert.strictEqual(response.status, 200);
    const data = await response.json();
    assert.strictEqual(data.status, 'logged_out');
  });

  test('should handle logout with invalid session ID gracefully', async () => {
    const response = await fetch(`${API_BASE}/auth/logout`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Cookie': 'sessionId=invalid_session'
      }
    });

    assert.strictEqual(response.status, 200);
    const data = await response.json();
    assert.strictEqual(data.status, 'logged_out');
  });

  test('should create unique session IDs for multiple logins', async () => {
    const { sessionId: sessionId1 } = await createTestSession();
    const { sessionId: sessionId2 } = await createTestSession();

    // Verify session IDs are different
    assert.notStrictEqual(sessionId1, sessionId2);

    // Verify both sessions are valid
    const user1 = await checkStatus(sessionId1);
    const user2 = await checkStatus(sessionId2);

    assert.strictEqual(user1.username, 'testuser');
    assert.strictEqual(user2.username, 'testuser');

    // Cleanup sessions
    await logout(sessionId1);
    await logout(sessionId2);
  });

});