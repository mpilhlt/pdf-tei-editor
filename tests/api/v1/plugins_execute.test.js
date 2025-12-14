/**
 * API Integration Tests for POST /api/v1/plugins/{plugin_id}/execute
 *
 * Tests plugin execution, parameter validation, and error handling.
 */

import { test } from 'node:test';
import assert from 'node:assert';
import { createTestUser, deleteTestUser, loginAsUser } from '../helpers/test-auth.js';

const API_BASE = process.env.E2E_BASE_URL || 'http://127.0.0.1:8014';

test('POST /api/v1/plugins/{id}/execute - execute sample plugin', async (t) => {
  const username = 'test_execute_user';
  const password = 'testpass123';

  await createTestUser(username, password, ['user']);

  t.after(async () => {
    await deleteTestUser(username);
  });

  const sessionId = await loginAsUser(username, password);

  // Execute sample-analyzer plugin
  const response = await fetch(`${API_BASE}/api/v1/plugins/sample-analyzer/execute`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Session-ID': sessionId
    },
    body: JSON.stringify({
      endpoint: 'execute',
      params: {
        text: 'Hello world! This is a test.'
      }
    })
  });

  assert.strictEqual(response.status, 200);

  const data = await response.json();
  assert.strictEqual(data.success, true);
  assert.ok(data.result);
  assert.ok(data.result.analysis);
  assert.ok(data.result.analysis.word_count > 0);
  assert.ok(data.result.analysis.character_count > 0);
});

test('POST /api/v1/plugins/{id}/execute - execute info endpoint', async (t) => {
  const username = 'test_execute_info';
  const password = 'testpass123';

  await createTestUser(username, password, ['user']);

  t.after(async () => {
    await deleteTestUser(username);
  });

  const sessionId = await loginAsUser(username, password);

  // Execute info endpoint
  const response = await fetch(`${API_BASE}/api/v1/plugins/sample-analyzer/execute`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Session-ID': sessionId
    },
    body: JSON.stringify({
      endpoint: 'info',
      params: {}
    })
  });

  assert.strictEqual(response.status, 200);

  const data = await response.json();
  assert.strictEqual(data.success, true);
  assert.ok(data.result.plugin);
  assert.ok(data.result.version);
});

test('POST /api/v1/plugins/{id}/execute - nonexistent plugin', async (t) => {
  const username = 'test_execute_nonexistent';
  const password = 'testpass123';

  await createTestUser(username, password, ['user']);

  t.after(async () => {
    await deleteTestUser(username);
  });

  const sessionId = await loginAsUser(username, password);

  const response = await fetch(`${API_BASE}/api/v1/plugins/nonexistent-plugin/execute`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Session-ID': sessionId
    },
    body: JSON.stringify({
      endpoint: 'execute',
      params: {}
    })
  });

  assert.strictEqual(response.status, 404);

  const data = await response.json();
  assert.ok(data.detail);
  assert.ok(data.detail.includes('Plugin not found'));
});

test('POST /api/v1/plugins/{id}/execute - nonexistent endpoint', async (t) => {
  const username = 'test_execute_bad_endpoint';
  const password = 'testpass123';

  await createTestUser(username, password, ['user']);

  t.after(async () => {
    await deleteTestUser(username);
  });

  const sessionId = await loginAsUser(username, password);

  const response = await fetch(`${API_BASE}/api/v1/plugins/sample-analyzer/execute`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Session-ID': sessionId
    },
    body: JSON.stringify({
      endpoint: 'nonexistent',
      params: {}
    })
  });

  assert.strictEqual(response.status, 404);

  const data = await response.json();
  assert.ok(data.detail);
  assert.ok(data.detail.includes('Endpoint not found'));
});

test('POST /api/v1/plugins/{id}/execute - without authentication', async () => {
  // Try to execute plugin without auth (sample-analyzer requires 'user' role)
  const response = await fetch(`${API_BASE}/api/v1/plugins/sample-analyzer/execute`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      endpoint: 'execute',
      params: { text: 'test' }
    })
  });

  // Should not have access
  assert.strictEqual(response.status, 404);
});

test('POST /api/v1/plugins/{id}/execute - invalid request body', async (t) => {
  const username = 'test_execute_invalid';
  const password = 'testpass123';

  await createTestUser(username, password, ['user']);

  t.after(async () => {
    await deleteTestUser(username);
  });

  const sessionId = await loginAsUser(username, password);

  // Missing required fields
  const response = await fetch(`${API_BASE}/api/v1/plugins/sample-analyzer/execute`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Session-ID': sessionId
    },
    body: JSON.stringify({
      // Missing 'endpoint' and 'params'
    })
  });

  assert.strictEqual(response.status, 422);
});
