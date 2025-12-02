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
import { logger } from './test-logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = resolve(__dirname, '../../..');

/**
 * Execute a SQL statement on a SQLite database using Python's sqlite3 module
 * @param {string} dbPath - Path to the SQLite database file
 * @param {string} sql - SQL statement to execute
 */
function executeSql(dbPath, sql) {
  // Normalize path for cross-platform compatibility
  const normalizedPath = dbPath.replace(/\\/g, '/');
  // Escape single quotes in SQL for Python string
  const escapedSql = sql.replace(/'/g, "\\'");

  execSync(
    `uv run python -c "import sqlite3; conn = sqlite3.connect('${normalizedPath}'); conn.execute('${escapedSql}'); conn.commit(); conn.close()"`,
    {
      stdio: 'pipe',
      encoding: 'utf-8'
    }
  );
}

/**
 * Clear all locks from locks.db
 */
export function clearAllLocks() {
  const locksDbPath = resolve(PROJECT_ROOT, 'tests/api/runtime/db/locks.db');
  if (existsSync(locksDbPath)) {
    try {
      executeSql(locksDbPath, 'DELETE FROM locks WHERE 1=1');
      logger.info('Cleared all locks');
    } catch (error) {
      logger.error('Failed to clear locks:', error.message);
    }
  }
}

/**
 * Clear test files from metadata.db
 * @param {string[]} docIdPatterns - Array of SQL LIKE patterns to match doc_ids
 */
export function clearTestFiles(docIdPatterns = ['delete-test%', '%/delete-test%']) {
  const metadataDbPath = resolve(PROJECT_ROOT, 'tests/api/runtime/db/metadata.db');
  if (existsSync(metadataDbPath)) {
    try {
      const whereClause = docIdPatterns.map(pattern => `doc_id LIKE '${pattern}'`).join(' OR ');
      executeSql(metadataDbPath, `DELETE FROM files WHERE ${whereClause}`);
      logger.info('Cleared test files from database');
    } catch (error) {
      logger.error('Failed to clear test files:', error.message);
    }
  }
}

/**
 * Clear test files created in a specific test by doc_id
 * @param {string[]} docIds - Array of exact doc_id values to delete
 */
export function clearTestFilesByDocId(docIds) {
  if (!docIds || docIds.length === 0) return;

  const metadataDbPath = resolve(PROJECT_ROOT, 'tests/api/runtime/db/metadata.db');
  if (existsSync(metadataDbPath)) {
    try {
      const quotedIds = docIds.map(id => `'${id.replace(/'/g, "''")}'`).join(',');
      executeSql(metadataDbPath, `DELETE FROM files WHERE doc_id IN (${quotedIds})`);
      logger.info(`Cleared ${docIds.length} test file(s) from database`);
    } catch (error) {
      logger.error('Failed to clear test files by doc_id:', error.message);
    }
  }
}

/**
 * Complete cleanup for test suite
 * Call this before starting tests to ensure clean slate
 */
export function cleanupBeforeTests() {
  logger.info('Cleaning up before tests...');
  clearAllLocks();
  clearTestFiles();
}

/**
 * Complete cleanup after test suite
 * Call this after tests complete
 */
export function cleanupAfterTests() {
  logger.info('Cleaning up after tests...');
  clearAllLocks();
  clearTestFiles();
}
