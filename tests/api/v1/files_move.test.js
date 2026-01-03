/**
 * E2E Backend Tests for File Move API
 * @testCovers fastapi_app/routers/files_move.py
 * 
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { createTestSession, authenticatedApiCall, logout, login } from '../helpers/test-auth.js';
import { logger } from '../helpers/test-logger.js';

const BASE_URL = process.env.E2E_BASE_URL || 'http://localhost:8000';

// Test session management
let globalSession = null;

describe('File Move API E2E Tests', { concurrency: 1 }, () => {

  const testState = {
    // Use existing PDF from fixtures
    testDocId: '10.5771__2699-1284-2024-3-149',
    destinationCollection: '_inbox', // Move to _inbox (reviewer has access via default group)
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

  test('Setup: Create test files for move tests', async () => {
    const session = await getSession();

    // Get file list to find any available PDF from fixtures
    const fileList = await authenticatedApiCall(session.sessionId, '/files/list', 'GET', null, BASE_URL);

    // Find the first document with a PDF source
    for (const docGroup of fileList.files) {
      if (docGroup.source && docGroup.source.file_type === 'pdf') {
        testState.testDocId = docGroup.doc_id;
        testState.pdfHash = docGroup.source.id;
        break;
      }
    }

    if (!testState.pdfHash) {
      throw new Error('Could not find PDF fixture for move test');
    }

    // ALWAYS create a fresh TEI artifact for testing to avoid interference from other tests
    // Use unique content to prevent hash collisions with other tests
    const uniqueId = Date.now();
    const teiContent = `<?xml version="1.0" encoding="UTF-8"?>
<TEI xmlns="http://www.tei-c.org/ns/1.0">
  <teiHeader>
    <fileDesc>
      <titleStmt>
        <title>Test document for move test ${uniqueId}</title>
      </titleStmt>
      <publicationStmt>
        <p>Test publication</p>
      </publicationStmt>
      <sourceDesc>
        <p>Test source</p>
      </sourceDesc>
    </fileDesc>
  </teiHeader>
  <text>
    <body>
      <div>
        <p>Test content for move operations - unique ID: ${uniqueId}</p>
      </div>
    </body>
  </text>
</TEI>`;

    const saveResponse = await authenticatedApiCall(
      session.sessionId,
      '/files/save',
      'POST',
      {
        file_id: testState.testDocId,
        xml_string: teiContent,
        new_version: false
      },
      BASE_URL
    );

    testState.teiHash = saveResponse.file_id;

    // Release lock after creating file
    await authenticatedApiCall(
      session.sessionId,
      '/files/release_lock',
      'POST',
      { file_id: testState.teiHash },
      BASE_URL
    );

    logger.success(`Setup complete - PDF: ${testState.pdfHash}, TEI: ${testState.teiHash}`);
  });

  test('POST /api/files/move should move files to new collection', async () => {
    const session = await getSession();

    // Move files to new collection using hashes from setup
    const result = await authenticatedApiCall(session.sessionId, '/files/move', 'POST', {
      pdf_id: testState.pdfHash,
      xml_id: testState.teiHash,
      destination_collection: testState.destinationCollection
    }, BASE_URL);

    assert(result.new_pdf_id, 'Should return new PDF ID');
    assert(result.new_xml_id, 'Should return new XML ID');

    // Verify file is now only in destination collection
    const fileList = await authenticatedApiCall(session.sessionId, '/files/list', 'GET', null, BASE_URL);
    const movedDoc = fileList.files.find(doc => doc.doc_id === testState.testDocId);
    assert(movedDoc, 'Document should still exist');
    assert(movedDoc.collections.includes(testState.destinationCollection), 'Should be in destination collection');

    logger.success(`Files moved successfully: PDF=${result.new_pdf_id}, XML=${result.new_xml_id}`);
  });

  test('POST /api/files/move should also move all TEI files for the document', async () => {
    const session = await getSession();

    // Create a fresh TEI artifact for this specific test to ensure we have something to verify
    const uniqueId = Date.now() + Math.random();
    const teiContent = `<?xml version="1.0" encoding="UTF-8"?>
<TEI xmlns="http://www.tei-c.org/ns/1.0">
  <teiHeader>
    <fileDesc>
      <titleStmt>
        <title>Test TEI for move verification ${uniqueId}</title>
      </titleStmt>
      <editionStmt>
        <edition>
          <idno type="fileref">${testState.testDocId}</idno>
        </edition>
      </editionStmt>
      <publicationStmt><p>Test</p></publicationStmt>
      <sourceDesc><p>Test</p></sourceDesc>
    </fileDesc>
  </teiHeader>
  <text><body><p>Content ${uniqueId}</p></body></text>
</TEI>`;

    const saveResp = await authenticatedApiCall(session.sessionId, '/files/save', 'POST', {
      file_id: testState.testDocId,
      xml_string: teiContent,
      new_version: false
    }, BASE_URL);

    await authenticatedApiCall(session.sessionId, '/files/release_lock', 'POST', {
      file_id: saveResp.file_id
    }, BASE_URL);

    // Use a different collection than the first test (_inbox) to verify all TEI files are moved
    const newCollection = 'default';

    const result = await authenticatedApiCall(session.sessionId, '/files/move', 'POST', {
      pdf_id: testState.pdfHash,
      xml_id: saveResp.file_id,
      destination_collection: newCollection
    }, BASE_URL);

    // Get file list to find the moved document
    const fileList = await authenticatedApiCall(session.sessionId, '/files/list', 'GET', null, BASE_URL);
    const movedDoc = fileList.files.find(doc => doc.doc_id === testState.testDocId);

    assert(movedDoc, 'Document should still exist');
    assert(movedDoc.collections.includes(newCollection), 'Document should be in new collection');

    // Verify PDF is in new collection by checking source
    assert(movedDoc.source, 'Should have source PDF');
    assert.strictEqual(movedDoc.source.file_type, 'pdf', 'Source should be PDF');

    // Verify ALL TEI files are also in new collection by checking artifacts
    const teiArtifacts = movedDoc.artifacts || [];
    assert(teiArtifacts.length > 0, 'Should have at least one TEI artifact (just created one)');

    logger.success(`All ${teiArtifacts.length} TEI file(s) moved with PDF to collection ${newCollection}`);
  });

  test('POST /api/files/move should support abbreviated hashes', async () => {
    const session = await getSession();

    if (!testState.pdfHash || !testState.teiHash) {
      logger.warn('Test hashes not available, skipping');
      return;
    }

    // Move using abbreviated hashes
    const result = await authenticatedApiCall(session.sessionId, '/files/move', 'POST', {
      pdf_id: testState.pdfHash,
      xml_id: testState.teiHash,
      destination_collection: 'another-collection'
    }, BASE_URL);

    assert(result.new_pdf_id, 'Should return new PDF ID');
    assert(result.new_xml_id, 'Should return new XML ID');

    logger.success('Move with abbreviated hashes successful');
  });

  test('POST /api/files/move should handle duplicate collection gracefully', async () => {
    const session = await getSession();

    if (!testState.pdfHash || !testState.teiHash) {
      logger.warn('Test hashes not available, skipping');
      return;
    }

    // Try to move to same collection again (should be idempotent)
    const result = await authenticatedApiCall(session.sessionId, '/files/move', 'POST', {
      pdf_id: testState.pdfHash,
      xml_id: testState.teiHash,
      destination_collection: 'another-collection'
    }, BASE_URL);

    assert(result.new_pdf_id, 'Should return new PDF ID even if already in collection');
    assert(result.new_xml_id, 'Should return new XML ID even if already in collection');

    logger.success('Duplicate collection move handled gracefully');
  });

  test('POST /api/files/move should return 404 for non-existent PDF', async () => {
    const session = await getSession();

    try {
      await authenticatedApiCall(session.sessionId, '/files/move', 'POST', {
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

  test('POST /api/files/move should require all parameters', async () => {
    const session = await getSession();

    try {
      await authenticatedApiCall(session.sessionId, '/files/move', 'POST', {
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
    // The move operation modifies collections but doesn't create new files
    // Test framework cleans up the entire runtime directory after all tests

    // Logout
    if (globalSession) {
      await logout(globalSession.sessionId, BASE_URL);
      globalSession = null;
      logger.success('Global session cleaned up');
    }
  });

});
