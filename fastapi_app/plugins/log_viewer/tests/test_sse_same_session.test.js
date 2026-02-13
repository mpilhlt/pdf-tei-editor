// @ts-check
/// <reference types="node" />
/**
 * Integration test: Log viewer receives same-session log events via SSE.
 *
 * Verifies that a session subscribed to log events receives logEntry SSE
 * events triggered by its own HTTP requests (fixes #257).
 *
 * Run with:
 *   node tests/backend-test-runner.js --test-dir fastapi_app/plugins/log_viewer/tests
 *
 * @testCovers fastapi_app/plugins/log_viewer/routes.py
 * @testCovers fastapi_app/lib/sse_log_handler.py
 */

import { test, describe } from 'node:test';
import * as assert from 'node:assert';
import http from 'node:http';
import { createEventSource } from 'eventsource-client';
import { login, authenticatedRequest } from '../../../../tests/api/helpers/test-auth.js';

const BASE_URL = process.env.E2E_BASE_URL || 'http://localhost:8000';

// Increase HTTP agent max sockets to avoid connection limits
http.globalAgent.maxSockets = 50;

describe('Log Viewer SSE - Same Session Events', { concurrency: 1 }, () => {

  /**
   * Helper: Create SSE connection and collect events of a given type
   * @param {{sessionId: string}} session
   * @param {string|null} eventType - Filter for this event type, or null for all
   * @returns {{events: Array<{event: string, data: string}>, waitForEvents: (count: number, timeout?: number) => Promise<Array<{event: string, data: string}>>, close: () => void}}
   */
  function createSSEConnection(session, eventType = null) {
    /** @type {Array<{event: string, data: string}>} */
    const events = [];

    const eventSource = createEventSource({
      url: `${BASE_URL}/api/v1/sse/subscribe`,
      headers: {
        'X-Session-Id': session.sessionId
      },
      onMessage: (message) => {
        if (!eventType || message.event === eventType) {
          events.push({ event: message.event, data: message.data });
        }
      }
    });

    return {
      events,
      waitForEvents: (count, timeout = 5000) => {
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            reject(new Error(
              `Timeout: received ${events.length}/${count} ${eventType || ''} events after ${timeout}ms`
            ));
          }, timeout);

          const check = () => {
            if (events.length >= count) {
              clearTimeout(timer);
              resolve(events.slice(0, count));
            } else {
              setTimeout(check, 50);
            }
          };
          check();
        });
      },
      close: () => eventSource.close()
    };
  }

  test('Same session receives its own logEntry events', { timeout: 15000 }, async () => {
    // Login as admin (required for log viewer endpoints)
    const session = await login('admin', 'admin', BASE_URL);

    // Establish SSE connection and listen for logEntry events
    const connection = createSSEConnection(session, 'logEntry');

    // Wait for SSE connection to stabilize
    await new Promise(resolve => setTimeout(resolve, 1500));

    // Subscribe this session to log events on the backend
    const subResponse = await authenticatedRequest(
      session.sessionId,
      '/api/plugins/log-viewer/subscribe',
      'POST',
      null,
      BASE_URL
    );
    assert.strictEqual(subResponse.status, 200, 'Subscribe should succeed');

    // Wait for subscription to take effect
    await new Promise(resolve => setTimeout(resolve, 500));

    // Trigger an action from the SAME session that generates log entries.
    // Changing the log level generates a log message: "Log level changed to ..."
    const levelResponse = await fetch(
      `${BASE_URL}/api/plugins/log-viewer/level?level=INFO&session_id=${encodeURIComponent(session.sessionId)}`,
      { method: 'POST' }
    );
    assert.strictEqual(levelResponse.status, 200, 'Set level should succeed');

    // Also fetch recent logs — this generates server-side logging
    const recentResponse = await fetch(
      `${BASE_URL}/api/plugins/log-viewer/recent?session_id=${encodeURIComponent(session.sessionId)}`
    );
    assert.strictEqual(recentResponse.status, 200, 'Recent logs should succeed');

    try {
      // Wait for at least 1 logEntry event (generous timeout)
      const received = await connection.waitForEvents(1, 5000);

      assert.ok(received.length >= 1, 'Should receive at least one logEntry event');

      // Parse the event data to verify it's a valid log entry
      const entry = JSON.parse(received[0].data);
      assert.ok(entry.timestamp, 'Log entry should have a timestamp');
      assert.ok(entry.level, 'Log entry should have a level');
      assert.ok(entry.message, 'Log entry should have a message');

    } finally {
      // Clean up: unsubscribe and close
      await fetch(
        `${BASE_URL}/api/plugins/log-viewer/unsubscribe?session_id=${encodeURIComponent(session.sessionId)}`,
        { method: 'POST' }
      );
      connection.close();
      await new Promise(resolve => setTimeout(resolve, 200));
    }
  });

  test('Cross-session log events are received', { timeout: 15000 }, async () => {
    // Session A: subscribes to log events
    const sessionA = await login('admin', 'admin', BASE_URL);

    // Session B: triggers actions
    const sessionB = await login('admin', 'admin', BASE_URL);

    // Establish SSE for session A
    const connectionA = createSSEConnection(sessionA, 'logEntry');

    await new Promise(resolve => setTimeout(resolve, 1500));

    // Subscribe session A to log events
    const subResponse = await authenticatedRequest(
      sessionA.sessionId,
      '/api/plugins/log-viewer/subscribe',
      'POST',
      null,
      BASE_URL
    );
    assert.strictEqual(subResponse.status, 200);

    await new Promise(resolve => setTimeout(resolve, 500));

    // Trigger action from session B
    const levelResponse = await fetch(
      `${BASE_URL}/api/plugins/log-viewer/level?level=DEBUG&session_id=${encodeURIComponent(sessionB.sessionId)}`,
      { method: 'POST' }
    );
    assert.strictEqual(levelResponse.status, 200, 'Set level from session B should succeed');

    try {
      // Wait for logEntry events on session A
      const received = await connectionA.waitForEvents(1, 5000);

      assert.ok(received.length >= 1, 'Session A should receive log events from session B');

      const entry = JSON.parse(received[0].data);
      assert.ok(entry.message, 'Log entry should have a message');

    } finally {
      await fetch(
        `${BASE_URL}/api/plugins/log-viewer/unsubscribe?session_id=${encodeURIComponent(sessionA.sessionId)}`,
        { method: 'POST' }
      );
      connectionA.close();
      // Reset log level
      await fetch(
        `${BASE_URL}/api/plugins/log-viewer/level?level=INFO&session_id=${encodeURIComponent(sessionB.sessionId)}`,
        { method: 'POST' }
      );
      await new Promise(resolve => setTimeout(resolve, 200));
    }
  });
});
