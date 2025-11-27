/**
 * E2E Backend Tests for Collections API
 * @testCovers fastapi_app/routers/collections.py
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { authenticatedApiCall, logout, login } from '../helpers/test-auth.js';
import { logger } from '../helpers/test-logger.js';

const BASE_URL = process.env.E2E_BASE_URL || 'http://localhost:8000';

// Test session management
let globalSession = null;

describe('Collections API E2E Tests', { concurrency: 1 }, () => {

  const testState = {
    testCollectionId: 'test-collection-' + Date.now(),
    testCollectionName: 'Test Collection',
    testCollectionDescription: 'A test collection for E2E tests'
  };

  async function getSession() {
    if (!globalSession) {
      // Use reviewer which has permission to create collections
      globalSession = await login('reviewer', 'reviewer', BASE_URL);
      logger.info(`  Created session: ${globalSession.sessionId}`);
    }
    logger.info(`Using session: ${globalSession.sessionId}`);
    return globalSession;
  }

  test('GET /api/v1/collections/list should return accessible collections', async () => {
    const session = await getSession();

    const result = await authenticatedApiCall(session.sessionId, '/collections/list', 'GET', null, BASE_URL);

    assert(result.collections, 'Should return collections array');
    assert(Array.isArray(result.collections), 'Collections should be an array');

    // Verify collection structure
    if (result.collections.length > 0) {
      const firstCollection = result.collections[0];
      assert(firstCollection.id, 'Collection should have id');
      assert(firstCollection.name, 'Collection should have name');
      assert('description' in firstCollection, 'Collection should have description property');
    }

    logger.success(`Retrieved ${result.collections.length} collections`);
  });

  test('POST /api/v1/collections/create should create a new collection', async () => {
    const session = await getSession();

    const result = await authenticatedApiCall(session.sessionId, '/collections/create', 'POST', {
      id: testState.testCollectionId,
      name: testState.testCollectionName,
      description: testState.testCollectionDescription
    }, BASE_URL);

    assert(result.success, 'Should return success');
    assert(result.collection, 'Should return created collection');
    assert.strictEqual(result.collection.id, testState.testCollectionId, 'Collection ID should match');
    assert.strictEqual(result.collection.name, testState.testCollectionName, 'Collection name should match');
    assert.strictEqual(result.collection.description, testState.testCollectionDescription, 'Collection description should match');

    logger.success(`Collection created: ${result.collection.id}`);
  });

  test('POST /api/v1/collections/create should default name to id if not provided', async () => {
    const session = await getSession();
    const testId = 'test-no-name-' + Date.now();

    const result = await authenticatedApiCall(session.sessionId, '/collections/create', 'POST', {
      id: testId
    }, BASE_URL);

    assert(result.success, 'Should return success');
    assert.strictEqual(result.collection.name, testId, 'Collection name should default to ID');

    logger.success(`Collection created with default name: ${result.collection.id}`);
  });

  test('POST /api/v1/collections/create should reject duplicate collection IDs', async () => {
    const session = await getSession();

    try {
      await authenticatedApiCall(session.sessionId, '/collections/create', 'POST', {
        id: testState.testCollectionId,
        name: 'Duplicate Collection'
      }, BASE_URL);

      assert.fail('Should have thrown error for duplicate collection ID');
    } catch (error) {
      assert(error.message.includes('400') || error.message.includes('already exists'),
             'Should return 400 error for duplicate collection');
      logger.success('Duplicate collection ID rejected');
    }
  });

  test('POST /api/v1/collections/create should reject invalid collection IDs', async () => {
    const session = await getSession();

    try {
      await authenticatedApiCall(session.sessionId, '/collections/create', 'POST', {
        id: 'invalid collection id with spaces!',
        name: 'Invalid Collection'
      }, BASE_URL);

      assert.fail('Should have thrown validation error');
    } catch (error) {
      assert(error.message.includes('400') || error.message.includes('Invalid'),
             'Should return 400 error for invalid collection ID');
      logger.success('Invalid collection ID rejected');
    }
  });

  test('POST /api/v1/collections/create should require authentication', async () => {
    try {
      await authenticatedApiCall('invalid-session-id', '/collections/create', 'POST', {
        id: 'test-unauth',
        name: 'Test Unauthorized'
      }, BASE_URL);

      assert.fail('Should have thrown 401 error');
    } catch (error) {
      assert(error.message.includes('401'), 'Should return 401 for unauthenticated request');
      logger.success('Unauthenticated request rejected');
    }
  });

  test('POST /api/v1/collections/create should require admin/reviewer role', async () => {
    // Login as regular user (not reviewer/admin)
    const userSession = await login('user', 'user', BASE_URL);

    try {
      await authenticatedApiCall(userSession.sessionId, '/collections/create', 'POST', {
        id: 'test-no-perms',
        name: 'Test No Permissions'
      }, BASE_URL);

      assert.fail('Should have thrown 403 error');
    } catch (error) {
      assert(error.message.includes('403'), 'Should return 403 for insufficient permissions');
      logger.success('Insufficient permissions rejected');
    } finally {
      await logout(userSession.sessionId, BASE_URL);
    }
  });

  test('GET /api/v1/collections/list should include newly created collection', async () => {
    const session = await getSession();

    const result = await authenticatedApiCall(session.sessionId, '/collections/list', 'GET', null, BASE_URL);

    const createdCollection = result.collections.find(c => c.id === testState.testCollectionId);
    assert(createdCollection, 'Should include newly created collection');
    assert.strictEqual(createdCollection.name, testState.testCollectionName, 'Collection name should match');

    logger.success('Newly created collection found in list');
  });

  test('POST /api/v1/files/copy should work with new collection', async () => {
    const session = await getSession();

    // Get file list to find a file to copy
    const fileList = await authenticatedApiCall(session.sessionId, '/files/list', 'GET', null, BASE_URL);

    if (!fileList.files || fileList.files.length === 0) {
      logger.warn('No files available to test copy operation, skipping');
      return;
    }

    const testFile = fileList.files[0];
    const pdfId = testFile.source?.id;
    const xmlId = testFile.artifacts?.[0]?.id;

    if (!pdfId || !xmlId) {
      logger.warn('Test file missing required IDs, skipping');
      return;
    }

    // Copy to new collection
    const result = await authenticatedApiCall(session.sessionId, '/files/copy', 'POST', {
      pdf_id: pdfId,
      xml_id: xmlId,
      destination_collection: testState.testCollectionId
    }, BASE_URL);

    assert(result.new_pdf_id, 'Should return new PDF ID');
    assert(result.new_xml_id, 'Should return new XML ID');

    logger.success(`File copied to new collection: ${testState.testCollectionId}`);
  });

  test('Cleanup: Logout', async () => {
    if (globalSession) {
      await logout(globalSession.sessionId, BASE_URL);
      globalSession = null;
      logger.success('Global session cleaned up');
    }
  });

});
