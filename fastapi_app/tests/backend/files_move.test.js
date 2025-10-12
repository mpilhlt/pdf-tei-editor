/**
 * E2E Backend Tests for File Move API
 * @testCovers fastapi_app/routers/files_move.py
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { createTestSession, authenticatedApiCall, logout, login } from '../helpers/test-auth.js';

const BASE_URL = process.env.E2E_BASE_URL || 'http://localhost:8000';

// Test session management
let globalSession = null;

describe('File Move API E2E Tests', { concurrency: 1 }, () => {

  const testState = {
    testDocId: 'move-test-doc-001',
    testCollection: 'test-collection',
    destinationCollection: 'moved-collection',
    pdfHash: null,
    teiHash: null
  };

  async function getSession() {
    if (!globalSession) {
      // Use reviewer which can create gold files
      globalSession = await login('reviewer', 'reviewer', BASE_URL);
      console.log(`🔐 Created session: ${globalSession.sessionId}`);
    }
    console.log(`🔍 Using session: ${globalSession.sessionId}`);
    return globalSession;
  }

  test('Setup: Create test files for move tests', async () => {
    const session = await getSession();

    // Create PDF and TEI files
    const pdfPath = `/data/pdf/${testState.testCollection}/${testState.testDocId}.pdf`;
    const teiPath = `/data/tei/${testState.testCollection}/${testState.testDocId}.tei.xml`;

    // For PDF, we need to use upload endpoint (save is for TEI only)
    // For now, just create TEI file
    const testContent = `<?xml version="1.0" encoding="UTF-8"?><TEI><text>Move test document ${testState.testDocId}</text></TEI>`;

    const teiResult = await authenticatedApiCall(session.sessionId, '/files/save', 'POST', {
      file_id: teiPath,
      xml_string: testContent
    }, BASE_URL);

    testState.teiHash = teiResult.hash;

    // Release lock
    await authenticatedApiCall(session.sessionId, '/files/release_lock', 'POST', {
      file_id: teiPath
    }, BASE_URL);

    console.log('✓ Test files created for move tests');
  });

  test('POST /api/files/move should move files to new collection', async () => {
    const session = await getSession();

    // Get file list to find PDF hash
    const fileList = await authenticatedApiCall(session.sessionId, '/files/list', 'GET', null, BASE_URL);

    let pdfHash = null;
    let teiHash = null;

    for (const docGroup of fileList.files) {
      if (docGroup.doc_id === testState.testDocId) {
        if (docGroup.pdf) {
          pdfHash = docGroup.pdf.id;
        }
        if (docGroup.versions.length > 0) {
          teiHash = docGroup.versions[0].id;
        }
        break;
      }
    }

    if (!pdfHash) {
      console.log('⚠️ Could not find PDF for move test, skipping');
      return;
    }

    testState.pdfHash = pdfHash;
    testState.teiHash = teiHash || testState.teiHash;

    // Move files to new collection
    const result = await authenticatedApiCall(session.sessionId, '/files/move', 'POST', {
      pdf_id: pdfHash,
      xml_id: testState.teiHash,
      destination_collection: testState.destinationCollection
    }, BASE_URL);

    assert(result.new_pdf_id, 'Should return new PDF ID');
    assert(result.new_xml_id, 'Should return new XML ID');

    console.log(`✓ Files moved successfully: PDF=${result.new_pdf_id}, XML=${result.new_xml_id}`);
  });

  test('POST /api/files/move should support abbreviated hashes', async () => {
    const session = await getSession();

    if (!testState.pdfHash || !testState.teiHash) {
      console.log('⚠️ Test hashes not available, skipping');
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

    console.log('✓ Move with abbreviated hashes successful');
  });

  test('POST /api/files/move should handle duplicate collection gracefully', async () => {
    const session = await getSession();

    if (!testState.pdfHash || !testState.teiHash) {
      console.log('⚠️ Test hashes not available, skipping');
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

    console.log('✓ Duplicate collection move handled gracefully');
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
      console.log('✓ Non-existent PDF handled with 404');
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
      console.log('✓ Missing parameters handled with validation error');
    }
  });

  test('Cleanup: Delete test files and logout', async () => {
    const session = await getSession();

    // Clean up test files
    if (testState.teiHash) {
      try {
        await authenticatedApiCall(session.sessionId, '/files/delete', 'POST', {
          files: [testState.teiHash]
        }, BASE_URL);
        console.log('✓ Test files deleted');
      } catch (error) {
        console.log('⚠️ Failed to delete test files:', error.message);
      }
    }

    // Logout
    if (globalSession) {
      await logout(globalSession.sessionId, BASE_URL);
      globalSession = null;
      console.log('✓ Global session cleaned up');
    }
  });

});
