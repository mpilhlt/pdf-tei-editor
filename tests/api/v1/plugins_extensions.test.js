/**
 * API Integration Tests for GET /api/v1/plugins/extensions.js
 *
 * Tests frontend extension bundle generation from backend plugins.
 * Extensions are class-based (extending FrontendExtensionPlugin) and are
 * delivered as IIFEs that call window.registerFrontendExtension(ClassName).
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

  // Should contain the class definition (export default stripped)
  assert.ok(
    content.includes('class HelloWorldExtension extends window.FrontendExtensionPlugin'),
    'Should contain class extending window.FrontendExtensionPlugin'
  );

  // Should register via window.registerFrontendExtension with class constructor
  assert.ok(
    content.includes('window.registerFrontendExtension(HelloWorldExtension'),
    'Should call window.registerFrontendExtension with class name'
  );

  // Registration should include pluginId as second argument
  assert.ok(
    content.includes('window.registerFrontendExtension(HelloWorldExtension, "test-plugin")'),
    'Should pass pluginId as second argument'
  );
});

test('GET /api/v1/plugins/extensions.js - removes ES module syntax', async () => {
  const response = await fetch(`${API_BASE}/api/v1/plugins/extensions.js`);
  assert.strictEqual(response.status, 200);

  const content = await response.text();

  // Should NOT contain export default (stripped before class declaration)
  assert.ok(
    !content.includes('export default class'),
    'Should strip "export default class" syntax'
  );

  // Should NOT contain import statements
  assert.ok(
    !content.includes('import '),
    'Should strip import statements'
  );

  // Should NOT contain local FrontendExtensionPlugin reference (replaced with window. prefix)
  assert.ok(
    !content.includes('extends FrontendExtensionPlugin\n') &&
    !content.includes('extends FrontendExtensionPlugin {'),
    'Should replace "extends FrontendExtensionPlugin" with window-prefixed version'
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
});
