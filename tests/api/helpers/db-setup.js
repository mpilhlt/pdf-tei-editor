/**
 * Database setup helpers for E2E tests.
 *
 * Provides utilities for:
 * - Cleaning database state between tests
 * - Ensuring clean configuration
 * - Verifying database initialization
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { logger } from './test-logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '../../..');
// Use test runtime directory for ephemeral data, fixtures for initial state
const runtimeDbDir = path.join(projectRoot, 'tests/api/runtime/db');
const fixtureConfigDir = path.join(projectRoot, 'tests/api/fixtures/config');

/**
 * Clean database directory for testing.
 *
 * Removes all JSON and SQLite database files.
 * Does NOT remove the directory itself.
 *
 * @param {boolean} keepSqlite - If true, only remove JSON files
 */
export function cleanDbDirectory(keepSqlite = false) {
  if (!fs.existsSync(runtimeDbDir)) {
    logger.info('Runtime database directory does not exist, nothing to clean');
    return;
  }

  let removed = 0;

  // Remove JSON files
  const jsonFiles = fs.readdirSync(runtimeDbDir).filter(f => f.endsWith('.json'));
  for (const file of jsonFiles) {
    fs.unlinkSync(path.join(runtimeDbDir, file));
    removed++;
  }

  // Remove SQLite files if requested
  if (!keepSqlite) {
    const dbFiles = fs.readdirSync(runtimeDbDir).filter(f =>
      f.endsWith('.db') || f.endsWith('.db-shm') || f.endsWith('.db-wal')
    );
    for (const file of dbFiles) {
      fs.unlinkSync(path.join(runtimeDbDir, file));
      removed++;
    }
  }

  logger.info(`Cleaned ${removed} files from runtime database directory`);
}

/**
 * Initialize database from fixture defaults.
 *
 * Copies JSON config files from fixtures/config/ to runtime/db/.
 * SQLite databases will be created automatically by the server on first run.
 * This provides a clean starting state for each test run.
 */
export function initDbFromFixtures() {
  if (!fs.existsSync(runtimeDbDir)) {
    fs.mkdirSync(runtimeDbDir, { recursive: true });
  }

  // Copy JSON config files from fixtures/config/ to runtime/db/
  const fixtureFiles = fs.readdirSync(fixtureConfigDir).filter(f => f.endsWith('.json'));

  for (const file of fixtureFiles) {
    const src = path.join(fixtureConfigDir, file);
    const dest = path.join(runtimeDbDir, file);
    fs.copyFileSync(src, dest);
  }

  logger.info(`Copied ${fixtureFiles.length} config files to runtime/db directory`);
  logger.info('SQLite databases will be created automatically by server');
}

/**
 * Ensure database is in clean state for tests.
 *
 * This is the recommended way to prepare for tests:
 * 1. Clean existing runtime database files
 * 2. Copy fresh fixture data
 * 3. Server uses runtime directory during tests
 *
 * @param {boolean} keepSqlite - If true, keep existing SQLite databases
 */
export function resetDbToDefaults(keepSqlite = false) {
  console.log('🔄 Resetting database to defaults...');
  cleanDbDirectory(keepSqlite);
  initDbFromFixtures();
  logger.success('Database reset complete');
}

/**
 * Verify database files exist in runtime directory.
 *
 * @returns {Object} Status of each expected file
 */
export function checkDbFiles() {
  const status = {
    'config.json': fs.existsSync(path.join(runtimeDbDir, 'config.json')),
    'users.json': fs.existsSync(path.join(runtimeDbDir, 'users.json')),
    'prompt.json': fs.existsSync(path.join(runtimeDbDir, 'prompt.json')),
    'sessions.db': fs.existsSync(path.join(runtimeDbDir, 'sessions.db')),
    'locks.db': fs.existsSync(path.join(runtimeDbDir, 'locks.db'))
  };

  return status;
}

/**
 * Wait for server to be ready after database reset.
 *
 * Polls the server health endpoint until it responds.
 *
 * @param {string} baseUrl - Server base URL
 * @param {number} timeoutMs - Maximum time to wait
 * @returns {Promise<boolean>} True if server is ready
 */
export async function waitForServerReady(baseUrl = 'http://localhost:8000', timeoutMs = 10000) {
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    try {
      const response = await fetch(`${baseUrl}/docs`, { method: 'GET' });
      if (response.ok) {
        logger.success('Server is ready');
        return true;
      }
    } catch (error) {
      // Server not ready yet, continue waiting
    }

    await new Promise(resolve => setTimeout(resolve, 500));
  }

  console.warn('⚠️  Server did not become ready in time');
  return false;
}

/**
 * Example usage in tests:
 *
 * import { resetDbToDefaults, waitForServerReady } from './helpers/db-setup.js';
 *
 * describe('My Test Suite', () => {
 *   before(async () => {
 *     // Clean state before all tests
 *     resetDbToDefaults();
 *
 *     // Wait for server to restart/reload
 *     await waitForServerReady();
 *   });
 *
 *   // Your tests here...
 * });
 */
