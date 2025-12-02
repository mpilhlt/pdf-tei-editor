/**
 * Health check endpoint tests
 *
 * @testCovers fastapi/main.py
 * 
 */
import { test, describe } from 'node:test';
import assert from 'node:assert';

const BASE_URL = process.env.E2E_BASE_URL || 'http://localhost:8000';

describe('Health Check', () => {
    test('should return ok status', async () => {
        const response = await fetch(`${BASE_URL}/health`);
        assert.strictEqual(response.status, 200);

        const data = await response.json();
        assert.strictEqual(data.status, 'ok');
    });
});
