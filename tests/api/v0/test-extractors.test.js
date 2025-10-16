#!/usr/bin/env node

/**
 * Backend Integration Test for extractor discovery and listing
 *
 * This test assumes a containerized test environment is already running
 * and focuses on testing the backend API.
 *
 * Usage: npm run test:e2e:backend tests/e2e/backend/test-extractors.test.js
 *
 * @testCovers server/api/extract.py
 * @testCovers server/lib/extractors/
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { createTestSession, authenticatedApiCall } from './helpers/test-auth.js';

// Enable debug output only when E2E_DEBUG environment variable is set
const DEBUG = process.env.E2E_DEBUG === 'true';
const debugLog = (...args) => {
  if (DEBUG) {
    console.log('[DEBUG]', ...args);
  }
};

describe('Extractor API E2E Tests', () => {
  let session = null;

  test('GET /extract/list should return available extractors', async () => {
    debugLog('Testing extractor list endpoint...');

    // Create authenticated session
    session = await createTestSession();
    debugLog('Session created successfully');

    // Test the /api/extract/list endpoint
    const extractors = await authenticatedApiCall(session.sessionId, '/extract/list', 'GET');

    // Verify response structure
    assert(Array.isArray(extractors), 'Should return an array of extractors');
    assert(extractors.length > 0, 'Should return at least one extractor');

    console.log(`✓ Found ${extractors.length} available extractors`);

    // Log each extractor for debugging
    extractors.forEach(extractor => {
      console.log(`  - ${extractor.id}: ${extractor.name}`);
      debugLog(`    Description: ${extractor.description}`);
      debugLog(`    Input: ${extractor.input?.join(', ') || 'none'}`);
      debugLog(`    Output: ${extractor.output?.join(', ') || 'none'}`);

      // Verify extractor structure
      assert(typeof extractor.id === 'string', 'Extractor should have string id');
      assert(typeof extractor.name === 'string', 'Extractor should have string name');
      assert(typeof extractor.description === 'string', 'Extractor should have string description');
      assert(Array.isArray(extractor.input), 'Extractor should have input array');
      assert(Array.isArray(extractor.output), 'Extractor should have output array');
    });

    debugLog('API responding successfully');
  });

  test('Extractor discovery system should work', async () => {
    debugLog('Testing extractor discovery system...');

    if (!session) {
      session = await createTestSession();
    }

    const extractors = await authenticatedApiCall(session.sessionId, '/extract/list', 'GET');

    // Check for specific extractors that should be available
    const llamoreExtractor = extractors.find(e => e.id === 'llamore-gemini');
    if (llamoreExtractor) {
      console.log('✓ Found llamore-gemini extractor');

      // Verify expected properties for llamore extractor
      if (llamoreExtractor.input?.includes('pdf') && llamoreExtractor.output?.includes('tei-document')) {
        debugLog('✓ LLamore extractor has correct input/output types');
      } else {
        console.log('⚠ LLamore extractor has unexpected input/output types');
      }
    } else {
      debugLog('LLamore+Gemini extractor not found (this may be expected depending on configuration)');
    }

    console.log('✓ Extractor discovery system working');

    const extractorNames = extractors.map(e => e.id).join(', ');
    console.log(`✓ Discovered extractors: ${extractorNames}`);

    // Verify we have at least some basic extractors
    assert(extractors.length > 0, 'Should have at least one extractor available');
  });

  test('API should handle invalid endpoints gracefully', async () => {
    debugLog('Testing invalid endpoint handling...');

    if (!session) {
      session = await createTestSession();
    }

    try {
      await authenticatedApiCall(session.sessionId, '/extract/nonexistent', 'GET');
      assert.fail('Should have thrown an error for invalid endpoint');
    } catch (error) {
      assert(error.message.includes('404'), 'Should return 404 for invalid endpoint');
      console.log('✓ Invalid endpoint returned status 404');
    }
  });

  test('API should handle malformed requests', async () => {
    debugLog('Testing malformed request handling...');

    if (!session) {
      session = await createTestSession();
    }

    try {
      // Try to POST to a GET-only endpoint
      await authenticatedApiCall(session.sessionId, '/extract/list', 'POST');
      assert.fail('Should have thrown an error for malformed request');
    } catch (error) {
      assert(error.message.includes('405'), 'Should return 405 for wrong HTTP method');
      console.log('✓ Malformed request returned status 405');
    }
  });
});