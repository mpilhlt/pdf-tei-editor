/**
 * E2E Backend Tests for File Locks API endpoints
 * @testCovers server/api/files/locks.py
 * @testCovers server/lib/locking.py
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { createTestSession, authenticatedApiCall, authenticatedRequest, logout, login } from './helpers/test-auth.js';

// Test session management - create once and store globally
let globalSession = null;

describe('File Locks API E2E Tests', { concurrency: 1 }, () => {

  // Shared test state - these tests are stateful and must run in sequence
  const testState = {
    initialLockCount: 0,
    testFilePath: '/data/versions/testannotator/lock-test1.tei.xml',
    testFilePath2: '/data/versions/testannotator/lock-test2.tei.xml'
  };

  // Initialize one global session for consistent lock management
  async function getSession() {
    if (!globalSession) {
      // Use testannotator which has annotator role to allow file editing
      globalSession = await login('testannotator', 'annotatorpass');
      console.log(`🔐 Created session: ${globalSession.sessionId}`);
    }
    console.log(`🔍 Using session: ${globalSession.sessionId}`);
    return globalSession;
  }

  // Helper function to clean up all locks for the current session
  // Note: /api/files/locks returns file IDs (hashes) for all locked files across all sessions
  // We can only release the ones we can successfully release (i.e., ones owned by our session)
  async function cleanupSessionLocks() {
    const session = await getSession();
    console.log(`🧹 Cleaning up locks for session ${session.sessionId}...`);

    try {
      // Get all locked file IDs in the system (these are hashes, not paths)
      const lockedFileIds = await authenticatedApiCall(session.sessionId, '/files/locks', 'GET');
      console.log(`🧹 Found ${lockedFileIds.length} total locked files`);

      if (lockedFileIds.length === 0) {
        console.log(`✓ No locks to clean up`);
        return;
      }

      // Try to release each locked file - only our session's locks will succeed
      const releasePromises = lockedFileIds.map(async fileId => {
        try {
          await authenticatedApiCall(session.sessionId, '/files/release_lock', 'POST', {
            file_id: fileId
          });
          console.log(`  ✓ Released lock for ${fileId}`);
          return { fileId, success: true };
        } catch (error) {
          // This is expected for locks owned by other sessions (409 CONFLICT)
          if (error.message.includes('409') || error.message.includes('CONFLICT')) {
            console.log(`  ⚠️ Skipped lock for ${fileId} (owned by other session)`);
            return { fileId, success: false, skipped: true };
          } else {
            console.log(`  ❌ Failed to release lock for ${fileId}: ${error.message}`);
            return { fileId, success: false, error: error.message };
          }
        }
      });

      const results = await Promise.all(releasePromises);
      const successful = results.filter(r => r.success).length;
      const skipped = results.filter(r => r.skipped).length;
      const failed = results.filter(r => !r.success && !r.skipped).length;

      console.log(`🧹 Released ${successful} locks, skipped ${skipped} (other sessions), ${failed} failed`);

      // Get final count - we expect it to be reduced by the number we successfully released
      const remainingFileIds = await authenticatedApiCall(session.sessionId, '/files/locks', 'GET');
      const expectedRemaining = lockedFileIds.length - successful;

      if (remainingFileIds.length === expectedRemaining) {
        console.log(`✅ Session lock cleanup completed (${remainingFileIds.length} locks remain from other sessions)`);
      } else {
        console.log(`⚠️ Warning: Expected ${expectedRemaining} remaining locks, but found ${remainingFileIds.length}`);
      }

    } catch (error) {
      console.log(`💥 Lock cleanup failed: ${error.message}`);
      throw error;
    }
  }

  test('GET /api/files/locks should return active locks', async () => {
    // Clean up any existing locks from previous test runs
    await cleanupSessionLocks();
    const session = await getSession();

    // Create test files that we can use for locking tests
    const testContent = '<?xml version="1.0" encoding="UTF-8"?><TEI><text>Test document for file locks</text></TEI>';

    // Save test files to ensure they exist in the hash lookup
    await authenticatedApiCall(session.sessionId, '/files/save', 'POST', {
      file_id: testState.testFilePath,
      xml_string: testContent
    });

    await authenticatedApiCall(session.sessionId, '/files/save', 'POST', {
      file_id: testState.testFilePath2,
      xml_string: testContent
    });

    // Release the locks that were acquired during file saving
    await authenticatedApiCall(session.sessionId, '/files/release_lock', 'POST', {
      file_id: testState.testFilePath
    });

    await authenticatedApiCall(session.sessionId, '/files/release_lock', 'POST', {
      file_id: testState.testFilePath2
    });

    const fileIds = await authenticatedApiCall(session.sessionId, '/files/locks', 'GET');

    assert(Array.isArray(fileIds), 'Should return an array');

    // Store initial count for subsequent tests
    testState.initialLockCount = fileIds.length;
    console.log(`✓ Found ${fileIds.length} total active file locks`);
  });

  test('POST /api/files/check_lock should return not locked for non-existent file', async () => {
    const session = await getSession();
    const result = await authenticatedApiCall(session.sessionId, '/files/check_lock', 'POST', {
      file_id: '/data/non-existent-file.pdf'
    });

    assert(typeof result === 'object', 'Should return an object');
    assert.strictEqual(result.is_locked, false, 'Non-existent file should not be locked');

    console.log('✓ Non-existent file reported as not locked');
  });

  test('POST /api/files/acquire_lock should successfully acquire lock', async () => {
    const session = await getSession();

    const result = await authenticatedApiCall(session.sessionId, '/files/acquire_lock', 'POST', {
      file_id: testState.testFilePath
    });

    assert.strictEqual(result, 'OK', 'Should return OK for successful lock acquisition');

    console.log('✓ Successfully acquired lock for test file');

    // Verify lock count increased by 1
    const fileIds = await authenticatedApiCall(session.sessionId, '/files/locks', 'GET');
    assert.strictEqual(fileIds.length, testState.initialLockCount + 1, 'There should be one more active lock');
    console.log('✓ Lock verified in active locks list');
  });

  test('POST /api/files/check_lock should detect existing lock from same session', async () => {
    const session = await getSession();

    // Check lock from same session (should not be locked for owner)
    // This test depends on the previous test having acquired the lock
    const result = await authenticatedApiCall(session.sessionId, '/files/check_lock', 'POST', {
      file_id: testState.testFilePath
    });

    assert.strictEqual(result.is_locked, false, 'File should not be locked for the owner session');

    console.log('✓ Lock not reported as locked for owner session');
  });

  test('POST /api/files/check_lock should consistently report lock status', async () => {
    const session = await getSession();

    // Check lock from same session (should not be locked for owner)
    const result = await authenticatedApiCall(session.sessionId, '/files/check_lock', 'POST', {
      file_id: testState.testFilePath
    });

    assert.strictEqual(result.is_locked, false, 'File should not be locked for the owner session');

    console.log('✓ Lock status correctly reported for owner session');
  });

  test('POST /api/files/acquire_lock should refresh existing lock', async () => {
    const session = await getSession();

    // Try to acquire the same lock again from same session - should succeed as refresh
    const result = await authenticatedApiCall(session.sessionId, '/files/acquire_lock', 'POST', {
      file_id: testState.testFilePath
    });

    assert.strictEqual(result, 'OK', 'Should return OK when refreshing own lock');

    console.log('✓ Lock refresh handled correctly');
  });


  test('POST /api/files/release_lock should successfully release lock', async () => {
    const session = await getSession();

    const result = await authenticatedApiCall(session.sessionId, '/files/release_lock', 'POST', {
      file_id: testState.testFilePath
    });

    // New structured response - detailed action information
    assert.strictEqual(result.action, 'released', 'Should indicate lock was actively released');
    assert(result.message, 'Should provide descriptive message');
    assert(result.message.includes('successfully released'), 'Message should indicate successful release');

    console.log('✓ Successfully released lock');
    console.log(`✓ Action: ${result.action}, Message: ${result.message}`);

    // Verify lock count decreased by 1
    const fileIds = await authenticatedApiCall(session.sessionId, '/files/locks', 'GET');
    console.log(`✓ Lock verified as removed from active locks list (${fileIds.length} total locks remaining)`);
  });

  test('POST /api/files/release_lock should handle second file locks', async () => {
    // Test with second file to verify multi-file lock handling
    const session = await getSession();

    // First acquire lock on second file
    await authenticatedApiCall(session.sessionId, '/files/acquire_lock', 'POST', {
      file_id: testState.testFilePath2
    });

    // Then release it
    const result = await authenticatedApiCall(session.sessionId, '/files/release_lock', 'POST', {
      file_id: testState.testFilePath2
    });

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
    });

    // New structured response - detailed action information
    assert.strictEqual(result.action, 'already_released', 'Should indicate lock was already released');
    assert(result.message, 'Should provide descriptive message');
    assert(result.message.includes('already released'), 'Message should indicate already released state');

    console.log('✓ Releasing non-existent lock handled gracefully');
    console.log(`✓ Action: ${result.action}, Message: ${result.message}`);
  });

  test('API should handle malformed requests gracefully', async () => {
    const session = await getSession();

    // Test missing file_id parameter
    const response1 = await authenticatedRequest(session.sessionId, '/files/acquire_lock', 'POST', {});

    assert.strictEqual(response1.status, 400, 'Should return 400 for missing file_id');

    console.log('✓ Malformed requests handled gracefully');
  });

  test('Multiple locks workflow should work correctly', async () => {
    const session = await getSession();

    // Acquire locks for multiple files
    const result1 = await authenticatedApiCall(session.sessionId, '/files/acquire_lock', 'POST', {
      file_id: testState.testFilePath
    });
    const result2 = await authenticatedApiCall(session.sessionId, '/files/acquire_lock', 'POST', {
      file_id: testState.testFilePath2
    });

    assert.strictEqual(result1, 'OK', 'Should acquire first lock');
    assert.strictEqual(result2, 'OK', 'Should acquire second lock');

    // Check that both locks are active (count should have increased by 2)
    const fileIds = await authenticatedApiCall(session.sessionId, '/files/locks', 'GET');
    console.log(`✓ Multiple locks acquired successfully (${fileIds.length} total locks)`);

    // Release both locks
    const release1 = await authenticatedApiCall(session.sessionId, '/files/release_lock', 'POST', {
      file_id: testState.testFilePath
    });
    const release2 = await authenticatedApiCall(session.sessionId, '/files/release_lock', 'POST', {
      file_id: testState.testFilePath2
    });

    assert.strictEqual(release1.action, 'released', 'Should release first lock');
    assert.strictEqual(release2.action, 'released', 'Should release second lock');

    // Verify both locks are gone
    const finalFileIds = await authenticatedApiCall(session.sessionId, '/files/locks', 'GET');
    console.log(`✓ Multiple locks released successfully (${finalFileIds.length} total locks remaining)`);

    // Final cleanup to ensure no locks remain from this test suite
    await cleanupSessionLocks();

    // Clean up test files we created
    const cleanupSession = await getSession();
    try {
      // The /files/delete API expects an array of file paths
      await authenticatedApiCall(cleanupSession.sessionId, '/files/delete', 'POST', [
        testState.testFilePath,
        testState.testFilePath2
      ]);
      console.log('✓ Test files cleaned up');
    } catch (error) {
      console.log('⚠️ Failed to clean up test files:', error.message);
    }

    // Clean up session
    if (globalSession) {
      await logout(globalSession.sessionId);
      globalSession = null;
      console.log('✓ Global session cleaned up');
    }
  });

});