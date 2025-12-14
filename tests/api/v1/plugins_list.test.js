/**
 * API Integration Tests for GET /api/v1/plugins
 *
 * Tests plugin discovery and role-based filtering.
 */

import { test } from 'node:test';
import assert from 'node:assert';
import { createTestUser, deleteTestUser, loginAsUser } from '../helpers/test-auth.js';

const API_BASE = process.env.E2E_BASE_URL || 'http://127.0.0.1:8014';

test('GET /api/v1/plugins - list plugins without authentication', async () => {
  const response = await fetch(`${API_BASE}/api/v1/plugins`);
  assert.strictEqual(response.status, 200);

  const data = await response.json();
  assert.ok(Array.isArray(data.plugins));

  // Without auth, should only see plugins with no required roles or empty required_roles
  // Sample analyzer requires 'user' role, so it should not appear
  const samplePlugin = data.plugins.find(p => p.id === 'sample-analyzer');
  assert.strictEqual(samplePlugin, undefined);
});

test('GET /api/v1/plugins - list plugins with user role', async (t) => {
  // Create test user with 'user' role
  const username = 'test_plugins_user';
  const password = 'testpass123';

  await createTestUser(username, password, ['user']);

  // Cleanup
  t.after(async () => {
    await deleteTestUser(username);
  });

  // Login
  const sessionId = await loginAsUser(username, password);

  // Fetch plugins
  const response = await fetch(`${API_BASE}/api/v1/plugins`, {
    headers: {
      'X-Session-ID': sessionId
    }
  });

  assert.strictEqual(response.status, 200);

  const data = await response.json();
  assert.ok(Array.isArray(data.plugins));

  // With 'user' role, should see sample-analyzer
  const samplePlugin = data.plugins.find(p => p.id === 'sample-analyzer');
  assert.ok(samplePlugin, 'Should find sample-analyzer plugin');
  assert.strictEqual(samplePlugin.name, 'Sample Text Analyzer');
  assert.strictEqual(samplePlugin.category, 'analyzer');
});

test('GET /api/v1/plugins - filter by category', async (t) => {
  // Create test user
  const username = 'test_plugins_category';
  const password = 'testpass123';

  await createTestUser(username, password, ['user']);

  t.after(async () => {
    await deleteTestUser(username);
  });

  const sessionId = await loginAsUser(username, password);

  // Fetch plugins with category filter
  const response = await fetch(`${API_BASE}/api/v1/plugins?category=analyzer`, {
    headers: {
      'X-Session-ID': sessionId
    }
  });

  assert.strictEqual(response.status, 200);

  const data = await response.json();
  assert.ok(Array.isArray(data.plugins));

  // All returned plugins should be in 'analyzer' category
  data.plugins.forEach(plugin => {
    assert.strictEqual(plugin.category, 'analyzer');
  });
});

test('GET /api/v1/plugins - response structure', async (t) => {
  const username = 'test_plugins_structure';
  const password = 'testpass123';

  await createTestUser(username, password, ['user']);

  t.after(async () => {
    await deleteTestUser(username);
  });

  const sessionId = await loginAsUser(username, password);

  const response = await fetch(`${API_BASE}/api/v1/plugins`, {
    headers: {
      'X-Session-ID': sessionId
    }
  });

  assert.strictEqual(response.status, 200);

  const data = await response.json();
  assert.ok(data.plugins);

  // Check structure of plugin objects
  if (data.plugins.length > 0) {
    const plugin = data.plugins[0];
    assert.ok(plugin.id);
    assert.ok(plugin.name);
    assert.ok(plugin.description !== undefined);
    assert.ok(plugin.category);
    assert.ok(plugin.version);
  }
});
