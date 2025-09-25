/**
 * E2E Backend Tests for Extractor API endpoints
 * @testCovers server/api/extract.py
 * @testCovers bin/extractors/llamore.py
 * @testCovers bin/extractors/kisski.py
 * @env GEMINI_API_KEY
 * @env KISSKI_API_KEY
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { login, logout, authenticatedRequest } from './helpers/test-auth.js';

// Get configuration from environment variables (set by e2e-runner.js)
const HOST = process.env.E2E_HOST || 'localhost';
const PORT = process.env.E2E_PORT || '8000';
const API_BASE = `http://${HOST}:${PORT}/api`;

// Test user credentials
const TEST_USER = { username: 'testadmin', password: 'adminpass' };

describe('Extractor API E2E Tests', () => {

  test('GET /extract/list should return available extractors', async () => {
    const { sessionId } = await login(TEST_USER.username, TEST_USER.password);

    try {
      const response = await authenticatedRequest(
        sessionId,
        '/extract/list',
        'GET'
      );

      assert.strictEqual(response.status, 200, 'Should return 200 from containerized backend');

      const extractors = await response.json();
      assert(Array.isArray(extractors), 'Should return an array of extractors');
      assert(extractors.length >= 1, 'Should have at least one extractor');

      // Check that each extractor has the required fields
      for (const extractor of extractors) {
        assert(typeof extractor.id === 'string', 'Extractor should have string id');
        assert(typeof extractor.name === 'string', 'Extractor should have string name');
        assert(Array.isArray(extractor.input), 'Extractor should have input array');
        assert(Array.isArray(extractor.output), 'Extractor should have output array');
      }

      // Check for expected extractors
      const llamoreExtractor = extractors.find(e => e.id === 'llamore-gemini');
      const kisskiExtractor = extractors.find(e => e.id === 'kisski-neural-chat');

      if (llamoreExtractor) {
        assert(llamoreExtractor.input.includes('pdf'), 'LLamore should support PDF input');
        assert(llamoreExtractor.output.includes('tei-document'), 'LLamore should output TEI documents');
        assert(typeof llamoreExtractor.description === 'string', 'Should have description');
      }

      if (kisskiExtractor) {
        assert(kisskiExtractor.input.includes('text'), 'KISSKI should support text input');
        assert(kisskiExtractor.output.includes('text'), 'KISSKI should output text');
        assert(kisskiExtractor.requires_api_key === true, 'KISSKI should require API key');
        assert(kisskiExtractor.api_key_env === 'KISSKI_API_KEY', 'KISSKI should specify correct env var');
      }

      console.log(`✓ Found ${extractors.length} available extractors`);
      extractors.forEach(e => console.log(`  - ${e.id}: ${e.name}`));

    } finally {
      await logout(sessionId);
    }
  });

  test('Extractor discovery system should work', async () => {
    const { sessionId } = await login(TEST_USER.username, TEST_USER.password);

    try {
      // Verify the endpoint responds and discovers expected extractors
      const response = await authenticatedRequest(
        sessionId,
        '/extract/list',
        'GET'
      );

      assert.strictEqual(response.status, 200, 'Discovery endpoint should be accessible');

      const extractors = await response.json();
      // @ts-ignore
      const extractorIds = extractors.map(e => e.id);

      // Verify at least one expected extractor is discovered
      const hasKisski = extractorIds.includes('kisski-neural-chat');
      const hasLlamore = extractorIds.includes('llamore-gemini');

      assert(hasKisski || hasLlamore, 'Should discover at least one expected extractor (kisski or llamore)');

      // Verify specific extractors if they are available
      if (hasKisski) {
        console.log('✓ Found kisski-neural-chat extractor');
      }
      if (hasLlamore) {
        console.log('✓ Found llamore-gemini extractor');
      }

      console.log('✓ Extractor discovery system working');
      console.log(`✓ Discovered extractors: ${extractorIds.join(', ')}`);

    } finally {
      await logout(sessionId);
    }
  });

  test('API should handle invalid endpoints gracefully', async () => {
    const response = await fetch(`${API_BASE}/extract/nonexistent`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json'
      }
    });

    // Should return 404 or similar error status
    assert(response.status >= 400, 'Should return error status for invalid endpoint');

    console.log(`✓ Invalid endpoint returned status ${response.status}`);
  });

  test('API should handle malformed requests', async () => {
    const response = await fetch(`${API_BASE}/extract/list`, {
      method: 'POST', // Wrong method
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ invalid: 'data' })
    });

    // Should return method not allowed or similar error
    assert(response.status >= 400, 'Should return error status for wrong HTTP method');

    console.log(`✓ Malformed request returned status ${response.status}`);
  });

});