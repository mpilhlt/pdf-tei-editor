/**
 * Test logging utilities
 *
 * Provides consistent, parseable logging for test output.
 * Uses text prefixes instead of emojis for better parsing and cross-platform compatibility.
 */

/**
 * ANSI color codes for terminal output
 */
const colors = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
};

/**
 * Test logger with configurable color output
 */
export class TestLogger {
  /**
   * @param {Object} options - Logger options
   * @param {boolean} [options.useColors=true] - Whether to use ANSI color codes
   */
  constructor(options = {}) {
    this.useColors = options.useColors !== false;
  }

  /**
   * Apply color to text if colors are enabled
   * @param {string} text - Text to colorize
   * @param {string} color - Color name from colors object
   * @returns {string} Colorized or plain text
   */
  colorize(text, color) {
    if (!this.useColors) return text;
    return `${colors[color]}${text}${colors.reset}`;
  }

  /**
   * Log an info message
   * @param {string} message - Message to log
   */
  info(message) {
    console.log(`${this.colorize('[INFO]', 'cyan')} ${message}`);
  }

  /**
   * Log a success message
   * @param {string} message - Message to log
   */
  success(message) {
    console.log(`${this.colorize('[OK]', 'green')} ${message}`);
  }

  /**
   * Log a warning message
   * @param {string} message - Message to log
   */
  warn(message) {
    console.log(`${this.colorize('[WARN]', 'yellow')} ${message}`);
  }

  /**
   * Log an error message
   * @param {string} message - Message to log
   */
  error(message) {
    console.log(`${this.colorize('[ERROR]', 'red')} ${message}`);
  }

  /**
   * Log a debug message (only if verbose mode enabled)
   * @param {string} message - Message to log
   */
  debug(message) {
    if (process.env.VERBOSE) {
      console.log(`${this.colorize('[DEBUG]', 'blue')} ${message}`);
    }
  }

  /**
   * Log data/statistics (typically JSON)
   * @param {string} label - Label for the data
   * @param {*} data - Data to log (will be stringified if object)
   */
  data(label, data) {
    const dataStr = typeof data === 'object' ? JSON.stringify(data, null, 2) : data;
    console.log(`${this.colorize('[DATA]', 'cyan')} ${label}:`, dataStr);
  }
}

/**
 * Default logger instance with colors enabled
 */
export const logger = new TestLogger();
