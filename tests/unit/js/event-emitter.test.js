#!/usr/bin/env node

/**
 * Test suite for EventEmitter class
 * Uses Node.js built-in test runner (available in Node 18+)
 *
 * @testCovers app/src/modules/event-emitter.js
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { EventEmitter } from '../../../app/src/modules/event-emitter.js';

describe('EventEmitter', () => {
  
  test('should create instance with default timeout', () => {
    const emitter = new EventEmitter();
    assert.strictEqual(emitter.defaultTimeout, 5000);
  });

  test('should create instance with custom timeout', () => {
    const emitter = new EventEmitter({ defaultTimeout: 3000 });
    assert.strictEqual(emitter.defaultTimeout, 3000);
  });

  test('should register and call event listeners', async () => {
    const emitter = new EventEmitter();
    let called = false;
    let receivedData = null;

    emitter.on('test', (data) => {
      called = true;
      receivedData = data;
    });

    await emitter.emit('test', 'hello');
    
    assert.strictEqual(called, true);
    assert.strictEqual(receivedData, 'hello');
  });

  test('should return listener ID from on()', () => {
    const emitter = new EventEmitter();
    const id = emitter.on('test', () => {});
    
    assert.strictEqual(typeof id, 'number');
    assert.strictEqual(id, 1);
  });

  test('should remove listener by ID', async () => {
    const emitter = new EventEmitter();
    let callCount = 0;

    const id = emitter.on('test', () => {
      callCount++;
    });

    await emitter.emit('test', null);
    assert.strictEqual(callCount, 1);

    emitter.off(id);
    await emitter.emit('test', null);
    assert.strictEqual(callCount, 1); // Should not increment
  });

  test('should remove listener by event and function', async () => {
    const emitter = new EventEmitter();
    let callCount = 0;

    const listener = () => {
      callCount++;
    };

    emitter.on('test', listener);
    await emitter.emit('test', null);
    assert.strictEqual(callCount, 1);

    emitter.off('test', listener);
    await emitter.emit('test', null);
    assert.strictEqual(callCount, 1); // Should not increment
  });

  test('should support once() listeners that auto-remove', async () => {
    const emitter = new EventEmitter();
    let callCount = 0;

    emitter.once('test', () => {
      callCount++;
    });

    await emitter.emit('test', null);
    assert.strictEqual(callCount, 1);

    await emitter.emit('test', null);
    assert.strictEqual(callCount, 1); // Should not increment
  });

  test('should handle multiple listeners for same event', async () => {
    const emitter = new EventEmitter();
    const calls = [];

    emitter.on('test', (data) => {
      calls.push('listener1:' + data);
    });

    emitter.on('test', (data) => {
      calls.push('listener2:' + data);
    });

    await emitter.emit('test', 'hello');
    
    assert.strictEqual(calls.length, 2);
    assert.strictEqual(calls[0], 'listener1:hello');
    assert.strictEqual(calls[1], 'listener2:hello');
  });

  test('should pass AbortSignal to listeners', async () => {
    const emitter = new EventEmitter();
    let receivedSignal = null;

    emitter.on('test', (data, signal) => {
      receivedSignal = signal;
    });

    await emitter.emit('test', 'data');
    
    assert.strictEqual(receivedSignal instanceof AbortSignal, true);
    assert.strictEqual(receivedSignal.aborted, false);
  });

  test('should timeout listeners that take too long', async () => {
    const emitter = new EventEmitter({ defaultTimeout: 100 });
    let listenerCompleted = false;
    let consoleWarnings = [];
    
    // Capture console warnings
    const originalWarn = console.warn;
    console.warn = (message) => {
      consoleWarnings.push(message);
    };

    try {
      emitter.on('test', async (data, signal) => {
        // Simulate slow operation that respects abort signal
        try {
          await new Promise((resolve, reject) => {
            const timeout = setTimeout(resolve, 200);
            signal.addEventListener('abort', () => {
              clearTimeout(timeout);
              reject(new Error('AbortError'));
            });
          });
          listenerCompleted = true;
        } catch (error) {
          if (error.message === 'AbortError') {
            // Re-throw as proper AbortError
            const abortError = new Error('The operation was aborted');
            abortError.name = 'AbortError';
            throw abortError;
          }
          throw error;
        }
      });

      const results = await emitter.emit('test', 'data');
      
      assert.strictEqual(listenerCompleted, false);
      assert.strictEqual(results.length, 1);
      assert.strictEqual(results[0].status, 'rejected');
      assert.strictEqual(consoleWarnings.length, 1);
      assert.ok(consoleWarnings[0].includes('timed out after 100ms'));
      
    } finally {
      console.warn = originalWarn;
    }
  });

  test('should use custom timeout when specified', async () => {
    const emitter = new EventEmitter({ defaultTimeout: 100 });
    let listenerCompleted = false;

    emitter.on('test', async (data, signal) => {
      await new Promise(resolve => setTimeout(resolve, 150));
      if (!signal.aborted) {
        listenerCompleted = true;
      }
    });

    // Use longer timeout for this specific emit
    await emitter.emit('test', 'data', { timeout: 200 });
    
    assert.strictEqual(listenerCompleted, true);
  });

  test('should handle listener errors gracefully', async () => {
    const emitter = new EventEmitter();
    let errorMessages = [];
    
    // Capture console errors
    const originalError = console.error;
    console.error = (message) => {
      errorMessages.push(message);
    };

    try {
      emitter.on('test', () => {
        throw new Error('Test error');
      });

      emitter.on('test', () => {
        return 'success';
      });

      const results = await emitter.emit('test', 'data');
      
      assert.strictEqual(results.length, 2);
      assert.strictEqual(results[0].status, 'rejected');
      assert.strictEqual(results[1].status, 'fulfilled');
      assert.strictEqual(results[1].value, 'success');
      assert.strictEqual(errorMessages.length, 1);
      
    } finally {
      console.error = originalError;
    }
  });

  test('should return undefined when no listeners exist', async () => {
    const emitter = new EventEmitter();
    const result = await emitter.emit('nonexistent', 'data');
    
    assert.strictEqual(result, undefined);
  });

  test('should handle async listeners correctly', async () => {
    const emitter = new EventEmitter();
    let result = null;

    emitter.on('test', async (data) => {
      await new Promise(resolve => setTimeout(resolve, 10));
      result = data + ' processed';
      return result;
    });

    const results = await emitter.emit('test', 'data');
    
    assert.strictEqual(result, 'data processed');
    assert.strictEqual(results.length, 1);
    assert.strictEqual(results[0].status, 'fulfilled');
    assert.strictEqual(results[0].value, 'data processed');
  });

  test('should handle listener that checks abort signal', async () => {
    const emitter = new EventEmitter({ defaultTimeout: 50 });
    let checkCount = 0;
    let wasAborted = false;

    emitter.on('test', async (data, signal) => {
      for (let i = 0; i < 10; i++) {
        checkCount++;
        if (signal?.aborted) {
          wasAborted = true;
          return;
        }
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    });

    await emitter.emit('test', 'data');
    
    assert.ok(checkCount < 10, 'Should have been aborted before completing all iterations');
    assert.strictEqual(wasAborted, true);
  });

  test('should support backwards compatibility with listeners without signal parameter', async () => {
    const emitter = new EventEmitter();
    let called = false;

    // Old-style listener that doesn't use signal parameter
    emitter.on('test', (data) => {
      called = true;
      assert.strictEqual(data, 'test data');
    });

    await emitter.emit('test', 'test data');
    assert.strictEqual(called, true);
  });

});