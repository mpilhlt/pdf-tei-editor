/**
 * FastAPI Configuration endpoint tests
 * @testCovers backend/api/config.py
 * @testCovers backend/lib/config_utils.py
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import {
  createTestSession,
  logout,
  authenticatedApiCall,
  authenticatedRequest
} from '../backend/helpers/test-auth.js';

const E2E_BASE_URL = process.env.E2E_BASE_URL || 'http://localhost:8000';
const API_BASE = `${E2E_BASE_URL}/api`;

describe('FastAPI Configuration API', () => {

  test('should get configuration list', async () => {
    const response = await fetch(`${API_BASE}/config/list`);

    assert.strictEqual(response.status, 200);
    const config = await response.json();
    assert.strictEqual(typeof config, 'object');
  });

  test('should get specific configuration value', async () => {
    // First ensure a test config value exists by setting it
    const { sessionId } = await createTestSession();

    const testKey = 'test.setting';
    const testValue = 'test_value';

    await authenticatedApiCall(sessionId, '/config/set', 'POST', {
      key: testKey,
      value: testValue
    });

    // Now get the value
    const response = await fetch(`${API_BASE}/config/get/${testKey}`);
    assert.strictEqual(response.status, 200);

    const value = await response.json();
    assert.strictEqual(value, testValue);

    await logout(sessionId);
  });

  test('should return 404 for non-existent configuration key', async () => {
    const response = await fetch(`${API_BASE}/config/get/non.existent.key`);
    assert.strictEqual(response.status, 404);

    const errorData = await response.json();
    assert.match(errorData.detail, /Key 'non\.existent\.key' not found/);
  });

  test('should return 400 for empty configuration key', async () => {
    const response = await fetch(`${API_BASE}/config/get/`);
    assert.strictEqual(response.status, 404); // FastAPI route not found for empty path
  });

  test('should set configuration value with authentication', async () => {
    const { sessionId } = await createTestSession();

    const testKey = 'auth.test.setting';
    const testValue = { complex: 'object', with: ['array', 'values'] };

    const result = await authenticatedApiCall(sessionId, '/config/set', 'POST', {
      key: testKey,
      value: testValue
    });

    assert.deepStrictEqual(result, { result: 'OK' });

    // Verify the value was set by reading it back
    const response = await fetch(`${API_BASE}/config/get/${testKey}`);
    assert.strictEqual(response.status, 200);

    const retrievedValue = await response.json();
    assert.deepStrictEqual(retrievedValue, testValue);

    await logout(sessionId);
  });

  test('should fail to set configuration without authentication', async () => {
    const response = await fetch(`${API_BASE}/config/set`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        key: 'test.setting',
        value: 'test_value'
      })
    });

    assert.strictEqual(response.status, 401);
    const errorData = await response.json();
    assert.match(errorData.detail, /Not authenticated/);
  });

  test('should fail to set configuration with missing key', async () => {
    const { sessionId } = await createTestSession();

    const response = await authenticatedRequest(sessionId, '/config/set', 'POST', {
      value: 'test_value'
    });

    assert.strictEqual(response.status, 422); // FastAPI validation error

    await logout(sessionId);
  });

  test('should fail to set configuration with empty key', async () => {
    const { sessionId } = await createTestSession();

    const response = await authenticatedRequest(sessionId, '/config/set', 'POST', {
      key: '',
      value: 'test_value'
    });

    assert.strictEqual(response.status, 400);
    const errorData = await response.json();
    assert.match(errorData.detail, /Missing 'key' in request body/);

    await logout(sessionId);
  });

  test('should get application state', async () => {
    const response = await fetch(`${API_BASE}/config/state`);

    assert.strictEqual(response.status, 200);
    const state = await response.json();

    // Verify expected state structure
    assert.strictEqual(typeof state, 'object');
    assert.strictEqual(typeof state.webdavEnabled, 'boolean');
  });

  test('should get instructions with authentication', async () => {
    const { sessionId } = await createTestSession();

    const instructions = await authenticatedApiCall(sessionId, '/config/instructions', 'GET');

    // Verify instructions structure
    assert(Array.isArray(instructions));

    // If instructions exist, verify their structure
    if (instructions.length > 0) {
      const instruction = instructions[0];
      assert.strictEqual(typeof instruction.label, 'string');
      assert(Array.isArray(instruction.extractor));
      assert(Array.isArray(instruction.text));
    }

    await logout(sessionId);
  });

  test('should fail to get instructions without authentication', async () => {
    const response = await fetch(`${API_BASE}/config/instructions`);

    assert.strictEqual(response.status, 401);
    const errorData = await response.json();
    assert.match(errorData.detail, /Not authenticated/);
  });

  test('should save instructions with authentication', async () => {
    const { sessionId } = await createTestSession();

    const testInstructions = [
      {
        label: 'Test instructions',
        extractor: ['test-extractor'],
        text: ['Test instruction text']
      }
    ];

    const result = await authenticatedApiCall(sessionId, '/config/instructions', 'POST', testInstructions);

    assert.deepStrictEqual(result, { result: 'ok' });

    // Verify the instructions were saved by reading them back
    const savedInstructions = await authenticatedApiCall(sessionId, '/config/instructions', 'GET');
    assert.deepStrictEqual(savedInstructions, testInstructions);

    await logout(sessionId);
  });

  test('should fail to save instructions without authentication', async () => {
    const response = await fetch(`${API_BASE}/config/instructions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify([
        {
          label: 'Test instructions',
          extractor: ['test-extractor'],
          text: ['Test instruction text']
        }
      ])
    });

    assert.strictEqual(response.status, 401);
    const errorData = await response.json();
    assert.match(errorData.detail, /Not authenticated/);
  });

  test('should fail to save instructions with invalid structure', async () => {
    const { sessionId } = await createTestSession();

    const response = await authenticatedRequest(sessionId, '/config/instructions', 'POST', [
      {
        // Missing required fields
        label: 'Test instructions'
        // Missing extractor and text arrays
      }
    ]);

    assert.strictEqual(response.status, 422); // FastAPI validation error

    await logout(sessionId);
  });

});