/**
 * E2E Backend Tests for File Locks API endpoints
 * @testCovers server/api/files/locks.py
 * @testCovers server/lib/locking.py
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { createTestSession, authenticatedApiCall, authenticatedRequest, logout, login } from './helpers/test-auth.js';

// Test session management
let primarySession = null;
let secondarySession = null;

// Helper function to get or create primary test session
async function getPrimarySession() {
  if (!primarySession) {
    primarySession = await createTestSession();
  }
  return primarySession;
}

// Helper function to get or create secondary test session
// (simulates different user/session for lock conflict tests)
async function getSecondarySession() {
  if (!secondarySession) {
    // For testing purposes, we'll reuse the same test user but create a new session
    // In a real scenario, this would be a different user
    secondarySession = await login('testuser', 'testpass');
  }
  return secondarySession;
}

describe('File Locks API E2E Tests', () => {

  // Helper function to clean up all locks for the current session
  async function cleanupSessionLocks() {
    const session = await getPrimarySession();
    console.log(`🧹 Cleaning up locks for session ${session.sessionId}...`);

    try {
      // Get all active locks in the system
      const allLocks = await authenticatedApiCall(session.sessionId, '/files/locks', 'GET');

      // Filter to only locks owned by our session
      const ourLocks = Object.entries(allLocks).filter(([_, sessionId]) => sessionId === session.sessionId);

      console.log(`🧹 Found ${Object.keys(allLocks).length} total locks, ${ourLocks.length} owned by our session`);

      if (ourLocks.length === 0) {
        console.log(`✓ No locks from our session to clean up`);
        return;
      }

      // Release each lock owned by our session
      const releasePromises = ourLocks.map(async ([filePath, _]) => {
        try {
          await authenticatedApiCall(session.sessionId, '/files/release_lock', 'POST', {
            file_id: filePath
          });
          console.log(`  ✓ Released lock for ${filePath}`);
          return { filePath, success: true };
        } catch (error) {
          console.log(`  ❌ Failed to release lock for ${filePath}: ${error.message}`);
          return { filePath, success: false, error: error.message };
        }
      });

      const results = await Promise.all(releasePromises);
      const successful = results.filter(r => r.success).length;
      const failed = results.filter(r => !r.success).length;

      console.log(`🧹 Released ${successful} locks successfully, ${failed} failed`);

      // Verify all our locks are gone
      const finalLocks = await authenticatedApiCall(session.sessionId, '/files/locks', 'GET');
      const remainingOurLocks = Object.entries(finalLocks).filter(([_, sessionId]) => sessionId === session.sessionId);

      if (remainingOurLocks.length === 0) {
        console.log(`✅ All session locks cleaned up successfully`);
      } else {
        console.log(`⚠️ Warning: ${remainingOurLocks.length} locks from our session still remain:`);
        remainingOurLocks.forEach(([filePath, _]) => {
          console.log(`  - ${filePath}`);
        });
        throw new Error(`Failed to clean up ${remainingOurLocks.length} session locks`);
      }

    } catch (error) {
      console.log(`💥 Lock cleanup failed: ${error.message}`);
      throw error;
    }
  }

  test('GET /api/files/locks should return active locks', async () => {
    // Clean up any existing locks from previous test runs
    await cleanupSessionLocks();
    const session = await getPrimarySession();
    const locks = await authenticatedApiCall(session.sessionId, '/files/locks', 'GET');
    console.log("*******************************", locks)
    assert(Array.isArray(locks), 'Should return an object');

    // Count locks belonging to our session (should be 0 after cleanup)

    assert.strictEqual(locks.length, 0, 'Should have no active locks from our session after cleanup');
    console.log(`✓ Found ${locks.length} total active locks, ${ourLocks.length} from our session`);
  });

  test('POST /api/files/check_lock should return not locked for non-existent file', async () => {
    const session = await getPrimarySession();
    const result = await authenticatedApiCall(session.sessionId, '/files/check_lock', 'POST', {
      file_id: '/data/non-existent-file.pdf'
    });

    assert(typeof result === 'object', 'Should return an object');
    assert.strictEqual(result.is_locked, false, 'Non-existent file should not be locked');

    console.log('✓ Non-existent file reported as not locked');
  });

  test('POST /api/files/acquire_lock should successfully acquire lock', async () => {
    // Use actual demo file that exists - this should work with access control
    const testFilePath = '/data/tei/example/10.5771__2699-1284-2024-3-149.tei.xml';
    const session = await getPrimarySession();

    const result = await authenticatedApiCall(session.sessionId, '/files/acquire_lock', 'POST', {
      file_id: testFilePath
    });

    assert.strictEqual(result, 'OK', 'Should return OK for successful lock acquisition');

    console.log('✓ Successfully acquired lock for test file');

    // Verify lock is now active
    const locks = await authenticatedApiCall(session.sessionId, '/files/locks', 'GET');
    assert.strictEqual(ourLocks.length, 1, 'There should be one active lock from our session');
    console.log('✓ Lock verified in active locks list');
  });

  test('POST /api/files/check_lock should detect existing lock from same session', async () => {
    const testFilePath = '/data/tei/example/10.5771__2699-1284-2024-3-149.tei.xml';
    const session = await getPrimarySession();

    // Check lock from same session (should not be locked for owner)
    const result = await authenticatedApiCall(session.sessionId, '/files/check_lock', 'POST', {
      file_id: testFilePath
    });

    assert.strictEqual(result.is_locked, false, 'File should not be locked for the owner session');

    console.log('✓ Lock not reported as locked for owner session');
  });

  test('POST /api/files/check_lock should detect existing lock from different session', async () => {
    const testFilePath = '/data/tei/example/10.5771__2699-1284-2024-3-149.tei.xml';
    const secondarySession = await getSecondarySession();

    // Check lock from different session (should be locked)
    const result = await authenticatedApiCall(secondarySession.sessionId, '/files/check_lock', 'POST', {
      file_id: testFilePath
    });

    assert.strictEqual(result.is_locked, true, 'File should be locked for other sessions');

    console.log('✓ Lock correctly detected from different session');
  });

  test('POST /api/files/acquire_lock should fail for already locked file', async () => {
    const testFilePath = '/data/tei/example/10.5771__2699-1284-2024-3-149.tei.xml';
    const secondarySession = await getSecondarySession();

    // Try to acquire lock from different session - should fail with 423
    const response = await authenticatedRequest(secondarySession.sessionId, '/files/acquire_lock', 'POST', {
      file_id: testFilePath
    });

    assert.strictEqual(response.status, 423, 'Should return 423 LOCKED when file is already locked');

    const result = await response.json();
    assert(result.error && typeof result.error === 'string', 'Should return error message');

    console.log('✓ Lock acquisition correctly blocked for already locked file');
  });

  test('POST /api/files/acquire_lock should refresh own lock', async () => {
    const testFilePath = '/data/tei/example/10.5771__2699-1284-2024-3-149.tei.xml';
    const session = await getPrimarySession();

    // Try to acquire the same lock again from the same session
    const result = await authenticatedApiCall(session.sessionId, '/files/acquire_lock', 'POST', {
      file_id: testFilePath
    });

    assert.strictEqual(result, 'OK', 'Should return OK for lock refresh');

    console.log('✓ Successfully refreshed own lock');
  });

  test('POST /api/files/release_lock should successfully release lock', async () => {
    const testFilePath = '/data/tei/example/10.5771__2699-1284-2024-3-149.tei.xml';
    const session = await getPrimarySession();

    const result = await authenticatedApiCall(session.sessionId, '/files/release_lock', 'POST', {
      file_id: testFilePath
    });

    // New structured response - detailed action information
    assert.strictEqual(result.action, 'released', 'Should indicate lock was actively released');
    assert(result.message, 'Should provide descriptive message');
    assert(result.message.includes('successfully released'), 'Message should indicate successful release');

    console.log('✓ Successfully released lock');
    console.log(`✓ Action: ${result.action}, Message: ${result.message}`);

    // Verify lock is no longer active
    const locks = await authenticatedApiCall(session.sessionId, '/files/locks', 'GET');
    assert.strictEqual(locks.length, 1, 'There should be one active lock from our session');
  
    console.log('✓ Lock verified as removed from active locks list');
  });

  test('POST /api/files/release_lock should fail for non-owned lock', async () => {
    // Use a different file for this test to avoid conflicts
    const testFilePath = '/data/pdf/example/10.5771__2699-1284-2024-3-149.pdf';
    const primarySession = await getPrimarySession();
    const secondarySession = await getSecondarySession();

    // First acquire lock with primary session
    await authenticatedApiCall(primarySession.sessionId, '/files/acquire_lock', 'POST', {
      file_id: testFilePath
    });

    // Try to release lock from secondary session - should fail with 409
    const response = await authenticatedRequest(secondarySession.sessionId, '/files/release_lock', 'POST', {
      file_id: testFilePath
    });

    assert.strictEqual(response.status, 409, 'Should return 409 CONFLICT when trying to release non-owned lock');

    const result = await response.json();
    assert(result.error && typeof result.error === 'string', 'Should return error message');

    console.log('✓ Lock release correctly blocked for non-owner session');

    // Clean up: release the lock properly
    await authenticatedApiCall(primarySession.sessionId, '/files/release_lock', 'POST', {
      file_id: testFilePath
    });
  });

  test('POST /api/files/release_lock should succeed for already released lock', async () => {
    const testFilePath = '/data/non-existent-lock.pdf';
    const session = await getPrimarySession();

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
    const session = await getPrimarySession();

    // Test missing file_id parameter
    const response1 = await authenticatedRequest(session.sessionId, '/files/acquire_lock', 'POST', {});

    assert.strictEqual(response1.status, 400, 'Should return 400 for missing file_id');

    console.log('✓ Malformed requests handled gracefully');
  });

  test('Multiple locks workflow should work correctly', async () => {
    // Use actual demo files that exist
    const file1 = '/data/tei/example/10.5771__2699-1284-2024-3-149.tei.xml';
    const file2 = '/data/pdf/example/10.5771__2699-1284-2024-3-149.pdf';
    const session = await getPrimarySession();

    // Acquire locks for multiple files
    const result1 = await authenticatedApiCall(session.sessionId, '/files/acquire_lock', 'POST', {
      file_id: file1
    });
    const result2 = await authenticatedApiCall(session.sessionId, '/files/acquire_lock', 'POST', {
      file_id: file2
    });

    assert.strictEqual(result1, 'OK', 'Should acquire first lock');
    assert.strictEqual(result2, 'OK', 'Should acquire second lock');

    // Check that both locks are active
    const locks = await authenticatedApiCall(session.sessionId, '/files/locks', 'GET');
    assert(file1 in locks, 'First file should be locked');
    assert(file2 in locks, 'Second file should be locked');
    assert.strictEqual(locks[file1], session.sessionId, 'First lock should be owned by our session');
    assert.strictEqual(locks[file2], session.sessionId, 'Second lock should be owned by our session');

    console.log('✓ Multiple locks acquired successfully');

    // Release both locks
    const release1 = await authenticatedApiCall(session.sessionId, '/files/release_lock', 'POST', {
      file_id: file1
    });
    const release2 = await authenticatedApiCall(session.sessionId, '/files/release_lock', 'POST', {
      file_id: file2
    });

    assert.strictEqual(release1.action, 'released', 'Should release first lock');
    assert.strictEqual(release2.action, 'released', 'Should release second lock');

    // Verify both locks are gone
    const finalLocks = await authenticatedApiCall(session.sessionId, '/files/locks', 'GET');
    assert(!(file1 in finalLocks), 'First file should no longer be locked');
    assert(!(file2 in finalLocks), 'Second file should no longer be locked');

    console.log('✓ Multiple locks released successfully');

    // Final cleanup to ensure no locks remain from this test suite
    await cleanupSessionLocks();
  });

});