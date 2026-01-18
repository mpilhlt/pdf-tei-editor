// @ts-check
/// <reference types="node" />
/**
 * E2E Integration Tests for Server-Sent Events (SSE) API
 * @testCovers fastapi_app/routers/sse.py
 * @testCovers fastapi_app/lib/sse_service.py
 *
 */

import { test, describe } from 'node:test';
import * as assert from 'node:assert';
import http from 'node:http';
import { createEventSource } from 'eventsource-client';
import { login, authenticatedRequest } from '../helpers/test-auth.js';

const BASE_URL = process.env.E2E_BASE_URL || 'http://localhost:8000';

// Increase HTTP agent max sockets to handle SSE connections + regular requests
http.globalAgent.maxSockets = 50;

describe('SSE API Integration Tests', { concurrency: 1 }, () => {

  /** @type {{sessionId: string, user: object}} */
  let globalSession;

  /**
   * Helper: Get test session
   */
  async function getSession() {
    if (!globalSession) {
      globalSession = await login('reviewer', 'reviewer', BASE_URL);
    }
    return globalSession;
  }

  /**
   * Helper: Create SSE connection with authentication and collect events
   * @param {{sessionId: string}} session - Session with authentication
   * @param {string|null} eventType - Optional event type filter
   * @param {boolean} debug - Enable debug logging
   * @returns {{eventSource: any, events: string[], waitForEvents: (count: number, timeout?: number) => Promise<string[]>, close: () => void}}
   */
  function createSSEConnection(session, eventType = null, debug = false) {
    /** @type {string[]} */
    const events = [];

    const eventSource = createEventSource({
      url: `${BASE_URL}/api/v1/sse/subscribe`,
      headers: {
        'X-Session-Id': session.sessionId
      },
      onMessage: (message) => {
        if (debug) {
          console.log(`[SSE] Received event: ${message.event}, data: ${message.data}`);
        }
        // Filter by event type if specified
        if (!eventType || message.event === eventType) {
          events.push(message.data);
        } else if (debug) {
          console.log(`[SSE] Filtered out event type: ${message.event} (waiting for: ${eventType})`);
        }
      },
      onDisconnect: () => {
        if (debug) {
          console.log(`[SSE] Connection disconnected`);
        }
      }
    });

    return {
      eventSource,
      events,
      /**
       * Wait for a specific number of events
       */
      waitForEvents: (count, timeout = 5000) => {
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            reject(new Error(`Timeout: Only received ${events.length}/${count} events`));
          }, timeout);

          const checkEvents = () => {
            if (events.length >= count) {
              clearTimeout(timer);
              resolve(events.slice(0, count));
            } else {
              setTimeout(checkEvents, 50);
            }
          };

          checkEvents();
        });
      },
      close: () => eventSource.close()
    };
  }

  test('Test 1: SSE subscribe endpoint requires authentication', async () => {
    const response = await fetch(`${BASE_URL}/api/v1/sse/subscribe`);
    assert.strictEqual(response.status, 401, 'Should require authentication');
  });

  test('Test 2: SSE subscribe endpoint returns event stream', async () => {
    const session = await getSession();
    const connection = createSSEConnection(session);

    // Wait a bit for connection to establish
    await new Promise(resolve => setTimeout(resolve, 100));

    assert.strictEqual(connection.eventSource.readyState, 'open', 'Connection should be open');
    connection.close();

    // Wait for SSE cleanup to complete before next test
    await new Promise(resolve => setTimeout(resolve, 200));
  });

  test('Test 3: SSE echo test endpoint sends messages', async () => {
    // Create fresh session to avoid queue conflicts with Test 2
    const session = await login('reviewer', 'reviewer', BASE_URL);
    const connection = createSSEConnection(session, 'test'); // Filter for 'test' events

    // Wait for connection to establish and SSE stream to start consuming
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Send echo request
    const testMessages = ['Message 1', 'Message 2', 'Message 3'];

    // Trigger echo
    const echoResponse = await authenticatedRequest(
      session.sessionId,
      '/sse/test/echo',
      'POST',
      testMessages,
      BASE_URL
    );

    assert.strictEqual(echoResponse.status, 200, 'Echo endpoint should return 200');
    const echoData = await echoResponse.json();
    assert.strictEqual(echoData.status, 'ok', 'Echo should return ok status');
    assert.strictEqual(
      echoData.messages_sent,
      testMessages.length,
      'Should report correct number of messages sent'
    );

    // Wait for and collect SSE events (increased timeout for full test suite)
    const receivedMessages = await connection.waitForEvents(testMessages.length, 5000);

    assert.strictEqual(
      receivedMessages.length,
      testMessages.length,
      `Should receive exactly ${testMessages.length} test events`
    );

    // Verify message content
    for (let i = 0; i < testMessages.length; i++) {
      assert.strictEqual(
        receivedMessages[i],
        testMessages[i],
        `Message ${i+1} should match`
      );
    }

    connection.close();
  });

  test('Test 4: SSE connection receives keep-alive pings', async () => {
    const session = await getSession();
    const connection = createSSEConnection(session, 'ping');

    // Collect one ping event
    const pingData = await connection.waitForEvents(1, 35000); // Keep-alive is every 30s

    assert.strictEqual(pingData.length, 1, 'Should receive one ping event');
    assert.strictEqual(pingData[0], 'keepalive', 'Ping should contain keepalive message');

    connection.close();
  });

  test('Test 5: Multiple echo requests are received in order', async () => {
    // Create fresh session to avoid queue conflicts with previous tests
    const session = await login('reviewer', 'reviewer', BASE_URL);
    const connection = createSSEConnection(session, 'test');

    // Wait for connection to establish and SSE stream to start consuming
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Prepare to collect all events
    const batch1 = ['Batch1-Msg1', 'Batch1-Msg2'];
    const batch2 = ['Batch2-Msg1', 'Batch2-Msg2'];
    const allMessages = [...batch1, ...batch2];

    // Send first batch
    await authenticatedRequest(
      session.sessionId,
      '/sse/test/echo',
      'POST',
      batch1,
      BASE_URL
    );

    // Small delay between batches
    await new Promise(resolve => setTimeout(resolve, 300));

    // Send second batch
    await authenticatedRequest(
      session.sessionId,
      '/sse/test/echo',
      'POST',
      batch2,
      BASE_URL
    );

    // Wait for and collect events
    const receivedMessages = await connection.waitForEvents(allMessages.length, 3000);

    // Verify messages are in order
    for (let i = 0; i < allMessages.length; i++) {
      assert.strictEqual(
        receivedMessages[i],
        allMessages[i],
        `Message ${i+1} should be in correct order`
      );
    }

    connection.close();
  });

  test('Test 6: SSE connection handles empty message list', async () => {
    const session = await getSession();

    const response = await authenticatedRequest(
      session.sessionId,
      '/sse/test/echo',
      'POST',
      [],
      BASE_URL
    );

    assert.strictEqual(response.status, 200, 'Should accept empty message list');
    const data = await response.json();
    assert.strictEqual(data.messages_sent, 0, 'Should report 0 messages sent');
  });

  test('Test 7: SSE echo requires authentication', async () => {
    const response = await fetch(`${BASE_URL}/api/v1/sse/test/echo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(['test'])
    });

    assert.strictEqual(response.status, 401, 'Should require authentication');
  });

  test('Test 8: Multiple concurrent SSE connections work independently', async () => {
    // Create two separate sessions for independent connections
    const session1 = await login('reviewer', 'reviewer', BASE_URL);
    const session2 = await login('reviewer', 'reviewer', BASE_URL);

    // Create two connections with different sessions
    const connection1 = createSSEConnection(session1, 'test');
    const connection2 = createSSEConnection(session2, 'test');

    // Wait for both connections to establish
    await new Promise(resolve => setTimeout(resolve, 200));

    // Prepare messages for each connection
    const messages1 = ['Connection1-Msg1', 'Connection1-Msg2'];
    const messages2 = ['Connection2-Msg1', 'Connection2-Msg2'];

    // Send echo requests to respective sessions
    await Promise.all([
      authenticatedRequest(
        session1.sessionId,
        '/sse/test/echo',
        'POST',
        messages1,
        BASE_URL
      ),
      authenticatedRequest(
        session2.sessionId,
        '/sse/test/echo',
        'POST',
        messages2,
        BASE_URL
      )
    ]);

    // Each connection should receive only its own messages
    const [received1, received2] = await Promise.all([
      connection1.waitForEvents(messages1.length, 3000),
      connection2.waitForEvents(messages2.length, 3000)
    ]);

    // Verify each connection received the correct messages
    assert.strictEqual(received1.length, messages1.length, 'Connection 1 should receive its messages');
    assert.strictEqual(received2.length, messages2.length, 'Connection 2 should receive its messages');

    // Verify content of messages
    for (let i = 0; i < messages1.length; i++) {
      assert.strictEqual(received1[i], messages1[i], `Connection 1 message ${i+1} should match`);
    }
    for (let i = 0; i < messages2.length; i++) {
      assert.strictEqual(received2[i], messages2[i], `Connection 2 message ${i+1} should match`);
    }

    connection1.close();
    connection2.close();
  });

  test('Test 9: Broadcast message sent to all sessions', { timeout: 15000 }, async () => {
    // Clean up any lingering SSE queues from previous tests
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Create two separate sessions
    const session1 = await login('reviewer', 'reviewer', BASE_URL);
    const session2 = await login('reviewer', 'reviewer', BASE_URL);

    // Create connections to collect all events (no filtering)
    const connection1 = createSSEConnection(session1, null, false);
    const connection2 = createSSEConnection(session2, null, false);

    try {
      // Wait for SSE connections to fully establish
      await new Promise(resolve => setTimeout(resolve, 2000));

      // Send a broadcast message using session1
      const broadcastMessage = 'Broadcast message to all';
      const response = await authenticatedRequest(
        session1.sessionId,
        '/sse/test/broadcast',
        'POST',
        { message: broadcastMessage },
        BASE_URL
      );

      assert.strictEqual(response.status, 200, 'Broadcast endpoint should return 200');
      const data = await response.json();
      assert.strictEqual(data.status, 'ok', 'Broadcast should return ok status');

      // Wait for broadcast to be delivered
      await new Promise(resolve => setTimeout(resolve, 1500));

      // Find broadcast events in the collected events (filter out pings)
      /** @param {string[]} events */
      const findBroadcast = (events) => {
        for (const event of events) {
          try {
            const parsed = JSON.parse(event);
            if (parsed.message === broadcastMessage) {
              return parsed;
            }
          } catch (e) {
            // Skip non-JSON events like 'keepalive'
          }
        }
        return null;
      };

      const data1 = findBroadcast(connection1.events);
      const data2 = findBroadcast(connection2.events);

      assert.ok(data1, 'Connection 1 should receive broadcast message');
      assert.ok(data2, 'Connection 2 should receive broadcast message');
      assert.strictEqual(data1.message, broadcastMessage, 'Connection 1 message should match');
      assert.strictEqual(data2.message, broadcastMessage, 'Connection 2 message should match');
    } finally {
      // Always close connections even if test fails
      connection1.close();
      connection2.close();

      // Wait for SSE cleanup to complete before next test
      await new Promise(resolve => setTimeout(resolve, 200));
    }
  });

  test('Test 10: Progress widget events are received', { timeout: 15000 }, async () => {
    // Create fresh session
    const session = await login('reviewer', 'reviewer', BASE_URL);

    // Collect all progress-related events
    /** @type {Array<{event: string, data: any}>} */
    const progressEvents = [];

    const eventSource = createEventSource({
      url: `${BASE_URL}/api/v1/sse/subscribe`,
      headers: {
        'X-Session-Id': session.sessionId
      },
      onMessage: (message) => {
        // Capture all progress events
        if (message.event.startsWith('progress')) {
          try {
            progressEvents.push({
              event: message.event,
              data: JSON.parse(message.data)
            });
          } catch (e) {
            progressEvents.push({
              event: message.event,
              data: message.data
            });
          }
        }
      }
    });

    try {
      // Wait for connection to establish
      await new Promise(resolve => setTimeout(resolve, 1000));

      // Trigger progress test with 3 quick steps
      const response = await authenticatedRequest(
        session.sessionId,
        '/sse/test/progress',
        'POST',
        { steps: 3, delay_ms: 200, label_prefix: 'Test step' },
        BASE_URL
      );

      assert.strictEqual(response.status, 200, 'Progress endpoint should return 200');
      const data = await response.json();
      assert.strictEqual(data.status, 'ok', 'Should return ok status');
      assert.strictEqual(data.steps_completed, 3, 'Should report 3 steps completed');
      assert.ok(data.progress_id, 'Should return progress_id');

      // Wait for all progress events to be received
      // Expected: 1 show + 3 value + 3 label + 1 hide = 8 events
      const expectedMinEvents = 8;
      const waitStart = Date.now();
      while (progressEvents.length < expectedMinEvents && Date.now() - waitStart < 5000) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }

      // Verify we received the key events
      const eventTypes = progressEvents.map(e => e.event);

      assert.ok(
        eventTypes.includes('progressShow'),
        `Should receive progressShow event. Got: ${eventTypes.join(', ')}`
      );
      assert.ok(
        eventTypes.includes('progressValue'),
        `Should receive progressValue events. Got: ${eventTypes.join(', ')}`
      );
      assert.ok(
        eventTypes.includes('progressLabel'),
        `Should receive progressLabel events. Got: ${eventTypes.join(', ')}`
      );
      assert.ok(
        eventTypes.includes('progressHide'),
        `Should receive progressHide event. Got: ${eventTypes.join(', ')}`
      );

      // Verify progress_id is consistent across events
      const progressId = data.progress_id;
      const allEventsHaveCorrectId = progressEvents.every(
        e => e.data.progress_id === progressId
      );
      assert.ok(
        allEventsHaveCorrectId,
        `All events should have progress_id=${progressId}`
      );

      // Verify progressShow has expected fields
      const showEvent = progressEvents.find(e => e.event === 'progressShow');
      assert.ok(showEvent, 'Should have progressShow event');
      assert.strictEqual(showEvent.data.cancellable, true, 'Should be cancellable');
      assert.ok(showEvent.data.label, 'Should have initial label');
      assert.strictEqual(showEvent.data.value, 0, 'Should start at 0');

      // Verify final progressValue is 100
      const valueEvents = progressEvents.filter(e => e.event === 'progressValue');
      const lastValue = valueEvents[valueEvents.length - 1];
      assert.strictEqual(lastValue.data.value, 100, 'Final progress value should be 100');

    } finally {
      eventSource.close();
      await new Promise(resolve => setTimeout(resolve, 200));
    }
  });
});
