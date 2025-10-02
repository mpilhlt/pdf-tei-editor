/**
 * @testCovers backend/main.py
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';

const E2E_BASE_URL = process.env.E2E_BASE_URL || 'http://localhost:8000';

describe('FastAPI Health Check', () => {
  test('should return status ok from /health', async () => {
    const response = await fetch(`${E2E_BASE_URL}/health`);
    assert.strictEqual(response.status, 200);
    const body = await response.json();
    assert.deepStrictEqual(body, { status: 'ok' });
  });
});
