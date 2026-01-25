/**
 * API Integration Tests for GET /api/v1/plugins/extensions.js
 *
 * Tests frontend extension bundle generation from backend plugins.
 */

import { test } from 'node:test';
import assert from 'node:assert';

const API_BASE = process.env.E2E_BASE_URL || 'http://127.0.0.1:8014';

test('GET /api/v1/plugins/extensions.js - returns JavaScript bundle', async () => {
  const response = await fetch(`${API_BASE}/api/v1/plugins/extensions.js`);
  assert.strictEqual(response.status, 200);

  const contentType = response.headers.get('content-type');
  assert.ok(
    contentType.includes('application/javascript') || contentType.includes('text/plain'),
    `Expected JavaScript content type, got: ${contentType}`
  );

  const content = await response.text();
  assert.ok(content.length > 0, 'Response should not be empty');
});

test('GET /api/v1/plugins/extensions.js - contains test-plugin hello-world extension', async () => {
  const response = await fetch(`${API_BASE}/api/v1/plugins/extensions.js`);
  assert.strictEqual(response.status, 200);

  const content = await response.text();

  // Should contain header comment identifying the plugin
  assert.ok(
    content.includes('Frontend extension from plugin: test-plugin'),
    'Should identify test-plugin as source'
  );

  // Should contain the IIFE wrapper
  assert.ok(
    content.includes('(function() {'),
    'Should wrap in IIFE'
  );

  // Should contain the extension name
  assert.ok(
    content.includes('const name = "hello-world-test"'),
    'Should include extension name'
  );

  // Should contain the install function (without export keyword)
  assert.ok(
    content.includes('function install(state, sandbox)'),
    'Should include install function without export'
  );

  // Should contain the greet function (without export keyword)
  assert.ok(
    content.includes('function greet(greeting, sandbox)'),
    'Should include greet function without export'
  );

  // Should register via window.registerFrontendExtension
  assert.ok(
    content.includes('window.registerFrontendExtension'),
    'Should call window.registerFrontendExtension'
  );

  // Registration should include pluginId
  assert.ok(
    content.includes('pluginId: "test-plugin"'),
    'Should include pluginId in registration'
  );
});

test('GET /api/v1/plugins/extensions.js - removes ES module syntax', async () => {
  const response = await fetch(`${API_BASE}/api/v1/plugins/extensions.js`);
  assert.strictEqual(response.status, 200);

  const content = await response.text();

  // Should NOT contain export keywords (they should be stripped)
  assert.ok(
    !content.includes('export const name'),
    'Should strip "export const" syntax'
  );

  assert.ok(
    !content.includes('export function'),
    'Should strip "export function" syntax'
  );

  // Should NOT contain import statements
  assert.ok(
    !content.includes('import '),
    'Should strip import statements'
  );
});

test('GET /api/v1/plugins/extensions.js - bundle structure is valid IIFE', async () => {
  const response = await fetch(`${API_BASE}/api/v1/plugins/extensions.js`);
  assert.strictEqual(response.status, 200);

  const content = await response.text();

  // Should be a complete IIFE that ends properly
  assert.ok(
    content.includes('})();'),
    'Should close IIFE properly with })();'
  );

  // Registration object should include exported names
  const registrationMatch = content.match(/window\.registerFrontendExtension\(\{([^}]+)/);
  assert.ok(registrationMatch, 'Should have registration call');

  const registrationContent = registrationMatch[1];
  assert.ok(registrationContent.includes('name'), 'Registration should include name');
  assert.ok(registrationContent.includes('description'), 'Registration should include description');
  assert.ok(registrationContent.includes('deps'), 'Registration should include deps');
  assert.ok(registrationContent.includes('install'), 'Registration should include install');
  assert.ok(registrationContent.includes('greet'), 'Registration should include greet');
});
