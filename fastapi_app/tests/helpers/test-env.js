/**
 * Test Environment Configuration Helper
 *
 * Provides utilities for creating test-specific .env files for sync tests.
 */

import { writeFileSync } from 'fs';

/**
 * Create a test .env file with WebDAV configuration
 * @param {object} webdavConfig - WebDAV configuration
 * @param {string} webdavConfig.baseUrl - WebDAV server URL
 * @param {string} webdavConfig.username - WebDAV username
 * @param {string} webdavConfig.password - WebDAV password
 * @param {string} webdavConfig.remoteRoot - Remote root path
 * @param {string} envPath - Path to .env file (default: .env.test)
 * @returns {string} Path to created env file
 */
function createTestEnvFile(webdavConfig, envPath = '.env.test') {
  const envContent = `# Test Environment Configuration (Auto-generated for sync tests)
# To use: FASTAPI_ENV_FILE=${envPath} npm run dev:fastapi

# Server
HOST=127.0.0.1
PORT=8000

# Paths
DATA_ROOT=fastapi_app/data
DB_DIR=fastapi_app/db

# WebDAV Configuration for Sync Tests
WEBDAV_ENABLED=true
WEBDAV_BASE_URL=${webdavConfig.baseUrl}
WEBDAV_USERNAME=${webdavConfig.username}
WEBDAV_PASSWORD=${webdavConfig.password}
WEBDAV_REMOTE_ROOT=${webdavConfig.remoteRoot}

# Session
SESSION_TIMEOUT=3600

# Logging
LOG_LEVEL=INFO
`;

  writeFileSync(envPath, envContent);
  console.log(`✅ Created test environment file: ${envPath}`);
  console.log(`   To use: FASTAPI_ENV_FILE=${envPath} npm run dev:fastapi`);

  return envPath;
}

/**
 * Get instructions for running sync tests
 * @param {string} envPath - Path to test env file
 * @returns {string} Usage instructions
 */
function getTestInstructions(envPath = '.env.test') {
  return `
To run sync tests:

1. Start WebDAV test server (automatically handled by test suite)

2. Start FastAPI server with test configuration:
   FASTAPI_ENV_FILE=${envPath} npm run dev:fastapi

3. Run sync integration tests:
   E2E_BASE_URL=http://localhost:8000 node --test fastapi_app/tests/backend/sync.test.js

Or use the test runner (recommended):
   python bin/test-fastapi.py sync
`;
}

export {
  createTestEnvFile,
  getTestInstructions
};
