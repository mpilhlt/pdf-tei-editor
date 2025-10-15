#!/usr/bin/env node
/**
 * Check if the generated API client is outdated
 *
 * This script compares the modification time of the generated API client
 * against the FastAPI router files. If any router is newer than the client,
 * the script exits with code 1 to signal that regeneration is needed.
 *
 * Usage:
 *   node bin/check-client-outdated.js
 *   Returns 0 if client is up-to-date, 1 if outdated
 *
 * Typically used in:
 * - Pre-commit hooks to ensure client is regenerated
 * - CI/CD pipelines to verify client matches backend
 */

import { readdir, stat } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT_DIR = join(__dirname, '..');

const CLIENT_FILE = join(ROOT_DIR, 'fastapi_app/api-client-v1.js');
const ROUTERS_DIR = join(ROOT_DIR, 'fastapi_app/routers');

/**
 * Get modification time of a file
 * @param {string} filePath
 * @returns {Promise<number>} Modification time in milliseconds
 */
async function getModTime(filePath) {
  try {
    const stats = await stat(filePath);
    return stats.mtimeMs;
  } catch (error) {
    return 0;
  }
}

/**
 * Get all Python router files
 * @returns {Promise<string[]>} List of router file paths
 */
async function getRouterFiles() {
  try {
    const files = await readdir(ROUTERS_DIR);
    return files
      .filter(f => f.endsWith('.py') && f !== '__init__.py')
      .map(f => join(ROUTERS_DIR, f));
  } catch (error) {
    console.error(`Error reading routers directory: ${error.message}`);
    process.exit(1);
  }
}

/**
 * Main execution
 */
async function main() {
  // Check if client file exists
  if (!existsSync(CLIENT_FILE)) {
    console.error('❌ Generated API client not found:', CLIENT_FILE);
    console.error('   Run: npm run generate-client');
    process.exit(1);
  }

  // Get client modification time
  const clientMtime = await getModTime(CLIENT_FILE);

  // Get all router files
  const routerFiles = await getRouterFiles();

  if (routerFiles.length === 0) {
    console.error('❌ No router files found in:', ROUTERS_DIR);
    process.exit(1);
  }

  // Check if any router is newer than client
  let outdated = false;
  const outdatedRouters = [];

  for (const routerFile of routerFiles) {
    const routerMtime = await getModTime(routerFile);
    if (routerMtime > clientMtime) {
      outdated = true;
      outdatedRouters.push(routerFile);
    }
  }

  if (outdated) {
    console.error('❌ Generated API client is outdated!');
    console.error(`   Client: ${CLIENT_FILE}`);
    console.error(`   Modified: ${new Date(clientMtime).toISOString()}`);
    console.error('');
    console.error('   Outdated due to changes in:');
    outdatedRouters.forEach(file => {
      const routerMtime = getModTime(file);
      console.error(`   - ${file}`);
    });
    console.error('');
    console.error('   Run: npm run generate-client');
    process.exit(1);
  }

  console.log('✅ Generated API client is up-to-date');
  process.exit(0);
}

main();
