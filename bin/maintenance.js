#!/usr/bin/env node

/**
 * Maintenance commands for the PDF-TEI Editor.
 *
 * Usage:
 *   node bin/maintenance.js [options] <command>
 *
 * Global Options:
 *   --env <path>              Path to .env file (default: ./.env)
 *   --user <username>         Username for authentication (default: from .env API_USER)
 *   --password <password>     Password for authentication (default: from .env API_PASSWORD)
 *   --base-url <url>          API base URL (default: from .env API_BASE_URL or http://localhost:8000)
 *
 * Commands:
 *   repopulate [fields...]    Re-extract fields from TEI documents
 *
 * Environment variables (from .env file):
 *   API_USER                  Username for authentication
 *   API_PASSWORD              Password for authentication
 *   API_BASE_URL              API base URL
 */

import { Command } from 'commander';
import { resolve } from 'path';
import { createHash } from 'crypto';
import dotenv from 'dotenv';

/**
 * Hash password using SHA-256 (matching frontend authentication)
 * @param {string} password - Plain text password
 * @returns {string} - Hex hash
 */
function hashPassword(password) {
  return createHash('sha256').update(password).digest('hex');
}

/**
 * Login to the API and get session ID
 * @param {string} baseUrl - API base URL
 * @param {string} username - Username
 * @param {string} password - Plain text password
 * @returns {Promise<string>} - Session ID
 */
async function login(baseUrl, username, password) {
  const passwdHash = hashPassword(password);

  const response = await fetch(`${baseUrl}/api/v1/auth/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ username, passwd_hash: passwdHash }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Login failed: ${response.status} ${error}`);
  }

  const data = await response.json();
  return data.sessionId;
}

/**
 * Get credentials from CLI options and environment
 * @param {Object} options - CLI options
 * @returns {{username: string, password: string, baseUrl: string}}
 */
function getCredentials(options) {
  // Load environment variables
  const envFile = resolve(options.env || './.env');
  const envConfig = dotenv.config({ path: envFile });

  if (envConfig.error && options.env && options.env !== './.env') {
    console.error(`Failed to load environment from ${envFile}`);
    throw envConfig.error;
  }

  // Get credentials - CLI args override env vars
  const username = options.user || process.env.API_USER;
  const password = options.password || process.env.API_PASSWORD;
  const baseUrl = options.baseUrl || process.env.API_BASE_URL || 'http://localhost:8000';

  if (!username || !password) {
    throw new Error('Username and password must be provided via --user/--password or API_USER/API_PASSWORD in .env file');
  }

  return { username, password, baseUrl };
}

/**
 * Repopulate database fields from TEI documents
 * @param {string[]} fields - Fields to repopulate (empty = all)
 * @param {Object} options - Command options
 */
async function repopulateCommand(fields, options) {
  const { username, password, baseUrl } = getCredentials(options);

  console.log(`Base URL: ${baseUrl}`);
  console.log(`Fields: ${fields.length > 0 ? fields.join(', ') : 'all'}`);

  // Login
  console.log('\nLogging in...');
  const sessionId = await login(baseUrl, username, password);
  console.log('Login successful');

  // Call repopulate endpoint
  console.log('\nRepopulating fields from TEI documents...');

  const requestBody = fields.length > 0 ? { fields } : {};

  const response = await fetch(`${baseUrl}/api/v1/files/repopulate`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Session-ID': sessionId,
    },
    body: JSON.stringify(requestBody),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Repopulate failed: ${response.status} ${error}`);
  }

  const result = await response.json();

  // Display results
  console.log('\n=== Results ===');

  for (const fieldResult of result.results) {
    console.log(`\n${fieldResult.field}:`);
    console.log(`  Total files: ${fieldResult.total}`);
    console.log(`  Updated: ${fieldResult.updated}`);
    console.log(`  Skipped (no value): ${fieldResult.skipped}`);
    console.log(`  Errors: ${fieldResult.errors}`);
  }

  console.log(`\n=== Summary ===`);
  console.log(`Success: ${result.success ? 'Yes' : 'No'}`);
  console.log(`Message: ${result.message}`);

  if (!result.success) {
    process.exit(1);
  }
}

// CLI setup
const program = new Command();

program
  .name('maintenance')
  .description('Maintenance commands for the PDF-TEI Editor')
  .version('1.0.0')
  .option('--env <path>', 'Path to .env file', './.env')
  .option('--user <username>', 'Username for authentication (default: from .env API_USER)')
  .option('--password <password>', 'Password for authentication (default: from .env API_PASSWORD)')
  .option('--base-url <url>', 'API base URL (default: from .env API_BASE_URL or http://localhost:8000)');

// Repopulate command
program
  .command('repopulate [fields...]')
  .description('Re-extract fields from TEI documents')
  .addHelpText('after', `
Available fields:
  status          Revision status from revisionDesc/change/@status
  last_revision   Timestamp from revisionDesc/change/@when

Examples:
  # Repopulate all fields
  $ npm run maintenance -- repopulate

  # Repopulate specific fields
  $ npm run maintenance -- repopulate status

  # Repopulate multiple fields
  $ npm run maintenance -- repopulate status last_revision
`)
  .action(async (fields, cmdOptions) => {
    try {
      // Merge parent options with command options
      const parentOptions = program.opts();
      await repopulateCommand(fields, { ...parentOptions, ...cmdOptions });
    } catch (error) {
      console.error('Error:', error.message);
      process.exit(1);
    }
  });

program.parse();
