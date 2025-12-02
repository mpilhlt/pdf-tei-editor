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
    API_BASE
} from '../helpers/test-auth.js';

describe('Configuration API', () => {
    test('should list all config values', async () => {
        const response = await fetch(`${API_BASE}/config/list`);

        assert.strictEqual(response.status, 200);

        const data = await response.json();
        assert.ok(typeof data === 'object', 'Should return config object');
        assert.ok('session.timeout' in data, 'Should have session.timeout');
    });

    test('should get specific config value', async () => {
        const response = await fetch(`${API_BASE}/config/get/session.timeout`);

        assert.strictEqual(response.status, 200);

        const data = await response.json();
        assert.strictEqual(data, 3600);
    });

    test('should return 404 for non-existent config key', async () => {
        const response = await fetch(`${API_BASE}/config/get/nonexistent.key`);

        assert.strictEqual(response.status, 404);
        const data = await response.json();
        assert.ok(data.detail.includes('not found'));
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

            // Verify the value was set
            const response = await fetch(`${API_BASE}/config/get/test.key`);
            assert.strictEqual(response.status, 200);
            const getValue = await response.json();
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

            // Verify values
            let response = await fetch(`${API_BASE}/config/get/test.number`);
            let value = await response.json();
            assert.strictEqual(value, 42);

            response = await fetch(`${API_BASE}/config/get/test.boolean`);
            value = await response.json();
            assert.strictEqual(value, true);

            response = await fetch(`${API_BASE}/config/get/test.array`);
            value = await response.json();
            assert.deepStrictEqual(value, [1, 2, 3]);
        } finally {
            await logout(sessionId);
        }
    });

    test('should get state information', async () => {
        const response = await fetch(`${API_BASE}/config/state`);

        assert.strictEqual(response.status, 200);

        const data = await response.json();
        assert.ok('webdavEnabled' in data, 'Should have webdavEnabled');
        assert.strictEqual(typeof data.webdavEnabled, 'boolean');

        // hasInternet is optional but should be present
        if ('hasInternet' in data) {
            assert.strictEqual(typeof data.hasInternet, 'boolean');
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
