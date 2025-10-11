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
 * Resolve abbreviated hash to full hash
 */
function resolveHash(abbreviatedHash) {
  try {
    const result = execSync(
      `sqlite3 fastapi_app/db/metadata.db "SELECT id FROM files WHERE id LIKE '${abbreviatedHash}%' LIMIT 1;"`,
      { encoding: 'utf-8' }
    ).trim();
    return result || abbreviatedHash;
  } catch (e) {
    return abbreviatedHash;
  }
}

/**
 * Query storage_refs table
 */
function getRefCount(abbreviatedHash) {
  try {
    const fullHash = resolveHash(abbreviatedHash);
    const result = execSync(
      `sqlite3 fastapi_app/db/metadata.db "SELECT ref_count FROM storage_refs WHERE file_hash = '${fullHash}';"`,
      { encoding: 'utf-8' }
    ).trim();
    return result ? parseInt(result) : null;
  } catch (e) {
    return null;
  }
}

/**
 * Check if physical file exists in storage
 */
function physicalFileExists(abbreviatedHash) {
  try {
    const fullHash = resolveHash(abbreviatedHash);
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
    hash1: null,
    hash2: null,
  };

  before(async () => {
    cleanupBeforeTests();
    // Cleanup our specific test files
    execSync(`sqlite3 fastapi_app/db/metadata.db "DELETE FROM files WHERE doc_id LIKE 'refcount-test%';"`, {
      stdio: 'pipe'
    });
  });

  after(async () => {
    if (globalSession) {
      await logout(globalSession.sessionId, BASE_URL);
      globalSession = null;
    }
    cleanupAfterTests();
    // Cleanup our specific test files
    execSync(`sqlite3 fastapi_app/db/metadata.db "DELETE FROM files WHERE doc_id LIKE 'refcount-test%';"`, {
      stdio: 'pipe'
    });
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

    // Save a file
    const content = '<?xml version="1.0" encoding="UTF-8"?><TEI><text>Test file for reference counting</text></TEI>';
    const result = await authenticatedApiCall(session.sessionId, '/files/save', 'POST', {
      file_id: testState.fileId1,
      xml_string: content
    }, BASE_URL);

    testState.hash1 = result.hash;

    // Release lock
    await authenticatedApiCall(session.sessionId, '/files/release_lock', 'POST', {
      file_id: testState.fileId1
    }, BASE_URL);

    // Check ref_count = 1
    const refCount = getRefCount(testState.hash1);
    assert.strictEqual(refCount, 1, 'Ref count should be 1 after saving file');

    // Check physical file exists
    const exists = physicalFileExists(testState.hash1);
    assert.strictEqual(exists, true, 'Physical file should exist');

    console.log(`✓ File saved with ref_count = 1`);
  });

  test('Duplicate content shares same file (deduplication)', async () => {
    const session = await getSession();

    // Save file with same content but different doc_id to test deduplication
    const content = '<?xml version="1.0" encoding="UTF-8"?><TEI><text>Test file for reference counting</text></TEI>';
    const result = await authenticatedApiCall(session.sessionId, '/files/save', 'POST', {
      file_id: testState.fileId2,  // Different doc_id but same content
      xml_string: content
    }, BASE_URL);

    // Should have same hash (content identical)
    assert.strictEqual(result.hash, testState.hash1, 'Same content should produce same hash');

    testState.hash2 = result.hash;

    // Release lock
    await authenticatedApiCall(session.sessionId, '/files/release_lock', 'POST', {
      file_id: testState.hash2
    }, BASE_URL);

    // Check ref_count = 2 (two database entries reference same file)
    const refCount = getRefCount(testState.hash1);
    assert.strictEqual(refCount, 2, 'Ref count should be 2 for deduplicated file');

    console.log(`✓ Deduplication working: ref_count = 2 for same content`);
  });

  test('Deleting one reference keeps physical file', async () => {
    const session = await getSession();

    // Delete first file
    await authenticatedApiCall(session.sessionId, '/files/delete', 'POST', {
      files: [testState.hash1]
    }, BASE_URL);

    // Check ref_count decremented to 1
    const refCount = getRefCount(testState.hash1);
    assert.strictEqual(refCount, 1, 'Ref count should be 1 after deleting one reference');

    // Physical file should still exist
    const exists = physicalFileExists(testState.hash1);
    assert.strictEqual(exists, true, 'Physical file should still exist (other reference remains)');

    console.log(`✓ Physical file preserved when ref_count > 0`);
  });

  test('Deleting last reference removes physical file', async () => {
    const session = await getSession();

    // Delete second file
    await authenticatedApiCall(session.sessionId, '/files/delete', 'POST', {
      files: [testState.hash1]
    }, BASE_URL);

    // Check ref_count removed (file deleted)
    const refCount = getRefCount(testState.hash1);
    assert.strictEqual(refCount, null, 'Ref count entry should be removed after deleting last reference');

    // Physical file should be deleted
    const exists = physicalFileExists(testState.hash1);
    assert.strictEqual(exists, false, 'Physical file should be deleted when ref_count reaches 0');

    console.log(`✓ Physical file deleted when ref_count reaches 0`);
  });

  test('Content change triggers cleanup of old file', async () => {
    const session = await getSession();

    // Save initial file
    const content1 = '<?xml version="1.0" encoding="UTF-8"?><TEI><text>Original content</text></TEI>';
    const result1 = await authenticatedApiCall(session.sessionId, '/files/save', 'POST', {
      file_id: testState.fileId1,
      xml_string: content1
    }, BASE_URL);

    const originalHash = result1.hash;
    testState.hash1 = originalHash;

    // Update with different content (will create new hash)
    const content2 = '<?xml version="1.0" encoding="UTF-8"?><TEI><text>Updated content</text></TEI>';
    const result2 = await authenticatedApiCall(session.sessionId, '/files/save', 'POST', {
      file_id: originalHash,  // Use hash to update existing file
      xml_string: content2
    }, BASE_URL);

    const newHash = result2.hash;
    assert.notStrictEqual(newHash, originalHash, 'Content change should produce different hash');

    // Release lock
    await authenticatedApiCall(session.sessionId, '/files/release_lock', 'POST', {
      file_id: newHash
    }, BASE_URL);

    // Original file should be deleted (ref_count went from 1 to 0)
    const originalExists = physicalFileExists(originalHash);
    assert.strictEqual(originalExists, false, 'Original file should be deleted after content change');

    // New file should exist with ref_count = 1
    const newExists = physicalFileExists(newHash);
    assert.strictEqual(newExists, true, 'New file should exist');

    const newRefCount = getRefCount(newHash);
    assert.strictEqual(newRefCount, 1, 'New file should have ref_count = 1');

    console.log(`✓ Old file cleaned up when content changes`);

    // Cleanup
    await authenticatedApiCall(session.sessionId, '/files/delete', 'POST', {
      files: [newHash]
    }, BASE_URL);
  });

});
