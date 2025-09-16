/**
 * Logger plugin providing logging functionality with caller context detection.
 * This plugin uses console.* methods and provides hierarchical log level filtering.
 */

/**
 * @import { ApplicationState } from '../state.js'
 * @import { PluginContext } from '../modules/plugin-context.js'
 */

import { Plugin } from '../modules/plugin-base.js'

/**
 * A object mapping human readable log level names to numbers
 */
const logLevel = {
  SUPPRESS : 0,
  CRITICAL: 1,
  WARN: 2,
  INFO: 3,
  LOG: 4,
  DEBUG: 5,
  VERBOSE: 6
}

/**
 * Logger Plugin Class
 * Provides logging functionality with caller context detection
 */
class LoggerPlugin extends Plugin {
  /**
   * @param {PluginContext} context
   */
  constructor(context) {
    super(context, {
      name: 'logger',
      deps: []
    });

    /** @type {number} */
    this.currentLogLevel = logLevel.INFO;
  }

  /**
   * @param {ApplicationState} state
   */
  async install(state) {
    await super.install(state);
    console.log(`Installing plugin "${this.name}"`);
  }

  /**
   * Get caller information from the error stack
   * @returns {string|null} Formatted caller info or null if not found
   */
  getCallerInfo() {
    const stack = new Error().stack;
    if (!stack) return null;

    const lines = stack.split('\n');

    // Skip more frames and look for meaningful caller
    for (let i = 3; i < Math.min(lines.length, 8); i++) {
      const line = lines[i];
      if (!line) continue;

      // Skip internal logger and plugin manager frames
      if (line.includes('logger.js') ||
          line.includes('plugin-manager.js') ||
          line.includes('plugin-base.js') ||
          line.includes('at invoke') ||
          line.includes('at async invoke')) {
        continue;
      }

      // Match different stack trace formats
      const match = line.match(/at\s+(.+?)\s+\((.+?):(\d+):(\d+)\)/) ||
                   line.match(/at\s+(.+?):(\d+):(\d+)/) ||
                   line.match(/(.+?)@(.+?):(\d+):(\d+)/);

      if (match) {
        let functionName = match[1] || 'anonymous';
        const filePath = match[2] || '';
        const fileName = filePath.split('/').pop() || 'unknown';
        const lineNumber = match[3] || '?';

        // Clean up function name - remove async indicators and generators
        functionName = functionName
          .replace(/^async\s*/, '')      // Remove "async" prefix (with optional space)
          .replace(/\*/, '')             // Remove generator "*"
          .replace(/^Object\./, '')      // Remove "Object." prefix
          .trim();

        // Skip generic names and prefer more meaningful ones
        if (functionName === 'anonymous' || functionName === '') {
          continue;
        }

        return `${functionName} (${fileName}:${lineNumber})`;
      }
    }
    return null;
  }

  /**
   * Sets the global debugging level.
   * Only debug messages with a level less than or equal to this value will be displayed.
   * @param {number} level The new debugging level.
   */
  setLogLevel(level) {
    this.currentLogLevel = level;
  }

  /**
   * Logs a debug message if the message's level is less than or equal to the current global log level.
   * @param {any} message - The message or object to log.
   * @param {number} [level=logLevel.DEBUG] - The level of this debug message.
   */
  debug(message, level = logLevel.DEBUG) {
    if (level <= this.currentLogLevel) {
      const caller = this.getCallerInfo();
      if (caller) {
        console.debug(`%c${message}\n%c[${caller}]`, 'color: #1e3a8a;', 'color: #999; font-size: 0.9em;');
      } else {
        console.debug(`%c${message}`, 'color: #1e3a8a;');
      }
    }
  }

  /**
   * Logs an informational message using console.info.
   * @param {any} message - The message or object to log.
   */
  log(message) {
    if (this.currentLogLevel >= logLevel.LOG) {
      const caller = this.getCallerInfo();
      if (caller) {
        console.log(`${message}\n%c[${caller}]`, 'color: #999; font-size: 0.9em;');
      } else {
        console.log(message);
      }
    }
  }  

  /**
   * Logs an informational message using console.info.
   * @param {any} message - The message or object to log.
   */
  info(message) {
    if (this.currentLogLevel >= logLevel.INFO) {
      const caller = this.getCallerInfo();
      if (caller) {
        console.info(`${message}\n%c[${caller}]`, 'color: #999; font-size: 0.9em;');
      } else {
        console.info(message);
      }
    }
  }

  /**
   * Logs a warning message using console.warn.
   * @param {any} message - The message or object to log.
   */
  warn(message) {
    if (this.currentLogLevel >= logLevel.WARN) {
      const caller = this.getCallerInfo();
      if (caller) {
        console.warn(`${message}\n%c[${caller}]`, 'color: #999; font-size: 0.9em;');
      } else {
        console.warn(message);
      }
    }
  }

  /**
   * Logs a critical error message using console.error.
   * @param {any} message - The message or object to log.
   */
  critical(message) {
    if (this.currentLogLevel >= logLevel.CRITICAL) {
      const caller = this.getCallerInfo();
      if (caller) {
        console.error(`${message}\n%c[${caller}]`, 'color: #999; font-size: 0.9em;');
      } else {
        console.error(message);
      }
    }
  }

  /**
   * Alias for critical() for backward compatibility
   * @param {any} message - The message or object to log.
   */
  error(message) {
    this.critical(message);
  }

}

export { logLevel, LoggerPlugin }
export default LoggerPlugin