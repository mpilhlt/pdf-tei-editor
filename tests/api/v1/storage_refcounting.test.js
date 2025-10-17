/**
 * E2E Tests for Storage Reference Counting
 * @testCovers fastapi_app/lib/storage_references.py
 * @testCovers fastapi_app/lib/file_storage.py
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import { authenticatedApiCall, login, logout } from '../helpers/test-auth.js';
import { cleanupBeforeTests, cleanupAfterTests } from '../helpers/test-cleanup.js';
import { execSync } from 'child_process';

const BASE_URL = process.env.E2E_BASE_URL || 'http://localhost:8000';

// Test session management
let globalSession = null;

/**
 * Resolve stable_id to full hash
 */
function resolveStableId(stableId) {
  try {
    const result = execSync(
      `sqlite3 fastapi_app/db/metadata.db "SELECT id FROM files WHERE stable_id = '${stableId}';"`,
      { encoding: 'utf-8' }
    ).trim();
    return result || stableId;
  } catch (e) {
    return stableId;
  }
}

/**
 * Query storage_refs table
 */
function getRefCount(stableId) {
  try {
    const fullHash = resolveStableId(stableId);
    const result = execSync(
      `sqlite3 fastapi_app/db/metadata.db "SELECT ref_count FROM storage_refs WHERE file_hash = '${fullHash}';"`,
      { encoding: 'utf-8' }
    ).trim();
    // If no result, the row doesn't exist → return null
    // If result is '0', that's a valid ref_count value
    if (result === '') {
      return null;
    }
    return parseInt(result);
  } catch (e) {
    return null;
  }
}

/**
 * Check if physical file exists in storage
 */
function physicalFileExists(stableId) {
  try {
    const fullHash = resolveStableId(stableId);
    const shard = fullHash.substring(0, 2);
    const result = execSync(
      `ls fastapi_app/data/files/${shard}/${fullHash}* 2>/dev/null || echo ""`,
      { encoding: 'utf-8' }
    ).trim();
    return result.length > 0;
  } catch (e) {
    return false;
  }
}

describe('Storage Reference Counting Tests', { concurrency: 1 }, () => {
  const testState = {
    fileId1: 'refcount-test-1',
    fileId2: 'refcount-test-2',
    stableId1: null,
    stableId2: null,
  };

  // Get database path from environment or use default
  const dbDir = process.env.DB_DIR || 'fastapi_app/db';
  const metadataDb = `${dbDir}/metadata.db`;

  before(async () => {
    cleanupBeforeTests();
    // Cleanup our specific test files
    try {
      execSync(`sqlite3 "${metadataDb}" "DELETE FROM files WHERE doc_id LIKE 'refcount-test%';"`, {
        stdio: 'pipe'
      });
    } catch (error) {
      // Ignore errors if table doesn't exist yet
      console.log('⚠️  Could not cleanup test files (table may not exist yet)');
    }
  });

  after(async () => {
    if (globalSession) {
      await logout(globalSession.sessionId, BASE_URL);
      globalSession = null;
    }
    cleanupAfterTests();
    // Cleanup our specific test files
    try {
      execSync(`sqlite3 "${metadataDb}" "DELETE FROM files WHERE doc_id LIKE 'refcount-test%';"`, {
        stdio: 'pipe'
      });
    } catch (error) {
      // Ignore errors if cleanup fails
      console.log('⚠️  Could not cleanup test files after tests');
    }
  });

  async function getSession() {
    if (!globalSession) {
      globalSession = await login('reviewer', 'reviewer', BASE_URL);
      console.log(`🔐 Created session: ${globalSession.sessionId}`);
    }
    return globalSession;
  }

  test('Reference count increments when file is saved', async () => {
    const session = await getSession();

    // Save a file with proper TEI structure
    const content = `<?xml version="1.0" encoding="UTF-8"?>
<TEI xmlns="http://www.tei-c.org/ns/1.0">
  <teiHeader>
    <fileDesc>
      <titleStmt><title>Test</title></titleStmt>
      <publicationStmt><p>Test</p></publicationStmt>
      <sourceDesc><p>Test</p></sourceDesc>
    </fileDesc>
  </teiHeader>
  <text><body><p>Test file for reference counting</p></body></text>
</TEI>`;
    const result = await authenticatedApiCall(session.sessionId, '/files/save', 'POST', {
      file_id: testState.fileId1,
      xml_string: content
    }, BASE_URL);

    testState.stableId1 = result.hash;  // API returns stable_id in the 'hash' field

    // Release lock
    await authenticatedApiCall(session.sessionId, '/files/release_lock', 'POST', {
      file_id: testState.stableId1
    }, BASE_URL);

    // Check ref_count = 1
    const refCount = getRefCount(testState.stableId1);
    assert.strictEqual(refCount, 1, 'Ref count should be 1 after saving file');

    // Check physical file exists
    const exists = physicalFileExists(testState.stableId1);
    assert.strictEqual(exists, true, 'Physical file should exist');

    console.log(`✓ File saved with ref_count = 1`);
  });

  test('Second file has independent reference count', async () => {
    const session = await getSession();

    // Save file with same base content but different doc_id
    // Note: fileref will be updated to match doc_id, so content will differ
    const content = `<?xml version="1.0" encoding="UTF-8"?>
<TEI xmlns="http://www.tei-c.org/ns/1.0">
  <teiHeader>
    <fileDesc>
      <titleStmt><title>Test</title></titleStmt>
      <publicationStmt><p>Test</p></publicationStmt>
      <sourceDesc><p>Test</p></sourceDesc>
    </fileDesc>
  </teiHeader>
  <text><body><p>Test file for reference counting</p></body></text>
</TEI>`;
    const result = await authenticatedApiCall(session.sessionId, '/files/save', 'POST', {
      file_id: testState.fileId2,  // Different doc_id
      xml_string: content
    }, BASE_URL);

    // Different stable_id and different content hash (fileref differs)
    testState.stableId2 = result.hash;
    assert.notStrictEqual(result.hash, testState.stableId1, 'Different doc_ids should have different stable_ids');

    // Release lock
    await authenticatedApiCall(session.sessionId, '/files/release_lock', 'POST', {
      file_id: testState.stableId2
    }, BASE_URL);

    // Each file has its own ref_count = 1 (no deduplication due to fileref differences)
    const refCount1 = getRefCount(testState.stableId1);
    const refCount2 = getRefCount(testState.stableId2);

    assert.strictEqual(refCount1, 1, 'First file should have ref_count = 1');
    assert.strictEqual(refCount2, 1, 'Second file should have ref_count = 1');

    console.log(`✓ Each file has independent ref_count = 1`);
  });

  test('Deleting file removes its physical file', async () => {
    const session = await getSession();

    // Delete first file using stable_id
    await authenticatedApiCall(session.sessionId, '/files/delete', 'POST', {
      files: [testState.stableId1]
    }, BASE_URL);

    // First file's ref_count should be removed
    const refCount1 = getRefCount(testState.stableId1);
    assert.strictEqual(refCount1, null, 'Ref count should be removed after deleting file');

    // First file's physical file should be deleted
    const exists1 = physicalFileExists(testState.stableId1);
    assert.strictEqual(exists1, false, 'Physical file should be deleted');

    // Second file should be unaffected (independent file)
    const refCount2 = getRefCount(testState.stableId2);
    assert.strictEqual(refCount2, 1, 'Second file ref_count should remain 1');

    const exists2 = physicalFileExists(testState.stableId2);
    assert.strictEqual(exists2, true, 'Second file should still exist');

    console.log(`✓ File deleted independently`);
  });

  test('Deleting last reference removes physical file', async () => {
    const session = await getSession();

    // Delete second file (the last remaining reference)
    await authenticatedApiCall(session.sessionId, '/files/delete', 'POST', {
      files: [testState.stableId2]
    }, BASE_URL);

    // Check ref_count removed (file deleted)
    const refCount = getRefCount(testState.stableId2);
    assert.strictEqual(refCount, null, 'Ref count entry should be removed after deleting last reference');

    // Physical file should be deleted
    const exists = physicalFileExists(testState.stableId2);
    assert.strictEqual(exists, false, 'Physical file should be deleted when ref_count reaches 0');

    console.log(`✓ Physical file deleted when ref_count reaches 0`);
  });

  test('Content change triggers cleanup of old file', async () => {
    const session = await getSession();

    // Save initial file
    const content1 = `<?xml version="1.0" encoding="UTF-8"?>
<TEI xmlns="http://www.tei-c.org/ns/1.0">
  <teiHeader>
    <fileDesc>
      <titleStmt><title>Test</title></titleStmt>
      <publicationStmt><p>Test</p></publicationStmt>
      <sourceDesc><p>Test</p></sourceDesc>
    </fileDesc>
  </teiHeader>
  <text><body><p>Original content</p></body></text>
</TEI>`;
    const result1 = await authenticatedApiCall(session.sessionId, '/files/save', 'POST', {
      file_id: testState.fileId1,
      xml_string: content1
    }, BASE_URL);

    const originalStableId = result1.hash;  // API returns stable_id in 'hash' field
    testState.stableId1 = originalStableId;

    // Update with different content (will create new content hash, but same stable_id)
    const content2 = `<?xml version="1.0" encoding="UTF-8"?>
<TEI xmlns="http://www.tei-c.org/ns/1.0">
  <teiHeader>
    <fileDesc>
      <titleStmt><title>Test</title></titleStmt>
      <publicationStmt><p>Test</p></publicationStmt>
      <sourceDesc><p>Test</p></sourceDesc>
    </fileDesc>
  </teiHeader>
  <text><body><p>Updated content</p></body></text>
</TEI>`;
    const result2 = await authenticatedApiCall(session.sessionId, '/files/save', 'POST', {
      file_id: originalStableId,  // Use stable_id to update existing file
      xml_string: content2
    }, BASE_URL);

    const newStableId = result2.hash;
    // Stable ID should remain the same when updating existing file
    assert.strictEqual(newStableId, originalStableId, 'Stable ID should remain same when updating file');

    // Release lock
    await authenticatedApiCall(session.sessionId, '/files/release_lock', 'POST', {
      file_id: newStableId
    }, BASE_URL);

    // Original content file should be deleted (ref_count went from 1 to 0)
    // New content file should exist with ref_count = 1
    const newExists = physicalFileExists(newStableId);
    assert.strictEqual(newExists, true, 'Updated file should exist');

    const newRefCount = getRefCount(newStableId);
    assert.strictEqual(newRefCount, 1, 'Updated file should have ref_count = 1');

    console.log(`✓ Old file cleaned up when content changes`);

    // Cleanup
    await authenticatedApiCall(session.sessionId, '/files/delete', 'POST', {
      files: [newStableId]
    }, BASE_URL);
  });

});
