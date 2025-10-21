/**
 * Authentication API tests
 *
 * @testCovers fastapi_app/api/auth.py
 * 
 */
import { test, describe } from 'node:test';
import assert from 'node:assert';
import { login, logout, checkStatus, API_BASE } from '../helpers/test-auth.js';

describe('Authentication API', () => {
    let sessionId = null;

    test('should reject login with missing credentials', async () => {
        const response = await fetch(`${API_BASE}/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: 'admin' })
        });

        assert.strictEqual(response.status, 422); // Validation error
    });

    test('should reject login with invalid credentials', async () => {
        const response = await fetch(`${API_BASE}/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                username: 'admin',
                passwd_hash: 'invalid_hash'
            })
        });

        assert.strictEqual(response.status, 401);
        const data = await response.json();
        assert.strictEqual(data.detail, 'Invalid credentials');
    });

    test('should login with valid credentials', async () => {
        const { sessionId: sid, user } = await login('admin', 'admin');

        assert.strictEqual(user.username, 'admin');
        assert.strictEqual(user.fullname, 'Administrator');
        assert.ok(Array.isArray(user.roles) && user.roles.includes('admin'), 'User should have admin role');
        assert.ok(sid, 'Should return session ID');

        // Save session ID for subsequent tests
        sessionId = sid;
    });

    test('should check status with valid session', async () => {
        assert.ok(sessionId, 'Session ID should exist from login test');

        const user = await checkStatus(sessionId);
        assert.strictEqual(user.username, 'admin');
        assert.strictEqual(user.fullname, 'Administrator');
        assert.ok(Array.isArray(user.roles) && user.roles.includes('admin'), 'User should have admin role');
    });

    test('should reject status check without session', async () => {
        const response = await fetch(`${API_BASE}/auth/status`, {
            method: 'GET'
        });

        assert.strictEqual(response.status, 401);
        const data = await response.json();
        assert.strictEqual(data.detail, 'Not authenticated');
    });

    test('should reject status check with invalid session', async () => {
        const response = await fetch(`${API_BASE}/auth/status`, {
            method: 'GET',
            headers: { 'X-Session-Id': 'invalid-session-id' }
        });

        assert.strictEqual(response.status, 401);
    });

    test('should logout successfully', async () => {
        assert.ok(sessionId, 'Session ID should exist from login test');

        await logout(sessionId);

        // Verify session is invalid after logout
        const response = await fetch(`${API_BASE}/auth/status`, {
            method: 'GET',
            headers: { 'X-Session-Id': sessionId }
        });

        assert.strictEqual(response.status, 401);
    });

    test('should allow logout without session (idempotent)', async () => {
        const response = await fetch(`${API_BASE}/auth/logout`, {
            method: 'POST'
        });

        assert.strictEqual(response.status, 200);

        const data = await response.json();
        assert.strictEqual(data.status, 'logged_out');
    });

    test('should create new session on each login', async () => {
        // First login
        const { sessionId: sessionId1 } = await login('admin', 'admin');

        // Second login
        const { sessionId: sessionId2 } = await login('admin', 'admin');

        // Sessions should be different
        assert.notStrictEqual(sessionId1, sessionId2, 'Each login should create a new session');

        // Clean up
        await logout(sessionId1);
        await logout(sessionId2);
    });

    test('should validate session persistence', async () => {
        const { sessionId } = await login('admin', 'admin');

        // Make multiple status checks
        const user1 = await checkStatus(sessionId);
        const user2 = await checkStatus(sessionId);

        assert.strictEqual(user1.username, user2.username);

        await logout(sessionId);
    });
});
