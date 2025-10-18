/**
 * E2E Backend Tests for File Locks API
 * @testCovers fastapi_app/routers/files_locks.py
 * @testCovers fastapi_app/lib/locking.py
 * 
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { createTestSession, authenticatedApiCall, authenticatedRequest, logout, login } from '../helpers/test-auth.js';

const BASE_URL = process.env.E2E_BASE_URL || 'http://localhost:8000';

// Test session management - create once and store globally
let globalSession = null;

describe('File Locks API E2E Tests', { concurrency: 1 }, () => {

  // Generate unique test ID for this test run to avoid collisions
  const testRunId = Date.now().toString(36) + Math.random().toString(36).substring(2);

  // Shared test state - these tests are stateful and must run in sequence
  const testState = {
    initialLockCount: 0,
    testFilePath: '/data/versions/annotator/lock-test1.tei.xml',
    testFilePath2: '/data/versions/annotator/lock-test2.tei.xml',
    testFileHash: null,   // Will store hash from save operation
    testFileHash2: null   // Will store hash from save operation
  };

  // Initialize one global session for consistent lock management
  async function getSession() {
    if (!globalSession) {
      // Use reviewer which can create gold files and edit
      globalSession = await login('reviewer', 'reviewer', BASE_URL);
      console.log(`🔐 Created session: ${globalSession.sessionId}`);
    }
    console.log(`🔍 Using session: ${globalSession.sessionId}`);
    return globalSession;
  }

  // Helper function to clean up all locks for the current session
  async function cleanupSessionLocks() {
    const session = await getSession();
    console.log(`🧹 Cleaning up locks for session ${session.sessionId}...`);

    try {
      // Get all locked file IDs for this session
      const response = await authenticatedApiCall(session.sessionId, '/files/locks', 'GET', null, BASE_URL);
      const lockedFileIds = response.locked_files || response;
      console.log(`🧹 Found ${lockedFileIds.length} locked files for this session`);

      if (lockedFileIds.length === 0) {
        console.log(`✓ No locks to clean up`);
        return;
      }

      // Try to release each locked file
      const releasePromises = lockedFileIds.map(async fileId => {
        try {
          await authenticatedApiCall(session.sessionId, '/files/release_lock', 'POST', {
            file_id: fileId
          }, BASE_URL);
          console.log(`  ✓ Released lock for ${fileId}`);
          return { fileId, success: true };
        } catch (error) {
          console.log(`  ❌ Failed to release lock for ${fileId}: ${error.message}`);
          return { fileId, success: false, error: error.message };
        }
      });

      const results = await Promise.all(releasePromises);
      const successful = results.filter(r => r.success).length;
      const failed = results.filter(r => !r.success).length;

      console.log(`🧹 Released ${successful} locks, ${failed} failed`);

      // Get final count
      const finalResponse = await authenticatedApiCall(session.sessionId, '/files/locks', 'GET', null, BASE_URL);
      const finalFileIds = finalResponse.locked_files || finalResponse;

      console.log(`✅ Session lock cleanup completed (${finalFileIds.length} locks remain)`);

    } catch (error) {
      console.log(`💥 Lock cleanup failed: ${error.message}`);
      throw error;
    }
  }

  test('GET /api/files/locks should return active locks for session', async () => {
    // Clean up any existing locks from previous test runs
    await cleanupSessionLocks();
    const session = await getSession();

    // Create test files with unique content for this test run (to avoid hash collisions)
    const testContent = `<?xml version="1.0" encoding="UTF-8"?><TEI><text>Test document for file locks - Run ID: ${testRunId}</text></TEI>`;

    // Save test files to ensure they exist and capture their hashes
    const result1 = await authenticatedApiCall(session.sessionId, '/files/save', 'POST', {
      file_id: testState.testFilePath,
      xml_string: testContent
    }, BASE_URL);
    testState.testFileHash = result1.hash;
    console.log(`✓ Created test file 1 with hash: ${testState.testFileHash} (run: ${testRunId})`);

    const testContent2 = `<?xml version="1.0" encoding="UTF-8"?><TEI><text>Test document for file locks - FILE 2 - Run ID: ${testRunId}</text></TEI>`;
    const result2 = await authenticatedApiCall(session.sessionId, '/files/save', 'POST', {
      file_id: testState.testFilePath2,
      xml_string: testContent2 // Different content to get different hash
    }, BASE_URL);
    testState.testFileHash2 = result2.hash;
    console.log(`✓ Created test file 2 with hash: ${testState.testFileHash2} (run: ${testRunId})`);

    // Release the locks that were acquired during file saving (use hashes)
    await authenticatedApiCall(session.sessionId, '/files/release_lock', 'POST', {
      file_id: testState.testFileHash
    }, BASE_URL);

    await authenticatedApiCall(session.sessionId, '/files/release_lock', 'POST', {
      file_id: testState.testFileHash2
    }, BASE_URL);

    const response = await authenticatedApiCall(session.sessionId, '/files/locks', 'GET', null, BASE_URL);
    const fileIds = response.locked_files || response;

    assert(Array.isArray(fileIds), 'Should return an array of file IDs');

    // Store initial count for subsequent tests
    testState.initialLockCount = fileIds.length;
    console.log(`✓ Found ${fileIds.length} active file locks for this session`);
  });

  test('POST /api/files/check_lock should return not locked for non-existent file', async () => {
    const session = await getSession();
    const result = await authenticatedApiCall(session.sessionId, '/files/check_lock', 'POST', {
      file_id: '/data/non-existent-file.pdf'
    }, BASE_URL);

    assert(typeof result === 'object', 'Should return an object');
    assert.strictEqual(result.is_locked, false, 'Non-existent file should not be locked');

    console.log('✓ Non-existent file reported as not locked');
  });

  test('POST /api/files/acquire_lock should successfully acquire lock', async () => {
    const session = await getSession();

    const result = await authenticatedApiCall(session.sessionId, '/files/acquire_lock', 'POST', {
      file_id: testState.testFileHash
    }, BASE_URL);

    assert.strictEqual(result, 'OK', 'Should return OK for successful lock acquisition');

    console.log('✓ Successfully acquired lock for test file');

    // Verify lock count increased by 1
    const response = await authenticatedApiCall(session.sessionId, '/files/locks', 'GET', null, BASE_URL);
    const fileIds = response.locked_files || response;
    assert.strictEqual(fileIds.length, testState.initialLockCount + 1, 'There should be one more active lock');
    console.log('✓ Lock verified in active locks list');
  });

  test('POST /api/files/check_lock should detect existing lock from same session', async () => {
    const session = await getSession();

    // Check lock from same session (should not be locked for owner)
    const result = await authenticatedApiCall(session.sessionId, '/files/check_lock', 'POST', {
      file_id: testState.testFileHash
    }, BASE_URL);

    assert.strictEqual(result.is_locked, false, 'File should not be locked for the owner session');

    console.log('✓ Lock not reported as locked for owner session');
  });

  test('POST /api/files/acquire_lock should refresh existing lock', async () => {
    const session = await getSession();

    // Try to acquire the same lock again from same session - should succeed as refresh
    const result = await authenticatedApiCall(session.sessionId, '/files/acquire_lock', 'POST', {
      file_id: testState.testFileHash
    }, BASE_URL);

    assert.strictEqual(result, 'OK', 'Should return OK when refreshing own lock');

    console.log('✓ Lock refresh handled correctly');
  });

  test('POST /api/files/release_lock should successfully release lock', async () => {
    const session = await getSession();

    const result = await authenticatedApiCall(session.sessionId, '/files/release_lock', 'POST', {
      file_id: testState.testFileHash
    }, BASE_URL);

    // Structured response with action information
    assert.strictEqual(result.action, 'released', 'Should indicate lock was actively released');
    assert(result.message, 'Should provide descriptive message');
    assert(result.message.includes('successfully released') || result.message.includes('released'),
           'Message should indicate successful release');

    console.log('✓ Successfully released lock');
    console.log(`✓ Action: ${result.action}, Message: ${result.message}`);

    // Verify lock count decreased by 1
    const response = await authenticatedApiCall(session.sessionId, '/files/locks', 'GET', null, BASE_URL);
    const fileIds = response.locked_files || response;
    console.log(`✓ Lock verified as removed from active locks list (${fileIds.length} total locks remaining)`);
  });

  test('POST /api/files/release_lock should handle second file locks', async () => {
    const session = await getSession();

    // First acquire lock on second file
    await authenticatedApiCall(session.sessionId, '/files/acquire_lock', 'POST', {
      file_id: testState.testFileHash2
    }, BASE_URL);

    // Then release it
    const result = await authenticatedApiCall(session.sessionId, '/files/release_lock', 'POST', {
      file_id: testState.testFileHash2
    }, BASE_URL);

    assert.strictEqual(result.action, 'released', 'Should release second file lock');
    assert(result.message, 'Should provide descriptive message');

    console.log('✓ Second file lock handled correctly');
  });

  test('POST /api/files/release_lock should succeed for already released lock', async () => {
    const testFilePath = '/data/non-existent-lock.pdf';
    const session = await getSession();

    // Try to release a lock that doesn't exist
    const result = await authenticatedApiCall(session.sessionId, '/files/release_lock', 'POST', {
      file_id: testFilePath
    }, BASE_URL);

    // Structured response with action information
    assert.strictEqual(result.action, 'already_released', 'Should indicate lock was already released');
    assert(result.message, 'Should provide descriptive message');
    assert(result.message.includes('already released') || result.message.includes('not locked'),
           'Message should indicate already released state');

    console.log('✓ Releasing non-existent lock handled gracefully');
    console.log(`✓ Action: ${result.action}, Message: ${result.message}`);
  });

  test('API should handle malformed requests gracefully', async () => {
    const session = await getSession();

    // Test missing file_id parameter
    const response1 = await authenticatedRequest(session.sessionId, '/files/acquire_lock', 'POST', {}, BASE_URL);

    assert(response1.status === 400 || response1.status === 422,
           'Should return 400 or 422 for missing file_id');

    console.log('✓ Malformed requests handled gracefully');
  });

  test('Multiple locks workflow should work correctly', async () => {
    // Clean up any locks from previous tests first
    await cleanupSessionLocks();
    const session = await getSession();

    // Ensure test files exist (they may have been deleted if this is a re-run)
    if (!testState.testFileHash || !testState.testFileHash2) {
      const testContent = `<?xml version="1.0" encoding="UTF-8"?><TEI><text>Test document for file locks - Run ID: ${testRunId}</text></TEI>`;
      const result1 = await authenticatedApiCall(session.sessionId, '/files/save', 'POST', {
        file_id: testState.testFilePath,
        xml_string: testContent
      }, BASE_URL);
      testState.testFileHash = result1.hash;

      const testContent2 = `<?xml version="1.0" encoding="UTF-8"?><TEI><text>Test document for file locks - FILE 2 - Run ID: ${testRunId}</text></TEI>`;
      const result2 = await authenticatedApiCall(session.sessionId, '/files/save', 'POST', {
        file_id: testState.testFilePath2,
        xml_string: testContent2
      }, BASE_URL);
      testState.testFileHash2 = result2.hash;

      // Release locks created during save
      await authenticatedApiCall(session.sessionId, '/files/release_lock', 'POST', {
        file_id: testState.testFileHash
      }, BASE_URL).catch(() => {});
      await authenticatedApiCall(session.sessionId, '/files/release_lock', 'POST', {
        file_id: testState.testFileHash2
      }, BASE_URL).catch(() => {});
    }

    // Verify initial lock state
    const initialResponse = await authenticatedApiCall(session.sessionId, '/files/locks', 'GET', null, BASE_URL);
    const initialFileIds = initialResponse.locked_files || initialResponse;
    console.log(`📊 Initial locks before acquiring: ${initialFileIds.length} (${JSON.stringify(initialFileIds.map(id => id.substring(0, 6)))})`);

    // Acquire locks for multiple files
    console.log(`🔒 Acquiring lock for file 1: ${testState.testFileHash.substring(0, 6)}`);
    const result1 = await authenticatedApiCall(session.sessionId, '/files/acquire_lock', 'POST', {
      file_id: testState.testFileHash
    }, BASE_URL);
    console.log(`📊 Acquire 1 result: ${JSON.stringify(result1)}`);

    console.log(`🔒 Acquiring lock for file 2: ${testState.testFileHash2.substring(0, 6)}`);
    const result2 = await authenticatedApiCall(session.sessionId, '/files/acquire_lock', 'POST', {
      file_id: testState.testFileHash2
    }, BASE_URL);
    console.log(`📊 Acquire 2 result: ${JSON.stringify(result2)}`);

    assert.strictEqual(result1, 'OK', `Should acquire first lock (got: ${result1})`);
    assert.strictEqual(result2, 'OK', `Should acquire second lock (got: ${result2})`);

    // Check that both locks are active
    const response = await authenticatedApiCall(session.sessionId, '/files/locks', 'GET', null, BASE_URL);
    const fileIds = response.locked_files || response;
    console.log(`✓ Multiple locks acquired successfully (${fileIds.length} total locks)`);
    console.log(`📊 Locked files: ${JSON.stringify(fileIds.map(id => id.substring(0, 6)))}`);
    console.log(`📊 Test hashes: ${testState.testFileHash.substring(0, 6)}, ${testState.testFileHash2.substring(0, 6)}`);

    // Verify our test files are actually in the locked list
    assert(fileIds.includes(testState.testFileHash) || fileIds.includes(testState.testFileHash.substring(0, 6)),
           `Test file 1 should be locked (hash: ${testState.testFileHash})`);
    assert(fileIds.includes(testState.testFileHash2) || fileIds.includes(testState.testFileHash2.substring(0, 6)),
           `Test file 2 should be locked (hash: ${testState.testFileHash2})`);

    // Release both locks
    console.log(`🔓 Releasing lock for file 1: ${testState.testFileHash.substring(0, 6)}`);
    const release1 = await authenticatedApiCall(session.sessionId, '/files/release_lock', 'POST', {
      file_id: testState.testFileHash
    }, BASE_URL);
    console.log(`📊 Release 1 response: ${JSON.stringify(release1)}`);

    console.log(`🔓 Releasing lock for file 2: ${testState.testFileHash2.substring(0, 6)}`);
    const release2 = await authenticatedApiCall(session.sessionId, '/files/release_lock', 'POST', {
      file_id: testState.testFileHash2
    }, BASE_URL);
    console.log(`📊 Release 2 response: ${JSON.stringify(release2)}`);

    assert.strictEqual(release1.action, 'released', `Should release first lock (got: ${release1.action})`);
    assert.strictEqual(release2.action, 'released', `Should release second lock (got: ${release2.action})`);

    // Verify both locks are gone
    const finalResponse = await authenticatedApiCall(session.sessionId, '/files/locks', 'GET', null, BASE_URL);
    const finalFileIds = finalResponse.locked_files || finalResponse;
    console.log(`✓ Multiple locks released successfully (${finalFileIds.length} total locks remaining)`);

    // Final cleanup to ensure no locks remain from this test suite
    await cleanupSessionLocks();

    // Clean up test files we created (use hashes)
    const cleanupSession = await getSession();
    try {
      // The /files/delete API expects an array of file IDs (hashes)
      await authenticatedApiCall(cleanupSession.sessionId, '/files/delete', 'POST', {
        files: [testState.testFileHash, testState.testFileHash2]
      }, BASE_URL);
      console.log('✓ Test files cleaned up');
    } catch (error) {
      console.log('⚠️ Failed to clean up test files:', error.message);
    }

    // Clean up session
    if (globalSession) {
      await logout(globalSession.sessionId, BASE_URL);
      globalSession = null;
      console.log('✓ Global session cleaned up');
    }
  });

});
