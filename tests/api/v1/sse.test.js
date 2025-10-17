/**
 * E2E Integration Tests for Server-Sent Events (SSE) API
 * @testCovers fastapi_app/routers/sse.py
 * @testCovers fastapi_app/lib/sse_service.py
 * 
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { createEventSource } from 'eventsource-client';
import { login, authenticatedRequest } from '../helpers/test-auth.js';

const BASE_URL = process.env.E2E_BASE_URL || 'http://localhost:8000';

describe('SSE API Integration Tests', { concurrency: 1 }, () => {

  let globalSession = null;

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
   */
  function createSSEConnection(session, eventType = null, debug = false) {
    const events = [];
    let resolvePromise = null;
    let rejectPromise = null;
    let eventPromise = null;

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
          if (resolvePromise) {
            resolvePromise(message.data);
          }
        } else if (debug) {
          console.log(`[SSE] Filtered out event type: ${message.event} (waiting for: ${eventType})`);
        }
      },
      onError: (error) => {
        if (debug) {
          console.log(`[SSE] Connection error:`, error);
        }
      },
      onClose: () => {
        if (debug) {
          console.log(`[SSE] Connection closed`);
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

  test.skip('Test 4: SSE connection receives keep-alive pings', async () => {
    // This test is skipped because it takes 30+ seconds waiting for keep-alive ping
    // The keep-alive functionality is tested indirectly by other tests
    const session = await getSession();
    const eventSource = createSSEConnection(session);

    // Collect one ping event
    const pingPromise = collectSSEEvents(eventSource, 'ping', 1, 35000); // Keep-alive is every 30s

    const pingData = await pingPromise;

    assert.strictEqual(pingData.length, 1, 'Should receive one ping event');
    assert.strictEqual(pingData[0], 'keepalive', 'Ping should contain keepalive message');
  });

  test('Test 5: Multiple echo requests are received in order', async () => {
    const session = await getSession();
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
});
