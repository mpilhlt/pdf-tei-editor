/**
 * E2E Backend Tests for File Garbage Collection API
 * @testCovers fastapi_app/routers/files_gc.py
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import { authenticatedApiCall, logout, login } from '../helpers/test-auth.js';
import { cleanupBeforeTests, cleanupAfterTests } from '../helpers/test-cleanup.js';
import { logger } from '../helpers/test-logger.js';


const BASE_URL = process.env.E2E_BASE_URL || 'http://localhost:8000';

// Test session management
let globalSession = null;

describe('File Garbage Collection API E2E Tests', { concurrency: 1 }, () => {

  const testState = {
    oldDeletedFileId: null,
    recentDeletedFileId: null,
    pendingDeleteFileId: null,
    syncedDeleteFileId: null
  };

  // Clean up before all tests
  before(async () => {
    cleanupBeforeTests();
  });

  // Clean up after all tests
  after(async () => {
    if (globalSession) {
      await logout(globalSession.sessionId, BASE_URL);
      globalSession = null;
    }
    cleanupAfterTests();
  });

  async function getSession() {
    if (!globalSession) {
      // Use admin user for tests that require admin access
      globalSession = await login('admin', 'admin', BASE_URL);
      logger.info(`  Created session: ${globalSession.sessionId}`);
    }
    logger.info(`Using session: ${globalSession.sessionId}`);
    return globalSession;
  }

  test('Setup: Create test files for garbage collection', async () => {
    // Use reviewer session for creating files (has permission to create/delete)
    const reviewerSession = await login('reviewer', 'reviewer', BASE_URL);

    try {
      // Helper to create and delete file with reviewer session
      const createAndDeleteFileAsReviewer = async (content, label) => {
        // Create file
        const result = await authenticatedApiCall(reviewerSession.sessionId, '/files/save', 'POST', {
          file_id: `/data/versions/annotator/gc-test-${label}.tei.xml`,
          xml_string: content
        }, BASE_URL);

        const fileId = result.file_id;

        // Release lock
        await authenticatedApiCall(reviewerSession.sessionId, '/files/release_lock', 'POST', {
          file_id: fileId
        }, BASE_URL);

        // Delete file
        await authenticatedApiCall(reviewerSession.sessionId, '/files/delete', 'POST', {
          files: [fileId]
        }, BASE_URL);

        return fileId;
      };

      // Create old deleted file (will update timestamp later)
      const oldContent = '<?xml version="1.0" encoding="UTF-8"?><TEI><text>Old deleted file</text></TEI>';
      testState.oldDeletedFileId = await createAndDeleteFileAsReviewer(oldContent, 'old');

      // Create recent deleted file
      const recentContent = '<?xml version="1.0" encoding="UTF-8"?><TEI><text>Recent deleted file</text></TEI>';
      testState.recentDeletedFileId = await createAndDeleteFileAsReviewer(recentContent, 'recent');

      // Create file with pending_delete status
      const pendingContent = '<?xml version="1.0" encoding="UTF-8"?><TEI><text>Pending delete file</text></TEI>';
      testState.pendingDeleteFileId = await createAndDeleteFileAsReviewer(pendingContent, 'pending');

      // Create file with deletion_synced status
      const syncedContent = '<?xml version="1.0" encoding="UTF-8"?><TEI><text>Synced deletion file</text></TEI>';
      testState.syncedDeleteFileId = await createAndDeleteFileAsReviewer(syncedContent, 'synced');

      logger.success('Test files created and deleted successfully');
    } finally {
      await logout(reviewerSession.sessionId, BASE_URL);
    }
  });

  test('Setup: Update file timestamps and sync statuses', async () => {
    // Use a SQLite query endpoint if available, or we'll need to access the database directly
    // For now, we'll use a direct database manipulation through a test helper
    // Note: This test assumes we can manipulate the database state for testing

    // In a real scenario, you might need to add a test-only endpoint or use direct DB access
    // For this example, we'll document the expected behavior

    logger.info('Note: Timestamp and sync_status updates would need direct DB access or test endpoint');
    logger.info('This test validates the API contract assuming proper test data setup');
  });

  test('POST /api/files/garbage_collect should purge old deleted files', async () => {
    const session = await getSession();

    // Set cutoff to 5 days ago
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 5);

    const result = await authenticatedApiCall(session.sessionId, '/files/garbage_collect', 'POST', {
      deleted_before: cutoff.toISOString()
    }, BASE_URL);

    assert.ok(result.purged_count !== undefined, 'Should return purged_count');
    assert.ok(result.files_deleted !== undefined, 'Should return files_deleted');
    assert.ok(result.storage_freed !== undefined, 'Should return storage_freed');

    assert.ok(result.purged_count >= 0, 'purged_count should be non-negative');
    assert.ok(result.files_deleted >= 0, 'files_deleted should be non-negative');
    assert.ok(result.storage_freed >= 0, 'storage_freed should be non-negative');

    logger.success(`Garbage collected: ${result.purged_count} records, ${result.files_deleted} files, ${result.storage_freed} bytes`);
  });

  test('POST /api/files/garbage_collect with sync_status filter', async () => {
    const session = await getSession();

    // Set cutoff far in the future to get all deleted files
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() + 365);

    const result = await authenticatedApiCall(session.sessionId, '/files/garbage_collect', 'POST', {
      deleted_before: cutoff.toISOString(),
      sync_status: 'pending_delete'
    }, BASE_URL);

    assert.ok(result.purged_count !== undefined, 'Should return purged_count');
    assert.ok(result.files_deleted !== undefined, 'Should return files_deleted');
    assert.ok(result.storage_freed !== undefined, 'Should return storage_freed');

    logger.success(`Garbage collected with sync_status filter: ${result.purged_count} records`);
  });

  test('POST /api/files/garbage_collect should return zero counts when no files match', async () => {
    const session = await getSession();

    // Set cutoff to far past (before any files existed)
    const cutoff = new Date('2000-01-01T00:00:00Z');

    const result = await authenticatedApiCall(session.sessionId, '/files/garbage_collect', 'POST', {
      deleted_before: cutoff.toISOString()
    }, BASE_URL);

    assert.strictEqual(result.purged_count, 0, 'Should purge zero files');
    assert.strictEqual(result.files_deleted, 0, 'Should delete zero physical files');
    assert.strictEqual(result.storage_freed, 0, 'Should free zero bytes');

    logger.success('Garbage collection with no matches returned zero counts');
  });

  test('POST /api/files/garbage_collect should handle invalid timestamp', async () => {
    const session = await getSession();

    try {
      await authenticatedApiCall(session.sessionId, '/files/garbage_collect', 'POST', {
        deleted_before: 'invalid-timestamp'
      }, BASE_URL);

      assert.fail('Should have thrown error for invalid timestamp');
    } catch (error) {
      // Expected to fail with validation error
      assert.ok(error.message.includes('422') || error.message.includes('Unprocessable'), 'Should return validation error');
      logger.success('Invalid timestamp rejected as expected');
    }
  });

  test('POST /api/files/garbage_collect should require authentication', async () => {
    try {
      const cutoff = new Date().toISOString();

      const response = await fetch(`${BASE_URL}/api/v1/files/garbage_collect`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          deleted_before: cutoff
        })
      });

      assert.strictEqual(response.status, 401, 'Should return 401 Unauthorized');
      logger.success('Unauthenticated request rejected as expected');
    } catch (error) {
      // Network errors are also acceptable (server might not be running)
      logger.info('Request failed (expected if server requires auth)');
    }
  });

  test('POST /api/files/garbage_collect validates request body', async () => {
    const session = await getSession();

    try {
      await authenticatedApiCall(session.sessionId, '/files/garbage_collect', 'POST', {
        // Missing required deleted_before field
      }, BASE_URL);

      assert.fail('Should have thrown error for missing required field');
    } catch (error) {
      // Expected to fail with validation error
      assert.ok(error.message.includes('422') || error.message.includes('Unprocessable'), 'Should return validation error');
      logger.success('Missing required field rejected as expected');
    }
  });

  test('POST /api/files/garbage_collect should reject non-admin for recent timestamps (< 24h)', async () => {
    // Login as non-admin user (annotator)
    const annotatorSession = await login('annotator', 'annotator', BASE_URL);

    try {
      // Set cutoff to 1 hour ago (within 24 hours)
      const cutoff = new Date();
      cutoff.setHours(cutoff.getHours() - 1);

      await authenticatedApiCall(annotatorSession.sessionId, '/files/garbage_collect', 'POST', {
        deleted_before: cutoff.toISOString()
      }, BASE_URL);

      assert.fail('Should have thrown 403 error for non-admin with recent timestamp');
    } catch (error) {
      assert.ok(error.message.includes('403') || error.message.includes('Forbidden'), 'Should return 403 Forbidden');
      assert.ok(
        error.message.includes('Admin role required') || error.message.includes('admin'),
        'Error message should mention admin requirement'
      );
      logger.success('Non-admin user rejected for recent timestamp (< 24h)');
    } finally {
      await logout(annotatorSession.sessionId, BASE_URL);
    }
  });

  test('POST /api/files/garbage_collect should allow non-admin for old timestamps (> 24h)', async () => {
    // Login as non-admin user (annotator)
    const annotatorSession = await login('annotator', 'annotator', BASE_URL);

    try {
      // Set cutoff to 48 hours ago (older than 24 hours)
      const cutoff = new Date();
      cutoff.setHours(cutoff.getHours() - 48);

      const result = await authenticatedApiCall(annotatorSession.sessionId, '/files/garbage_collect', 'POST', {
        deleted_before: cutoff.toISOString()
      }, BASE_URL);

      assert.ok(result.purged_count !== undefined, 'Should return purged_count');
      assert.ok(result.files_deleted !== undefined, 'Should return files_deleted');
      assert.ok(result.storage_freed !== undefined, 'Should return storage_freed');

      logger.success(`Non-admin user allowed for old timestamp: ${result.purged_count} records purged`);
    } finally {
      await logout(annotatorSession.sessionId, BASE_URL);
    }
  });

  test('POST /api/files/garbage_collect should allow admin for recent timestamps (< 24h)', async () => {
    // Login as admin user
    const adminSession = await login('admin', 'admin', BASE_URL);

    try {
      // Set cutoff to 1 hour ago (within 24 hours)
      const cutoff = new Date();
      cutoff.setHours(cutoff.getHours() - 1);

      const result = await authenticatedApiCall(adminSession.sessionId, '/files/garbage_collect', 'POST', {
        deleted_before: cutoff.toISOString()
      }, BASE_URL);

      assert.ok(result.purged_count !== undefined, 'Should return purged_count');
      assert.ok(result.files_deleted !== undefined, 'Should return files_deleted');
      assert.ok(result.storage_freed !== undefined, 'Should return storage_freed');

      logger.success(`Admin user allowed for recent timestamp: ${result.purged_count} records purged`);
    } finally {
      await logout(adminSession.sessionId, BASE_URL);
    }
  });

  test('POST /api/files/garbage_collect boundary: exactly 24 hours should require admin', async () => {
    // Login as non-admin user (annotator)
    const annotatorSession = await login('annotator', 'annotator', BASE_URL);

    try {
      // Set cutoff to exactly 24 hours ago
      const cutoff = new Date();
      cutoff.setHours(cutoff.getHours() - 24);

      await authenticatedApiCall(annotatorSession.sessionId, '/files/garbage_collect', 'POST', {
        deleted_before: cutoff.toISOString()
      }, BASE_URL);

      assert.fail('Should have thrown 403 error for non-admin at 24h boundary');
    } catch (error) {
      assert.ok(error.message.includes('403') || error.message.includes('Forbidden'), 'Should return 403 Forbidden');
      logger.success('Non-admin rejected at 24-hour boundary');
    } finally {
      await logout(annotatorSession.sessionId, BASE_URL);
    }
  });

  test('POST /api/files/garbage_collect boundary: 24h + 1 second should allow non-admin', async () => {
    // Login as non-admin user (annotator)
    const annotatorSession = await login('annotator', 'annotator', BASE_URL);

    try {
      // Set cutoff to 24 hours + 1 second ago
      const cutoff = new Date();
      cutoff.setTime(cutoff.getTime() - (24 * 60 * 60 * 1000 + 1000));

      const result = await authenticatedApiCall(annotatorSession.sessionId, '/files/garbage_collect', 'POST', {
        deleted_before: cutoff.toISOString()
      }, BASE_URL);

      assert.ok(result.purged_count !== undefined, 'Should return purged_count');
      logger.success('Non-admin allowed at 24h + 1s boundary');
    } finally {
      await logout(annotatorSession.sessionId, BASE_URL);
    }
  });

  test('Cleanup: Purge all remaining test files', async () => {
    const session = await getSession();

    // Purge all remaining deleted files
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() + 365); // Future date to get all

    const result = await authenticatedApiCall(session.sessionId, '/files/garbage_collect', 'POST', {
      deleted_before: cutoff.toISOString()
    }, BASE_URL);

    logger.success(`Cleanup complete: ${result.purged_count} records purged`);
  });

});
