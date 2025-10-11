/**
 * Test cleanup utilities
 *
 * Provides functions to clean up test data between test runs:
 * - Clear test files from database
 * - Clear locks
 * - Clear file storage
 */

import { execSync } from 'child_process';
import { existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = resolve(__dirname, '../../..');

/**
 * Clear all locks from locks.db
 */
export function clearAllLocks() {
  const locksDbPath = resolve(PROJECT_ROOT, 'fastapi_app/db/locks.db');
  if (existsSync(locksDbPath)) {
    try {
      execSync(`sqlite3 "${locksDbPath}" "DELETE FROM locks WHERE 1=1;"`, {
        stdio: 'pipe',
        encoding: 'utf-8'
      });
      console.log('🧹 Cleared all locks');
    } catch (error) {
      console.error('⚠️ Failed to clear locks:', error.message);
    }
  }
}

/**
 * Clear test files from metadata.db
 * @param {string[]} docIdPatterns - Array of SQL LIKE patterns to match doc_ids
 */
export function clearTestFiles(docIdPatterns = ['delete-test%', '%/delete-test%']) {
  const metadataDbPath = resolve(PROJECT_ROOT, 'fastapi_app/db/metadata.db');
  if (existsSync(metadataDbPath)) {
    try {
      const whereClause = docIdPatterns.map(pattern => `doc_id LIKE '${pattern}'`).join(' OR ');
      execSync(`sqlite3 "${metadataDbPath}" "DELETE FROM files WHERE ${whereClause};"`, {
        stdio: 'pipe',
        encoding: 'utf-8'
      });
      console.log('🧹 Cleared test files from database');
    } catch (error) {
      console.error('⚠️ Failed to clear test files:', error.message);
    }
  }
}

/**
 * Clear test files created in a specific test by doc_id
 * @param {string[]} docIds - Array of exact doc_id values to delete
 */
export function clearTestFilesByDocId(docIds) {
  if (!docIds || docIds.length === 0) return;

  const metadataDbPath = resolve(PROJECT_ROOT, 'fastapi_app/db/metadata.db');
  if (existsSync(metadataDbPath)) {
    try {
      const placeholders = docIds.map(() => '?').join(',');
      const quotedIds = docIds.map(id => `'${id.replace(/'/g, "''")}'`).join(',');
      execSync(`sqlite3 "${metadataDbPath}" "DELETE FROM files WHERE doc_id IN (${quotedIds});"`, {
        stdio: 'pipe',
        encoding: 'utf-8'
      });
      console.log(`🧹 Cleared ${docIds.length} test file(s) from database`);
    } catch (error) {
      console.error('⚠️ Failed to clear test files by doc_id:', error.message);
    }
  }
}

/**
 * Complete cleanup for test suite
 * Call this before starting tests to ensure clean slate
 */
export function cleanupBeforeTests() {
  console.log('🧹 Cleaning up before tests...');
  clearAllLocks();
  clearTestFiles();
}

/**
 * Complete cleanup after test suite
 * Call this after tests complete
 */
export function cleanupAfterTests() {
  console.log('🧹 Cleaning up after tests...');
  clearAllLocks();
  clearTestFiles();
}
