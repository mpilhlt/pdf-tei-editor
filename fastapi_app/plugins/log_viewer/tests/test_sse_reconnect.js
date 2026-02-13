#!/usr/bin/env node
// @ts-check
/// <reference types="node" />
/**
 * Standalone test: Log viewer SSE reconnection after server restart.
 *
 * STATUS: SKIPPED — This test manages its own server lifecycle (start, kill,
 * restart) which makes it slow and fragile in CI. The server kill/restart
 * phase can hang due to port reuse timing and process cleanup issues on macOS.
 * To be revisited when the test infrastructure supports reliable server
 * lifecycle management (see #270).
 *
 * Manages its own server lifecycle (start -> test -> kill -> restart -> test -> stop)
 * to verify that SSE log subscriptions can be re-established after a server restart.
 *
 * Run directly (when unskipped):
 *   node fastapi_app/plugins/log_viewer/tests/test_sse_reconnect.js
 *
 * @testCovers fastapi_app/plugins/log_viewer/routes.py
 * @testCovers fastapi_app/lib/sse_log_handler.py
 * @testCovers app/src/plugins/sse.js (reconnection logic)
 */

import http from 'node:http';
import { execSync } from 'node:child_process';
import { createEventSource } from 'eventsource-client';
import { LocalServerManager } from '../../../../tests/lib/local-server-manager.js';

// Increase connection limit
http.globalAgent.maxSockets = 50;

/** @param {number} ms */
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Hash password using SHA-256 (matches auth API)
 * @param {string} password
 * @returns {string}
 */
function hashPassword(password) {
  const { createHash } = await_import_crypto();
  return createHash('sha256').update(password, 'utf8').digest('hex');
}

// Workaround: import crypto at module level
import { createHash } from 'node:crypto';
/** @returns {{ createHash: typeof createHash }} */
function await_import_crypto() { return { createHash }; }

/**
 * Login and return session ID
 * @param {string} baseUrl
 * @param {string} username
 * @param {string} password
 * @returns {Promise<string>}
 */
async function loginSession(baseUrl, username, password) {
  const passwd_hash = hashPassword(password);
  const response = await fetch(`${baseUrl}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, passwd_hash })
  });
  if (!response.ok) {
    throw new Error(`Login failed: ${response.status}`);
  }
  const data = await response.json();
  return data.sessionId;
}

/**
 * Create SSE connection and collect logEntry events
 * @param {string} baseUrl
 * @param {string} sessionId
 * @returns {{ events: Array<object>, close: () => void }}
 */
function createLogSSEConnection(baseUrl, sessionId) {
  /** @type {Array<object>} */
  const events = [];

  const eventSource = createEventSource({
    url: `${baseUrl}/api/v1/sse/subscribe`,
    headers: { 'X-Session-Id': sessionId },
    onMessage: (message) => {
      if (message.event === 'logEntry') {
        try {
          events.push(JSON.parse(message.data));
        } catch {
          events.push({ raw: message.data });
        }
      }
    }
  });

  return { events, close: () => eventSource.close() };
}

/**
 * Subscribe session to log events on the backend
 * @param {string} baseUrl
 * @param {string} sessionId
 */
async function subscribeToLogs(baseUrl, sessionId) {
  const response = await fetch(
    `${baseUrl}/api/plugins/log-viewer/subscribe?session_id=${encodeURIComponent(sessionId)}`,
    { method: 'POST' }
  );
  if (!response.ok) {
    throw new Error(`Subscribe failed: ${response.status}`);
  }
}

/**
 * Trigger a log-generating action
 * @param {string} baseUrl
 * @param {string} sessionId
 */
async function triggerLogAction(baseUrl, sessionId) {
  await fetch(
    `${baseUrl}/api/plugins/log-viewer/level?level=INFO&session_id=${encodeURIComponent(sessionId)}`,
    { method: 'POST' }
  );
}

/**
 * Force-kill all processes on a given port
 * @param {number} port
 */
function forceKillPort(port) {
  try {
    const pids = execSync(`lsof -ti:${port} 2>/dev/null`, { encoding: 'utf-8' }).trim();
    if (pids) {
      for (const pid of pids.split('\n')) {
        try { execSync(`kill -9 ${pid} 2>/dev/null`); } catch { /* ignore */ }
      }
    }
  } catch { /* no processes on port */ }
}

// ============================================================================
// Main test
// ============================================================================

async function main() {
  // Use the same test runtime directories as the API test suite
  const manager = new LocalServerManager({
    dbDir: 'tests/api/runtime/db',
    dataRoot: 'tests/api/runtime',
    logDir: 'tests/api/runtime/logs',
  });

  const startEnv = {
    FASTAPI_APPLICATION_MODE: 'testing',
    DISCORD_AUDIT_TRAIL_ENABLED: 'false',
    LOG_LEVEL: 'DEBUG',
  };

  let passed = 0;
  let failed = 0;
  let conn = null;

  function assert(condition, message) {
    if (!condition) {
      console.error(`  FAIL: ${message}`);
      failed++;
    } else {
      console.log(`  PASS: ${message}`);
      passed++;
    }
  }

  try {
    // ---- Phase 1: Start server and verify log events work ----
    console.log('\n=== Phase 1: Initial server start ===');

    await manager.start({ cleanDb: true, verbose: false, env: startEnv });
    const baseUrl = manager.getBaseUrl();
    const port = manager.port;
    console.log(`Server running at ${baseUrl}`);

    const sessionId = await loginSession(baseUrl, 'admin', 'admin');
    console.log(`Logged in (session: ${sessionId.slice(0, 8)}...)`);

    conn = createLogSSEConnection(baseUrl, sessionId);
    await sleep(1500);

    await subscribeToLogs(baseUrl, sessionId);
    await sleep(500);

    await triggerLogAction(baseUrl, sessionId);
    await sleep(2000);

    assert(conn.events.length > 0, `Phase 1: received ${conn.events.length} logEntry events`);

    // Close SSE connection before killing the server
    conn.close();
    conn = null;
    await sleep(500);

    // ---- Phase 2: Kill server and restart ----
    console.log('\n=== Phase 2: Server restart ===');

    // Force-kill the server process directly (simulate crash)
    console.log(`Killing server on port ${port}...`);
    forceKillPort(port);
    manager.serverProcess = null; // Let manager know the process is gone
    await sleep(2000);

    // Restart without wiping database
    console.log('Restarting server...');
    await manager.start({ cleanDb: false, verbose: false, env: startEnv });
    const baseUrl2 = manager.getBaseUrl();
    console.log(`Server restarted at ${baseUrl2}`);

    // ---- Phase 3: Verify recovery after restart ----
    console.log('\n=== Phase 3: Verify recovery after restart ===');

    // Re-login (sessions are in-memory, lost on restart)
    const sessionId2 = await loginSession(baseUrl2, 'admin', 'admin');
    console.log(`Re-logged in (session: ${sessionId2.slice(0, 8)}...)`);

    conn = createLogSSEConnection(baseUrl2, sessionId2);
    await sleep(1500);

    // Re-subscribe (simulating what the fixed view.html does on reconnection)
    await subscribeToLogs(baseUrl2, sessionId2);
    await sleep(500);

    await triggerLogAction(baseUrl2, sessionId2);
    await sleep(2000);

    assert(conn.events.length > 0, `Phase 3: received ${conn.events.length} logEntry events after restart`);

    conn.close();
    conn = null;

  } catch (/** @type {any} */ err) {
    console.error(`\nERROR: ${err.message}`);
    if (err.stack) console.error(err.stack);
    failed++;
  } finally {
    // Close any lingering SSE connection
    if (conn) conn.close();

    // Force cleanup
    if (manager.port) {
      forceKillPort(manager.port);
    }

    // Clean up temp env file
    try { await manager.stop(); } catch { /* ignore */ }
  }

  // Summary
  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
}

// SKIPPED: see header comment. Remove this block to re-enable.
console.log('SKIPPED: test_sse_reconnect.js — server lifecycle test disabled (see #270)');
process.exit(0);

// eslint-disable-next-line no-unreachable
main();
