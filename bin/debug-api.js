#!/usr/bin/env node

/**
 * Debug API - Call any API endpoint with authentication
 *
 * Usage:
 *   node bin/debug-api.js <method> <path> [json-params]
 *
 * Examples:
 *   node bin/debug-api.js GET /api/v1/plugins
 *   node bin/debug-api.js POST /api/v1/extract '{"extractor":"grobid","file_id":"abc123"}'
 *   node bin/debug-api.js GET /api/v1/collections/test/files
 */

import { readFile } from 'fs/promises';
import { createHash } from 'crypto';
import dotenv from 'dotenv';

/**
 * Hash password using SHA-256
 */
function hashPassword(password) {
  return createHash('sha256').update(password).digest('hex');
}

/**
 * Login and get session ID
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

  const sessionId = data.sessionId || data.session_id;
  if (!sessionId) {
    throw new Error(`Login response missing sessionId: ${JSON.stringify(data)}`);
  }

  return sessionId;
}

/**
 * Call API endpoint
 */
async function callApi(baseUrl, sessionId, method, path, params) {
  const url = new URL(path, baseUrl);
  const headers = {
    'X-Session-ID': sessionId,
  };

  let body = null;

  if (method === 'GET' && params) {
    // Add as query parameters
    Object.entries(params).forEach(([key, value]) => {
      url.searchParams.append(key, value);
    });
  } else if (params) {
    // Add as JSON body
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(params);
  }

  const response = await fetch(url.toString(), {
    method,
    headers,
    body,
  });

  const contentType = response.headers.get('content-type');
  let result;

  if (contentType && contentType.includes('application/json')) {
    result = await response.json();
  } else {
    result = await response.text();
  }

  return {
    status: response.status,
    statusText: response.statusText,
    ok: response.ok,
    headers: Object.fromEntries(response.headers.entries()),
    body: result,
  };
}

/**
 * Main function
 */
async function main() {
  const args = process.argv.slice(2);

  if (args.length < 2) {
    console.error('Usage: node bin/debug-api.js <method> <path> [json-params]');
    console.error('\nExamples:');
    console.error('  node bin/debug-api.js GET /api/v1/plugins');
    console.error('  node bin/debug-api.js POST /api/v1/extract \'{"extractor":"grobid","file_id":"abc"}\'');
    process.exit(1);
  }

  const [method, path, paramsJson] = args;
  const params = paramsJson ? JSON.parse(paramsJson) : null;

  // Load environment
  dotenv.config();

  const baseUrl = process.env.API_BASE_URL || 'http://localhost:8000';
  const username = process.env.API_USER;
  const password = process.env.API_PASSWORD;

  if (!username || !password) {
    console.error('Error: API_USER and API_PASSWORD must be set in .env file');
    process.exit(1);
  }

  console.log(`Authenticating as ${username}...`);
  const sessionId = await login(baseUrl, username, password);
  console.log(`Session ID: ${sessionId.substring(0, 10)}...\n`);

  console.log(`Calling: ${method} ${path}`);
  if (params) {
    console.log(`Params: ${JSON.stringify(params, null, 2)}`);
  }
  console.log('');

  const result = await callApi(baseUrl, sessionId, method, path, params);

  console.log(`Status: ${result.status} ${result.statusText}`);
  console.log(`\nResponse:`);
  console.log(JSON.stringify(result.body, null, 2));

  if (!result.ok) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('Error:', error.message);
  process.exit(1);
});
