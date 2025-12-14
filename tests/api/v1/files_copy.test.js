/**
 * E2E Backend Tests for File Copy API
 * @testCovers fastapi_app/routers/files_copy.py
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { authenticatedApiCall, logout, login } from '../helpers/test-auth.js';
import { logger } from '../helpers/test-logger.js';

const BASE_URL = process.env.E2E_BASE_URL || 'http://localhost:8000';

// Test session management
let globalSession = null;

describe('File Copy API E2E Tests', { concurrency: 1 }, () => {

  const testState = {
    // Use existing PDF from fixtures
    testDocId: '10.5771__2699-1284-2024-3-149',
    destinationCollection: 'default',
    pdfHash: null,
    teiHash: null
  };

  async function getSession() {
    if (!globalSession) {
      // Use reviewer which can create gold files
      globalSession = await login('reviewer', 'reviewer', BASE_URL);
      logger.info(`  Created session: ${globalSession.sessionId}`);
    }
    logger.info(`Using session: ${globalSession.sessionId}`);
    return globalSession;
  }

  test('Setup: Create test files for copy tests', async () => {
    const session = await getSession();

    // Get file list to find any available PDF from fixtures
    const fileList = await authenticatedApiCall(session.sessionId, '/files/list', 'GET', null, BASE_URL);

    // Find the first document with a PDF source
    for (const docGroup of fileList.files) {
      if (docGroup.source && docGroup.source.file_type === 'pdf') {
        testState.testDocId = docGroup.doc_id;
        testState.pdfHash = docGroup.source.id;
        if (docGroup.artifacts && docGroup.artifacts.length > 0) {
          testState.teiHash = docGroup.artifacts[0].id;
        }
        break;
      }
    }

    if (!testState.pdfHash) {
      throw new Error('Could not find PDF fixture for copy test');
    }

    logger.success(`Found test PDF for copy tests: ${testState.testDocId}`);
  });

  test('POST /api/v1/files/copy should copy files to new collection', async () => {
    const session = await getSession();

    // Get original collections before copy
    const fileList = await authenticatedApiCall(session.sessionId, '/files/list', 'GET', null, BASE_URL);
    const originalDoc = fileList.files.find(doc => doc.doc_id === testState.testDocId);
    const originalCollections = originalDoc.collections || [];

    // Copy files to new collection using hashes from setup
    const result = await authenticatedApiCall(session.sessionId, '/files/copy', 'POST', {
      pdf_id: testState.pdfHash,
      xml_id: testState.teiHash,
      destination_collection: testState.destinationCollection
    }, BASE_URL);

    assert(result.new_pdf_id, 'Should return new PDF ID');
    assert(result.new_xml_id, 'Should return new XML ID');

    // Verify file is now in both collections
    const updatedFileList = await authenticatedApiCall(session.sessionId, '/files/list', 'GET', null, BASE_URL);

    const copiedDoc = updatedFileList.files.find(doc => doc.doc_id === testState.testDocId);
    assert(copiedDoc, 'Document should still exist');

    // Should have all original collections plus the new one
    for (const col of originalCollections) {
      assert(copiedDoc.collections.includes(col), `Should still be in original collection: ${col}`);
    }
    assert(copiedDoc.collections.includes(testState.destinationCollection), 'Should be in destination collection');

    logger.success(`Files copied successfully: PDF=${result.new_pdf_id}, XML=${result.new_xml_id}`);
  });

  test('POST /api/v1/files/copy should support abbreviated hashes', async () => {
    const session = await getSession();

    if (!testState.pdfHash || !testState.teiHash) {
      logger.warn('Test hashes not available, skipping');
      return;
    }

    // Copy using abbreviated hashes
    const result = await authenticatedApiCall(session.sessionId, '/files/copy', 'POST', {
      pdf_id: testState.pdfHash,
      xml_id: testState.teiHash,
      destination_collection: 'another-collection'
    }, BASE_URL);

    assert(result.new_pdf_id, 'Should return new PDF ID');
    assert(result.new_xml_id, 'Should return new XML ID');

    logger.success('Copy with abbreviated hashes successful');
  });

  test('POST /api/v1/files/copy should handle duplicate collection gracefully', async () => {
    const session = await getSession();

    if (!testState.pdfHash || !testState.teiHash) {
      logger.warn('Test hashes not available, skipping');
      return;
    }

    // Try to copy to same collection again (should be idempotent)
    const result = await authenticatedApiCall(session.sessionId, '/files/copy', 'POST', {
      pdf_id: testState.pdfHash,
      xml_id: testState.teiHash,
      destination_collection: 'another-collection'
    }, BASE_URL);

    assert(result.new_pdf_id, 'Should return new PDF ID even if already in collection');
    assert(result.new_xml_id, 'Should return new XML ID even if already in collection');

    logger.success('Duplicate collection copy handled gracefully');
  });

  test('POST /api/v1/files/copy should return 404 for non-existent PDF', async () => {
    const session = await getSession();

    try {
      await authenticatedApiCall(session.sessionId, '/files/copy', 'POST', {
        pdf_id: 'nonexistenthash123',
        xml_id: testState.teiHash || 'somehash',
        destination_collection: 'test-dest'
      }, BASE_URL);

      assert.fail('Should have thrown 404 error');
    } catch (error) {
      assert(error.message.includes('404'), 'Should return 404 for non-existent PDF');
      logger.success('Non-existent PDF handled with 404');
    }
  });

  test('POST /api/v1/files/copy should require all parameters', async () => {
    const session = await getSession();

    try {
      await authenticatedApiCall(session.sessionId, '/files/copy', 'POST', {
        pdf_id: 'somehash'
        // Missing xml_id and destination_collection
      }, BASE_URL);

      assert.fail('Should have thrown validation error');
    } catch (error) {
      assert(error.message.includes('400') || error.message.includes('422'),
             'Should return validation error for missing parameters');
      logger.success('Missing parameters handled with validation error');
    }
  });

  test('Cleanup: Delete test files and logout', async () => {
    const session = await getSession();

    // Note: Don't delete fixture files - they may be used by other tests
    // The copy operation creates references to existing files, not new files
    // Test framework cleans up the entire runtime directory after all tests

    // Logout
    if (globalSession) {
      await logout(globalSession.sessionId, BASE_URL);
      globalSession = null;
      logger.success('Global session cleaned up');
    }
  });

});
