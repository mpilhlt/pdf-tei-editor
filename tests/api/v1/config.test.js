/**
 * Configuration API tests
 *
 * @testCovers fastapi_app/api/config.py
 *
 */
import { test, describe } from 'node:test';
import assert from 'node:assert';
import {
    login,
    logout,
    authenticatedApiCall,
    authenticatedRequest,
    API_BASE
} from '../helpers/test-auth.js';

describe('Configuration API', () => {
    test('should reject list without authentication', async () => {
        const response = await fetch(`${API_BASE}/config/list`);
        assert.strictEqual(response.status, 401);
    });

    test('should list all config values with authentication', async () => {
        const { sessionId } = await login('admin', 'admin');
        try {
            const data = await authenticatedApiCall(sessionId, '/config/list', 'GET');
            assert.ok(typeof data === 'object', 'Should return config object');
            assert.ok('session.timeout' in data, 'Should have session.timeout');
        } finally {
            await logout(sessionId);
        }
    });

    test('should reject get without authentication', async () => {
        const response = await fetch(`${API_BASE}/config/get/session.timeout`);
        assert.strictEqual(response.status, 401);
    });

    test('should get specific config value with authentication', async () => {
        const { sessionId } = await login('admin', 'admin');
        try {
            const data = await authenticatedApiCall(sessionId, '/config/get/session.timeout', 'GET');
            assert.strictEqual(typeof data, 'number', 'session.timeout should be a number');
        } finally {
            await logout(sessionId);
        }
    });

    test('should return 404 for non-existent config key', async () => {
        const { sessionId } = await login('admin', 'admin');
        try {
            const response = await authenticatedRequest(sessionId, '/config/get/nonexistent.key', 'GET');
            assert.strictEqual(response.status, 404);
            const data = await response.json();
            assert.ok(data.detail.includes('not found'));
        } finally {
            await logout(sessionId);
        }
    });

    test('should reject set config without authentication', async () => {
        const response = await fetch(`${API_BASE}/config/set`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                key: 'test.key',
                value: 'test value'
            })
        });

        assert.strictEqual(response.status, 401);
    });

    test('should set config value with authentication', async () => {
        const { sessionId } = await login('admin', 'admin');

        try {
            const result = await authenticatedApiCall(
                sessionId,
                '/config/set',
                'POST',
                { key: 'test.key', value: 'test value' }
            );

            assert.strictEqual(result.result, 'OK');

            // Verify the value was set (authenticated)
            const getValue = await authenticatedApiCall(sessionId, '/config/get/test.key', 'GET');
            assert.strictEqual(getValue, 'test value');
        } finally {
            await logout(sessionId);
        }
    });

    test('should set config with different value types', async () => {
        const { sessionId } = await login('admin', 'admin');

        try {
            // Test number
            await authenticatedApiCall(
                sessionId,
                '/config/set',
                'POST',
                { key: 'test.number', value: 42 }
            );

            // Test boolean
            await authenticatedApiCall(
                sessionId,
                '/config/set',
                'POST',
                { key: 'test.boolean', value: true }
            );

            // Test array
            await authenticatedApiCall(
                sessionId,
                '/config/set',
                'POST',
                { key: 'test.array', value: [1, 2, 3] }
            );

            // Verify values (all authenticated)
            const numVal = await authenticatedApiCall(sessionId, '/config/get/test.number', 'GET');
            assert.strictEqual(numVal, 42);

            const boolVal = await authenticatedApiCall(sessionId, '/config/get/test.boolean', 'GET');
            assert.strictEqual(boolVal, true);

            const arrVal = await authenticatedApiCall(sessionId, '/config/get/test.array', 'GET');
            assert.deepStrictEqual(arrVal, [1, 2, 3]);
        } finally {
            await logout(sessionId);
        }
    });

    test('should get state information without authentication', async () => {
        const response = await fetch(`${API_BASE}/config/state`);

        assert.strictEqual(response.status, 200);

        const data = await response.json();

        // hasInternet is optional
        if ('hasInternet' in data) {
            assert.strictEqual(typeof data.hasInternet, 'boolean');
        }

        // Non-sensitive config must be present and complete
        assert.ok('publicConfig' in data, 'Should have publicConfig');
        assert.ok(typeof data.publicConfig === 'object', 'publicConfig should be an object');
        assert.ok('application.mode' in data.publicConfig, 'publicConfig should have application.mode');
        assert.ok('session.timeout' in data.publicConfig, 'publicConfig should have session.timeout');

        // Sensitive keys must not appear in publicConfig
        const sensitivePatterns = ['api.key', 'api-key', 'password'];
        for (const key of Object.keys(data.publicConfig)) {
            assert.ok(
                !sensitivePatterns.some(p => key.includes(p)),
                `publicConfig must not contain sensitive key: ${key}`
            );
        }
    });

    test('should reject get instructions without authentication', async () => {
        const response = await fetch(`${API_BASE}/config/instructions`);

        assert.strictEqual(response.status, 401);
    });

    test('should get instructions with authentication', async () => {
        const { sessionId } = await login('admin', 'admin');

        try {
            const instructions = await authenticatedApiCall(
                sessionId,
                '/config/instructions',
                'GET'
            );

            assert.ok(Array.isArray(instructions), 'Should return array of instructions');
        } finally {
            await logout(sessionId);
        }
    });

    test('should save instructions with authentication', async () => {
        const { sessionId } = await login('admin', 'admin');

        try {
            const testInstructions = [
                {
                    label: 'Test Instruction',
                    extractor: ['test-extractor'],
                    text: ['Test instruction text']
                }
            ];

            const result = await authenticatedApiCall(
                sessionId,
                '/config/instructions',
                'POST',
                testInstructions
            );

            assert.strictEqual(result.result, 'ok');

            // Verify instructions were saved
            const savedInstructions = await authenticatedApiCall(
                sessionId,
                '/config/instructions',
                'GET'
            );

            assert.deepStrictEqual(savedInstructions, testInstructions);
        } finally {
            await logout(sessionId);
        }
    });

    test('should reject save instructions without authentication', async () => {
        const response = await fetch(`${API_BASE}/config/instructions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify([
                {
                    label: 'Test',
                    extractor: ['test'],
                    text: []
                }
            ])
        });

        assert.strictEqual(response.status, 401);
    });
});
