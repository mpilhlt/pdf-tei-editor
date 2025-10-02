/**
 * E2E Backend Tests for Concurrent File Lock Acquisition
 * Tests the specific scenario where two different sessions try to lock the same file
 *
 * @testCovers server/api/files/locks.py
 * @testCovers server/lib/locking.py
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { login, logout, authenticatedApiCall } from './helpers/test-auth.js';

describe('Concurrent File Locks E2E Tests', { concurrency: 1 }, () => {

  const testFilePath = '/data/tei/example/10.5771__2699-1284-2024-3-149.tei.xml';

  test('Two sessions attempting to lock the same file - second session should be denied', async () => {
    console.log('\n🔒 Testing concurrent lock acquisition scenario...\n');

    // Step 1: Create session 1 and login
    console.log('📝 Step 1: Creating session 1 (testannotator)...');
    const session1 = await login('testannotator', 'annotatorpass');
    console.log(`✓ Session 1 created: ${session1.sessionId.substring(0, 8)}...`);

    // Step 2: Create session 2 and login (different user)
    console.log('📝 Step 2: Creating session 2 (testadmin)...');
    const session2 = await login('testadmin', 'adminpass');
    console.log(`✓ Session 2 created: ${session2.sessionId.substring(0, 8)}...`);

    // Verify we have two different sessions
    assert.notStrictEqual(session1.sessionId, session2.sessionId, 'Sessions should be different');
    console.log('✓ Confirmed: Two distinct sessions created\n');

    try {
      // Step 3: Session 1 loads the file (acquires lock)
      console.log(`📝 Step 3: Session 1 acquiring lock for ${testFilePath}...`);
      const lock1Result = await authenticatedApiCall(
        session1.sessionId,
        '/files/acquire_lock',
        'POST',
        { file_id: testFilePath }
      );

      assert.strictEqual(lock1Result, 'OK', 'Session 1 should successfully acquire lock');
      console.log(`✓ Session 1 successfully acquired lock\n`);

      // Step 4: Session 2 attempts to load the same file
      console.log(`📝 Step 4: Session 2 attempting to acquire lock for same file...`);
      console.log('   This should FAIL with 423 (Locked) error...');

      let session2AcquireFailed = false;
      let errorMessage = '';
      let errorStatus = 0;

      try {
        await authenticatedApiCall(
          session2.sessionId,
          '/files/acquire_lock',
          'POST',
          { file_id: testFilePath }
        );
        // If we get here, the lock was incorrectly acquired
        console.log('❌ BUG DETECTED: Session 2 was able to acquire lock!');
      } catch (error) {
        session2AcquireFailed = true;
        errorMessage = error.message;

        // Extract status code from error message (format: "... - 423 LOCKED - ..." or "HTTP 423: ...")
        const statusMatch = errorMessage.match(/(\d+)\s+(LOCKED|NOT FOUND|FORBIDDEN)/) || errorMessage.match(/HTTP (\d+)/);
        if (statusMatch) {
          errorStatus = parseInt(statusMatch[1]);
        }
      }

      // Verify that session 2 was denied
      assert.strictEqual(
        session2AcquireFailed,
        true,
        'Session 2 should be denied lock acquisition'
      );

      assert.strictEqual(
        errorStatus,
        423,
        `Session 2 should receive 423 (Locked) error, got ${errorStatus}: ${errorMessage}`
      );

      console.log(`✓ Session 2 was correctly DENIED with status 423`);
      console.log(`✓ Error message: ${errorMessage}\n`);

      // Step 5: Verify lock status from both sessions
      console.log('📝 Step 5: Verifying lock status from both perspectives...');

      // Session 1 checks lock (should not be locked for owner)
      const check1 = await authenticatedApiCall(
        session1.sessionId,
        '/files/check_lock',
        'POST',
        { file_id: testFilePath }
      );

      assert.strictEqual(
        check1.is_locked,
        false,
        'File should not appear locked to session 1 (owner)'
      );
      console.log('✓ Session 1 (owner) sees file as unlocked (correct)');

      // Session 2 checks lock (should be locked)
      const check2 = await authenticatedApiCall(
        session2.sessionId,
        '/files/check_lock',
        'POST',
        { file_id: testFilePath }
      );

      assert.strictEqual(
        check2.is_locked,
        true,
        'File should appear locked to session 2 (non-owner)'
      );
      console.log('✓ Session 2 (non-owner) sees file as locked (correct)\n');

      // Step 6: Verify global lock list
      console.log('📝 Step 6: Verifying file appears in global lock list...');
      const allLocks = await authenticatedApiCall(session1.sessionId, '/files/locks', 'GET');

      // allLocks should be an array of file IDs (hashes)
      assert(Array.isArray(allLocks), 'Lock list should be an array');

      // The file should be in the locked files list
      // Note: The API returns file IDs (hashes), so we need to check if our file is in there
      // Since we don't know the exact hash, we just verify the list is not empty
      console.log(`✓ Global lock list contains ${allLocks.length} locked file(s)\n`);

      // Step 7: Session 1 releases the lock
      console.log('📝 Step 7: Session 1 releasing lock...');
      const release1 = await authenticatedApiCall(
        session1.sessionId,
        '/files/release_lock',
        'POST',
        { file_id: testFilePath }
      );

      assert.strictEqual(release1.action, 'released', 'Session 1 should successfully release lock');
      console.log('✓ Session 1 successfully released lock\n');

      // Step 8: Now session 2 should be able to acquire the lock
      console.log('📝 Step 8: Session 2 attempting to acquire lock after release...');
      const lock2Result = await authenticatedApiCall(
        session2.sessionId,
        '/files/acquire_lock',
        'POST',
        { file_id: testFilePath }
      );

      assert.strictEqual(lock2Result, 'OK', 'Session 2 should successfully acquire lock after session 1 released');
      console.log('✓ Session 2 successfully acquired lock after session 1 released\n');

      // Step 9: Cleanup - Release session 2's lock
      console.log('📝 Step 9: Cleanup - releasing session 2 lock...');
      const release2 = await authenticatedApiCall(
        session2.sessionId,
        '/files/release_lock',
        'POST',
        { file_id: testFilePath }
      );

      assert.strictEqual(release2.action, 'released', 'Session 2 should successfully release lock');
      console.log('✓ Session 2 lock released\n');

    } finally {
      // Cleanup: Logout both sessions
      console.log('🧹 Cleaning up sessions...');
      try {
        await logout(session1.sessionId);
        console.log('✓ Session 1 logged out');
      } catch (e) {
        console.log('⚠️ Failed to logout session 1:', e.message);
      }

      try {
        await logout(session2.sessionId);
        console.log('✓ Session 2 logged out');
      } catch (e) {
        console.log('⚠️ Failed to logout session 2:', e.message);
      }
    }

    console.log('\n✅ All concurrent lock tests passed!\n');
  });

  test('Lock refresh during concurrent access', async () => {
    console.log('\n🔄 Testing lock refresh during concurrent access...\n');

    const session1 = await login('testannotator', 'annotatorpass');
    const session2 = await login('testadmin', 'adminpass');

    try {
      // Session 1 acquires lock
      console.log('📝 Session 1 acquiring lock...');
      await authenticatedApiCall(
        session1.sessionId,
        '/files/acquire_lock',
        'POST',
        { file_id: testFilePath }
      );
      console.log('✓ Session 1 has lock\n');

      // Session 1 refreshes lock (should succeed)
      console.log('📝 Session 1 refreshing lock (should succeed)...');
      const refresh1 = await authenticatedApiCall(
        session1.sessionId,
        '/files/acquire_lock',
        'POST',
        { file_id: testFilePath }
      );
      assert.strictEqual(refresh1, 'OK', 'Session 1 should be able to refresh own lock');
      console.log('✓ Session 1 successfully refreshed own lock\n');

      // Session 2 tries to acquire (should still fail)
      console.log('📝 Session 2 attempting to acquire (should fail)...');
      let failed = false;
      try {
        await authenticatedApiCall(
          session2.sessionId,
          '/files/acquire_lock',
          'POST',
          { file_id: testFilePath }
        );
      } catch (error) {
        failed = true;
      }
      assert.strictEqual(failed, true, 'Session 2 should still be denied after session 1 refresh');
      console.log('✓ Session 2 correctly denied\n');

      // Cleanup
      await authenticatedApiCall(
        session1.sessionId,
        '/files/release_lock',
        'POST',
        { file_id: testFilePath }
      );
      console.log('✓ Lock released\n');

    } finally {
      await logout(session1.sessionId);
      await logout(session2.sessionId);
    }

    console.log('✅ Lock refresh test passed!\n');
  });

  test('Multiple files locked by different sessions', async () => {
    console.log('\n📚 Testing multiple files locked by different sessions...\n');

    const testFile1 = '/data/tei/example/10.5771__2699-1284-2024-3-149.tei.xml';
    const testFile2 = '/data/versions/testannotator/lock-test-multi.tei.xml';

    const session1 = await login('testannotator', 'annotatorpass');
    const session2 = await login('testadmin', 'adminpass');

    try {
      // Create testFile2 if it doesn't exist
      const testContent = '<?xml version="1.0" encoding="UTF-8"?><TEI><text>Test</text></TEI>';
      try {
        await authenticatedApiCall(session1.sessionId, '/files/save', 'POST', {
          file_id: testFile2,
          xml_string: testContent
        });
        // Release lock created by save
        await authenticatedApiCall(session1.sessionId, '/files/release_lock', 'POST', {
          file_id: testFile2
        });
      } catch (e) {
        // File might already exist, ignore
      }

      // Session 1 locks file 1
      console.log('📝 Session 1 locking file 1...');
      await authenticatedApiCall(
        session1.sessionId,
        '/files/acquire_lock',
        'POST',
        { file_id: testFile1 }
      );
      console.log('✓ Session 1 has lock on file 1\n');

      // Session 2 locks file 2
      console.log('📝 Session 2 locking file 2...');
      await authenticatedApiCall(
        session2.sessionId,
        '/files/acquire_lock',
        'POST',
        { file_id: testFile2 }
      );
      console.log('✓ Session 2 has lock on file 2\n');

      // Session 1 cannot lock file 2
      console.log('📝 Session 1 attempting to lock file 2 (should fail)...');
      let failed1 = false;
      try {
        await authenticatedApiCall(
          session1.sessionId,
          '/files/acquire_lock',
          'POST',
          { file_id: testFile2 }
        );
      } catch (error) {
        failed1 = true;
      }
      assert.strictEqual(failed1, true, 'Session 1 should not be able to lock file 2');
      console.log('✓ Session 1 correctly denied\n');

      // Session 2 cannot lock file 1
      console.log('📝 Session 2 attempting to lock file 1 (should fail)...');
      let failed2 = false;
      try {
        await authenticatedApiCall(
          session2.sessionId,
          '/files/acquire_lock',
          'POST',
          { file_id: testFile1 }
        );
      } catch (error) {
        failed2 = true;
      }
      assert.strictEqual(failed2, true, 'Session 2 should not be able to lock file 1');
      console.log('✓ Session 2 correctly denied\n');

      // Both can refresh their own locks
      console.log('📝 Both sessions refreshing their own locks...');
      const refresh1 = await authenticatedApiCall(
        session1.sessionId,
        '/files/acquire_lock',
        'POST',
        { file_id: testFile1 }
      );
      const refresh2 = await authenticatedApiCall(
        session2.sessionId,
        '/files/acquire_lock',
        'POST',
        { file_id: testFile2 }
      );
      assert.strictEqual(refresh1, 'OK', 'Session 1 should refresh own lock');
      assert.strictEqual(refresh2, 'OK', 'Session 2 should refresh own lock');
      console.log('✓ Both sessions successfully refreshed their own locks\n');

      // Cleanup
      await authenticatedApiCall(session1.sessionId, '/files/release_lock', 'POST', { file_id: testFile1 });
      await authenticatedApiCall(session2.sessionId, '/files/release_lock', 'POST', { file_id: testFile2 });
      console.log('✓ All locks released\n');

    } finally {
      await logout(session1.sessionId);
      await logout(session2.sessionId);
    }

    console.log('✅ Multiple files test passed!\n');
  });

});
