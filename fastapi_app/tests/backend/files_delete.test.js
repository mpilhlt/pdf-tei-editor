/**
 * E2E Backend Tests for File Delete API
 * @testCovers fastapi_app/routers/files_delete.py
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { createTestSession, authenticatedApiCall, logout, login } from '../helpers/test-auth.js';

const BASE_URL = process.env.E2E_BASE_URL || 'http://localhost:8000';

// Test session management
let globalSession = null;

describe('File Delete API E2E Tests', { concurrency: 1 }, () => {

  const testState = {
    testFilePath: '/data/versions/annotator/delete-test1.tei.xml',
    testFilePath2: '/data/versions/annotator/delete-test2.tei.xml',
    testFileHash: null,
    testFileHash2: null
  };

  async function getSession() {
    if (!globalSession) {
      // Use annotator which has write permissions
      globalSession = await login('annotator', 'annotator', BASE_URL);
      console.log(`🔐 Created session: ${globalSession.sessionId}`);
    }
    console.log(`🔍 Using session: ${globalSession.sessionId}`);
    return globalSession;
  }

  test('Setup: Create test files for deletion tests', async () => {
    const session = await getSession();

    const testContent = '<?xml version="1.0" encoding="UTF-8"?><TEI><text>Test document for delete</text></TEI>';

    // Save test files
    const result1 = await authenticatedApiCall(session.sessionId, '/files/save', 'POST', {
      file_id: testState.testFilePath,
      xml_string: testContent
    }, BASE_URL);

    const result2 = await authenticatedApiCall(session.sessionId, '/files/save', 'POST', {
      file_id: testState.testFilePath2,
      xml_string: testContent
    }, BASE_URL);

    testState.testFileHash = result1.hash;
    testState.testFileHash2 = result2.hash;

    // Release locks
    await authenticatedApiCall(session.sessionId, '/files/release_lock', 'POST', {
      file_id: testState.testFilePath
    }, BASE_URL);

    await authenticatedApiCall(session.sessionId, '/files/release_lock', 'POST', {
      file_id: testState.testFilePath2
    }, BASE_URL);

    console.log('✓ Test files created successfully');
  });

  test('POST /api/files/delete should delete single file', async () => {
    const session = await getSession();

    const result = await authenticatedApiCall(session.sessionId, '/files/delete', 'POST', {
      files: [testState.testFileHash]
    }, BASE_URL);

    assert.strictEqual(result.result, 'ok', 'Should return ok result');

    console.log('✓ Single file deleted successfully');
  });

  test('POST /api/files/delete should delete multiple files', async () => {
    const session = await getSession();

    // Create two new test files
    const testContent = '<?xml version="1.0" encoding="UTF-8"?><TEI><text>Multi-delete test</text></TEI>';

    const result1 = await authenticatedApiCall(session.sessionId, '/files/save', 'POST', {
      file_id: testState.testFilePath,
      xml_string: testContent
    }, BASE_URL);

    const result2 = await authenticatedApiCall(session.sessionId, '/files/save', 'POST', {
      file_id: testState.testFilePath2,
      xml_string: testContent
    }, BASE_URL);

    // Release locks
    await authenticatedApiCall(session.sessionId, '/files/release_lock', 'POST', {
      file_id: testState.testFilePath
    }, BASE_URL);

    await authenticatedApiCall(session.sessionId, '/files/release_lock', 'POST', {
      file_id: testState.testFilePath2
    }, BASE_URL);

    // Delete both files
    const deleteResult = await authenticatedApiCall(session.sessionId, '/files/delete', 'POST', {
      files: [result1.hash, result2.hash]
    }, BASE_URL);

    assert.strictEqual(deleteResult.result, 'ok', 'Should return ok result');

    console.log('✓ Multiple files deleted successfully');
  });

  test('POST /api/files/delete should handle empty file list gracefully', async () => {
    const session = await getSession();

    const result = await authenticatedApiCall(session.sessionId, '/files/delete', 'POST', {
      files: []
    }, BASE_URL);

    assert.strictEqual(result.result, 'ok', 'Should return ok for empty list');

    console.log('✓ Empty file list handled gracefully');
  });

  test('POST /api/files/delete should skip empty identifiers', async () => {
    const session = await getSession();

    const result = await authenticatedApiCall(session.sessionId, '/files/delete', 'POST', {
      files: ['', null, '  ']
    }, BASE_URL);

    assert.strictEqual(result.result, 'ok', 'Should return ok after skipping invalid entries');

    console.log('✓ Empty identifiers skipped gracefully');
  });

  test('POST /api/files/delete should skip non-existent files', async () => {
    const session = await getSession();

    const result = await authenticatedApiCall(session.sessionId, '/files/delete', 'POST', {
      files: ['nonexistenthash123456']
    }, BASE_URL);

    assert.strictEqual(result.result, 'ok', 'Should return ok after skipping non-existent file');

    console.log('✓ Non-existent file skipped gracefully');
  });

  test('POST /api/files/delete should support abbreviated hashes', async () => {
    const session = await getSession();

    // Create test file
    const testContent = '<?xml version="1.0" encoding="UTF-8"?><TEI><text>Abbreviated hash test</text></TEI>';

    const saveResult = await authenticatedApiCall(session.sessionId, '/files/save', 'POST', {
      file_id: testState.testFilePath,
      xml_string: testContent
    }, BASE_URL);

    // Release lock
    await authenticatedApiCall(session.sessionId, '/files/release_lock', 'POST', {
      file_id: testState.testFilePath
    }, BASE_URL);

    // Get file list to find abbreviated hash
    const fileList = await authenticatedApiCall(session.sessionId, '/files/list', 'GET', null, BASE_URL);

    let abbreviatedHash = null;
    for (const docGroup of fileList.files) {
      for (const teiFile of [...docGroup.versions, ...docGroup.gold]) {
        if (teiFile.id) {
          abbreviatedHash = teiFile.id;
          break;
        }
      }
      if (abbreviatedHash) break;
    }

    if (abbreviatedHash) {
      // Delete using abbreviated hash
      const deleteResult = await authenticatedApiCall(session.sessionId, '/files/delete', 'POST', {
        files: [abbreviatedHash]
      }, BASE_URL);

      assert.strictEqual(deleteResult.result, 'ok', 'Should delete using abbreviated hash');
      console.log(`✓ File deleted using abbreviated hash: ${abbreviatedHash}`);
    } else {
      console.log('⚠️ Could not find abbreviated hash for testing');
    }
  });

  test('Cleanup: Logout test session', async () => {
    if (globalSession) {
      await logout(globalSession.sessionId, BASE_URL);
      globalSession = null;
      console.log('✓ Global session cleaned up');
    }
  });

});
