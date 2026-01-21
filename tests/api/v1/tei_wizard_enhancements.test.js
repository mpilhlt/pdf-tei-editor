/**
 * Tests for the TEI Wizard Enhancement Registry endpoint.
 *
 * @testCovers fastapi_app/plugins/tei_wizard/routes.py
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

const BASE_URL = process.env.E2E_BASE_URL || 'http://127.0.0.1:8014';

describe('TEI Wizard Enhancements Endpoint', async () => {
  it('GET /api/plugins/tei-wizard/enhancements.js - returns JavaScript bundle', async () => {
    const response = await fetch(`${BASE_URL}/api/plugins/tei-wizard/enhancements.js`);

    assert.strictEqual(response.status, 200, 'Should return 200 OK');

    const contentType = response.headers.get('content-type');
    assert.ok(
      contentType.includes('javascript') || contentType.includes('text/plain'),
      'Should return JavaScript content type'
    );

    const body = await response.text();

    // Should contain the IIFE wrapper pattern
    assert.ok(body.includes('(function()'), 'Should contain IIFE wrapper');
    assert.ok(body.includes('window.registerTeiEnhancement'), 'Should contain registration call');

    // Should contain enhancement metadata
    assert.ok(body.includes('pluginId:'), 'Should include pluginId');
  });

  it('GET /api/plugins/tei-wizard/enhancements.js - includes default enhancements', async () => {
    const response = await fetch(`${BASE_URL}/api/plugins/tei-wizard/enhancements.js`);
    const body = await response.text();

    // Should contain the default enhancements
    assert.ok(
      body.includes('Add RNG Schema Definition'),
      'Should include Add RNG Schema Definition enhancement'
    );
    assert.ok(
      body.includes('Pretty Print XML'),
      'Should include Pretty Print XML enhancement'
    );
  });

  it('GET /api/plugins/tei-wizard/enhancements.js - transforms ES module syntax', async () => {
    const response = await fetch(`${BASE_URL}/api/plugins/tei-wizard/enhancements.js`);
    const body = await response.text();

    // Should not contain ES module syntax
    assert.ok(!body.includes('export const'), 'Should not contain export const');
    assert.ok(!body.includes('export function'), 'Should not contain export function');
    assert.ok(!body.includes('import '), 'Should not contain import statements');

    // Should contain transformed syntax
    assert.ok(body.includes('const name ='), 'Should have const name declaration');
    assert.ok(body.includes('const description ='), 'Should have const description declaration');
    assert.ok(body.includes('function execute'), 'Should have execute function');
  });
});
