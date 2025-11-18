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
import { createTestSession, authenticatedRequest } from './helpers/test-auth.js';
import { logger } from '../helpers/test-logger.js';
import { logger } from '../helpers/test-logger.js';
import { logger } from '../helpers/test-logger.js';

// Get configuration from environment variables (set by e2e-runner.js)
const HOST = process.env.E2E_HOST || 'localhost';
const PORT = process.env.E2E_PORT || '8000';
const API_BASE = `http://${HOST}:${PORT}/api`;

describe('Extractor API E2E Tests', () => {

  test('GET /extract/list should return available extractors', async () => {
    const { sessionId } = await createTestSession();

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

    logger.success(`Found ${extractors.length} available extractors`);
    extractors.forEach(e => console.log(`  - ${e.id}: ${e.name}`));

    const extractorIds = extractors.map(e => e.id);
    const hasMock = extractorIds.includes('mock-extractor');
    assert(hasMock, 'Mock extractor should be available in test environment');
  });

  // this would need to be able to know which environment variables have
  // been passed to the container, so it can check whether the corresponding
  // extractors are returned. 
 /*  test('Extractor discovery system should work', async () => {
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

      // Check environment variables for expected extractors
      const hasGeminiKey = process.env.GEMINI_API_KEY;
      const hasGrobidUrl = process.env.GROBID_SERVER_URL;
      const hasKisskiKey = process.env.KISSKI_API_KEY;
      const isTestEnv = process.env.TEST_IN_PROGRESS === '1';

      // Check which extractors we found
      const hasKisski = extractorIds.includes('kisski-neural-chat');
      const hasLlamore = extractorIds.includes('llamore-gemini');
      const hasGrobidTraining = extractorIds.includes('grobid-training');
      const hasMock = extractorIds.includes('mock-extractor');

      console.log(`Environment check: GEMINI_API_KEY=${!!hasGeminiKey}, GROBID_SERVER_URL=${!!hasGrobidUrl}, KISSKI_API_KEY=${!!hasKisskiKey}, TEST_IN_PROGRESS=${isTestEnv}`);

      // Verify that if API keys/URLs are present, corresponding extractors should be available
      // BUT: in the test environment, the extractors may not be functional due to network restrictions
      // so we're more lenient - we just log what we find
      if (hasGeminiKey) {
        if (hasLlamore) {
          logger.success('Found llamore-gemini extractor (GEMINI_API_KEY present)');
        } else {
          logger.warn('GEMINI_API_KEY present but llamore-gemini extractor not available (may be network restricted in test environment)');
        }
      } else if (hasLlamore) {
        logger.success('Found llamore-gemini extractor (no GEMINI_API_KEY - may use fallback)');
      }

      if (hasGrobidUrl) {
        if (hasGrobidTraining) {
          logger.success('Found grobid-training extractor (GROBID_SERVER_URL present)');
        } else {
          logger.warn('GROBID_SERVER_URL present but grobid-training extractor not available (may be network restricted in test environment)');
        }
      } else if (hasGrobidTraining) {
        logger.success('Found grobid-training extractor (no GROBID_SERVER_URL - may use fallback)');
      }

      if (hasKisskiKey) {
        if (hasKisski) {
          logger.success('Found kisski-neural-chat extractor (KISSKI_API_KEY present)');
        } else {
          logger.warn('KISSKI_API_KEY present but kisski-neural-chat extractor not available (may be network restricted in test environment)');
        }
      } else if (hasKisski) {
        logger.success('Found kisski-neural-chat extractor (no KISSKI_API_KEY - may use fallback)');
      }

      if (isTestEnv) {
        assert(hasMock, 'Mock extractor should be available in test environment');
        logger.success('Found mock-extractor (TEST_IN_PROGRESS=1)');
      } else if (hasMock) {
        logger.warn('Found mock-extractor outside test environment');
      }

      // Verify at least one extractor is discovered
      const hasAnyExtractor = hasKisski || hasLlamore || hasGrobidTraining || hasMock || extractorIds.length > 0;
      assert(hasAnyExtractor, 'Should discover at least one extractor');

      logger.success('Extractor discovery system working');
      logger.success(`Discovered extractors: ${extractorIds.join(`, ')}');

    } finally {
      await logout(sessionId);
    }
  }); */

  test('API should handle invalid endpoints gracefully', async () => {
    const response = await fetch(`${API_BASE}/extract/nonexistent`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json'
      }
    });

    // Should return 404 or similar error status
    assert(response.status >= 400, 'Should return error status for invalid endpoint');

    logger.success(`Invalid endpoint returned status ${response.status}`);
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

    logger.success(`Malformed request returned status ${response.status}`);
  });

});