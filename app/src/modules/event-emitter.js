/**
 * A simple Event Emitter that can handle async events with timeout support
 * 
 * Example usage:
 * 
 * // Basic listener (signal parameter is optional for backwards compatibility)
 * emitter.on('data', async (data) => {
 *   await processData(data);
 * });
 * 
 * // Listener with abort signal support
 * emitter.on('heavyWork', async (data, signal) => {
 *   for (let i = 0; i < 1000; i++) {
 *     if (signal?.aborted) {
 *       console.log('Work cancelled, cleaning up...');
 *       return;
 *     }
 *     await processItem(i);
 *   }
 * });
 * 
 * // Emit with default timeout
 * await emitter.emit('data', someData);
 * 
 * // Emit with custom timeout
 * await emitter.emit('heavyWork', workData, { timeout: 10000 });
 */
export class EventEmitter {
  /**
   * Creates a new EventEmitter instance
   * @param {object} [options={}] - Configuration options
   * @param {number} [options.defaultTimeout=5000] - Default timeout in milliseconds for listeners
   */
  constructor(options = {}) {
    this.events = {};
    this.listeners = new Map();
    this.nextId = 1;
    this.defaultTimeout = options.defaultTimeout || 5000;
  }

  /**
   * Registers an event listener for the specified event
   * @param {string} event - The event name to listen for
   * @param {function} listener - The callback function to execute when the event is emitted
   * @returns {number} An opaque ID that can be used to remove this listener
   */
  on(event, listener) {
    if (!this.events[event]) {
      this.events[event] = [];
    }
    const id = this.nextId++;
    const listenerInfo = { listener, id };
    this.events[event].push(listenerInfo);
    this.listeners.set(id, { event, listenerInfo });
    return id;
  }

  /**
   * Removes an event listener for the specified event
   * @param {string|number} eventOrId - The event name and listener function, or just the listener ID
   * @param {function} [listener] - The specific listener function to remove (only when first param is event name)
   */
  off(eventOrId, listener) {
    // If only one argument is passed, treat it as an ID
    if (arguments.length === 1) {
      const id = eventOrId;
      const listenerData = this.listeners.get(id);
      if (!listenerData) {
        return;
      }
      
      const { event, listenerInfo } = listenerData;
      if (this.events[event]) {
        const index = this.events[event].indexOf(listenerInfo);
        if (index > -1) {
          this.events[event].splice(index, 1);
        }
        if (this.events[event].length === 0) {
          delete this.events[event];
        }
      }
      this.listeners.delete(id);
    } else {
      // Two arguments: event name and listener function (legacy behavior)
      const event = eventOrId;
      if (!this.events[event]) {
        return;
      }
      const index = this.events[event].findIndex(info => info.listener === listener);
      if (index > -1) {
        const listenerInfo = this.events[event][index];
        this.events[event].splice(index, 1);
        this.listeners.delete(listenerInfo.id);
      }
      if (this.events[event].length === 0) {
        delete this.events[event];
      }
    }
  }

  /**
   * Registers a one-time event listener for the specified event
   * @param {string} event - The event name to listen for
   * @param {function} listener - The callback function to execute when the event is emitted
   * @returns {number} An opaque ID that can be used to remove this listener
   */
  once(event, listener) {
    const wrappedListener = async (data, signal) => {
      const result = await listener(data, signal);
      this.off(id);
      return result;
    };
    const id = this.on(event, wrappedListener);
    return id;
  }

  /**
   * Emits an event, calling all registered listeners asynchronously with timeout support
   * @param {string} event - The event name to emit
   * @param {*} data - The data to pass to the event listeners
   * @param {object} [options={}] - Emit options
   * @param {number} [options.timeout] - Timeout in milliseconds (uses defaultTimeout if not specified)
   * @returns {Promise<PromiseSettledResult<any>[] | undefined>} Array of settled results from listener executions, or undefined if no listeners
   */
  async emit(event, data, options = {}) {
    if (!this.events[event] || this.events[event].length === 0) {
      return undefined;
    }

    const timeout = options.timeout !== undefined ? options.timeout : this.defaultTimeout;
    const controller = new AbortController();
    
    // Set up timeout
    const timeoutId = setTimeout(() => {
      controller.abort();
    }, timeout);
    
    try {
      const results = await Promise.allSettled(
        this.events[event].map(async (listenerInfo) => {
          try {
            // Pass AbortSignal to listener
            return await listenerInfo.listener(data, controller.signal);
          } catch (error) {
            if (error.name === 'AbortError') {
              console.warn(`Listener for event '${event}' timed out after ${timeout}ms`);
            } else {
              console.error(`Error in event listener for ${event}:`, error);
            }
            throw error;
          }
        })
      );
      return results;
    } finally {
      clearTimeout(timeoutId);
    }
  }
}