/**
 * E2E Backend Tests for File Heartbeat API
 * @testCovers fastapi_app/routers/files_heartbeat.py
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { createTestSession, authenticatedApiCall, logout, login } from '../helpers/test-auth.js';

const BASE_URL = process.env.E2E_BASE_URL || 'http://localhost:8000';

// Test session management
let globalSession = null;

describe('File Heartbeat API E2E Tests', { concurrency: 1 }, () => {

  // Generate unique test ID for this test run to avoid collisions
  const testRunId = Date.now().toString(36) + Math.random().toString(36).substring(2);

  const testState = {
    testFilePath: '/data/versions/annotator/heartbeat-test.tei.xml',
    testFileHash: null
  };

  async function getSession() {
    if (!globalSession) {
      // Use reviewer which can create all file types
      globalSession = await login('reviewer', 'reviewer', BASE_URL);
      console.log(`🔐 Created session: ${globalSession.sessionId}`);
    }
    console.log(`🔍 Using session: ${globalSession.sessionId}`);
    return globalSession;
  }

  test('Setup: Create test file for heartbeat tests', async () => {
    const session = await getSession();

    // Use unique content for this test run to avoid hash collisions
    const testContent = `<?xml version="1.0" encoding="UTF-8"?><TEI><text>Test document for heartbeat - Run ID: ${testRunId}</text></TEI>`;

    // Save test file
    const result = await authenticatedApiCall(session.sessionId, '/files/save', 'POST', {
      file_id: testState.testFilePath,
      xml_string: testContent
    }, BASE_URL);

    testState.testFileHash = result.hash;

    // The save operation acquires a lock, keep it for heartbeat tests
    console.log(`✓ Test file created with lock for heartbeat tests (hash: ${testState.testFileHash}, run: ${testRunId})`);
  });

  test('POST /api/files/heartbeat should refresh lock', async () => {
    const session = await getSession();

    // Use the hash that was captured during setup
    const result = await authenticatedApiCall(session.sessionId, '/files/heartbeat', 'POST', {
      file_path: testState.testFileHash
    }, BASE_URL);

    assert.strictEqual(result.status, 'lock_refreshed', 'Should return lock_refreshed status');
    // Note: FastAPI does not return cache_status (deprecated)

    console.log('✓ Lock refreshed successfully via heartbeat');
  });

  test('POST /api/files/heartbeat should support abbreviated hashes', async () => {
    const session = await getSession();

    // Get file list to find abbreviated hash
    const fileList = await authenticatedApiCall(session.sessionId, '/files/list', 'GET', null, BASE_URL);

    let abbreviatedHash = null;
    for (const docGroup of fileList.files) {
      for (const teiFile of [...docGroup.versions, ...docGroup.gold]) {
        if (teiFile.filename && teiFile.filename.includes('heartbeat-test')) {
          abbreviatedHash = teiFile.id;
          break;
        }
      }
      if (abbreviatedHash) break;
    }

    if (abbreviatedHash) {
      const result = await authenticatedApiCall(session.sessionId, '/files/heartbeat', 'POST', {
        file_path: abbreviatedHash
      }, BASE_URL);

      assert.strictEqual(result.status, 'lock_refreshed', 'Should refresh using abbreviated hash');
      console.log(`✓ Heartbeat successful with abbreviated hash: ${abbreviatedHash}`);
    } else {
      console.log('⚠️ Could not find abbreviated hash for testing');
    }
  });

  test('POST /api/files/heartbeat should work multiple times in sequence', async () => {
    const session = await getSession();

    // Send multiple heartbeats using hash
    for (let i = 0; i < 3; i++) {
      const result = await authenticatedApiCall(session.sessionId, '/files/heartbeat', 'POST', {
        file_path: testState.testFileHash
      }, BASE_URL);

      assert.strictEqual(result.status, 'lock_refreshed', `Heartbeat ${i + 1} should succeed`);
    }

    console.log('✓ Multiple sequential heartbeats successful');
  });

  test('POST /api/files/heartbeat should fail if lock is lost', async () => {
    const session = await getSession();

    // Release the lock using hash
    await authenticatedApiCall(session.sessionId, '/files/release_lock', 'POST', {
      file_id: testState.testFileHash
    }, BASE_URL);

    // Try to send heartbeat after lock is released
    try {
      await authenticatedApiCall(session.sessionId, '/files/heartbeat', 'POST', {
        file_path: testState.testFileHash
      }, BASE_URL);

      assert.fail('Should have thrown 409 error for lost lock');
    } catch (error) {
      assert(error.message.includes('409'), 'Should return 409 when lock is lost');
      console.log('✓ Heartbeat correctly failed after lock release');
    }
  });

  test('POST /api/files/heartbeat should fail for non-existent file', async () => {
    const session = await getSession();

    try {
      await authenticatedApiCall(session.sessionId, '/files/heartbeat', 'POST', {
        file_path: 'nonexistenthash123456'
      }, BASE_URL);

      assert.fail('Should have thrown error for non-existent file');
    } catch (error) {
      assert(error.message.includes('409') || error.message.includes('404'),
             'Should return error for non-existent file');
      console.log('✓ Heartbeat correctly failed for non-existent file');
    }
  });

  test('POST /api/files/heartbeat should require file_path parameter', async () => {
    const session = await getSession();

    try {
      await authenticatedApiCall(session.sessionId, '/files/heartbeat', 'POST', {
        // Missing file_path
      }, BASE_URL);

      assert.fail('Should have thrown validation error');
    } catch (error) {
      assert(error.message.includes('400') || error.message.includes('422'),
             'Should return validation error for missing file_path');
      console.log('✓ Missing file_path parameter handled with validation error');
    }
  });

  test('POST /api/files/heartbeat should not return cache_status', async () => {
    const session = await getSession();

    // Acquire lock first using hash
    await authenticatedApiCall(session.sessionId, '/files/acquire_lock', 'POST', {
      file_id: testState.testFileHash
    }, BASE_URL);

    const result = await authenticatedApiCall(session.sessionId, '/files/heartbeat', 'POST', {
      file_path: testState.testFileHash
    }, BASE_URL);

    assert.strictEqual(result.status, 'lock_refreshed', 'Should return lock_refreshed status');
    assert.strictEqual(result.cache_status, undefined, 'Should not return cache_status (deprecated in FastAPI)');

    console.log('✓ Response does not include deprecated cache_status field');
  });

  test('Cleanup: Delete test file and logout', async () => {
    const session = await getSession();

    // Release lock before delete using hash
    try {
      await authenticatedApiCall(session.sessionId, '/files/release_lock', 'POST', {
        file_id: testState.testFileHash
      }, BASE_URL);
    } catch (error) {
      console.log('⚠️ Lock already released or error:', error.message);
    }

    // Delete test file using hash
    if (testState.testFileHash) {
      try {
        await authenticatedApiCall(session.sessionId, '/files/delete', 'POST', {
          files: [testState.testFileHash]
        }, BASE_URL);
        console.log('✓ Test file deleted');
      } catch (error) {
        console.log('⚠️ Failed to delete test file:', error.message);
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
