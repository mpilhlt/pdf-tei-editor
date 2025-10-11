/**
 * Database setup helpers for E2E tests.
 *
 * Provides utilities for:
 * - Cleaning database state between tests
 * - Ensuring clean configuration
 * - Verifying database initialization
 */

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '../../..');
const dbDir = path.join(projectRoot, 'fastapi_app/db');
const configDir = path.join(projectRoot, 'fastapi_app/config');

/**
 * Clean database directory for testing.
 *
 * Removes all JSON and SQLite database files.
 * Does NOT remove the directory itself.
 *
 * @param {boolean} keepSqlite - If true, only remove JSON files
 */
export function cleanDbDirectory(keepSqlite = false) {
  if (!fs.existsSync(dbDir)) {
    console.log('📁 Database directory does not exist, nothing to clean');
    return;
  }

  let removed = 0;

  // Remove JSON files
  const jsonFiles = fs.readdirSync(dbDir).filter(f => f.endsWith('.json'));
  for (const file of jsonFiles) {
    fs.unlinkSync(path.join(dbDir, file));
    removed++;
  }

  // Remove SQLite files if requested
  if (!keepSqlite) {
    const dbFiles = fs.readdirSync(dbDir).filter(f =>
      f.endsWith('.db') || f.endsWith('.db-shm') || f.endsWith('.db-wal')
    );
    for (const file of dbFiles) {
      fs.unlinkSync(path.join(dbDir, file));
      removed++;
    }
  }

  console.log(`🧹 Cleaned ${removed} files from database directory`);
}

/**
 * Initialize database from config defaults.
 *
 * Copies all JSON files from config/ to db/.
 * Server will create SQLite databases on startup.
 */
export function initDbFromConfig() {
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  const configFiles = fs.readdirSync(configDir).filter(f => f.endsWith('.json'));

  for (const file of configFiles) {
    const src = path.join(configDir, file);
    const dest = path.join(dbDir, file);
    fs.copyFileSync(src, dest);
  }

  console.log(`📋 Copied ${configFiles.length} config files to database directory`);
}

/**
 * Ensure database is in clean state for tests.
 *
 * This is the recommended way to prepare for tests:
 * 1. Clean existing database files
 * 2. Copy fresh config defaults
 * 3. Let server create SQLite databases on demand
 *
 * @param {boolean} keepSqlite - If true, keep existing SQLite databases
 */
export function resetDbToDefaults(keepSqlite = false) {
  console.log('🔄 Resetting database to defaults...');
  cleanDbDirectory(keepSqlite);
  initDbFromConfig();
  console.log('✅ Database reset complete');
}

/**
 * Verify database files exist.
 *
 * @returns {Object} Status of each expected file
 */
export function checkDbFiles() {
  const status = {
    'config.json': fs.existsSync(path.join(dbDir, 'config.json')),
    'users.json': fs.existsSync(path.join(dbDir, 'users.json')),
    'prompt.json': fs.existsSync(path.join(dbDir, 'prompt.json')),
    'sessions.db': fs.existsSync(path.join(dbDir, 'sessions.db')),
    'locks.db': fs.existsSync(path.join(dbDir, 'locks.db'))
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
        console.log('✅ Server is ready');
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
