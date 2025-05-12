/**
 * This plugin provides logging endpoints and an API to invoke them. The implementation uses
 * console.* methods
 */

import pluginManager from "../modules/plugin.js"
import ep from '../endpoints.js'

// name of the plugin
const name = "logger"

/**
 * A object mapping human readable log level names to numbers
 */
const logLevel = {
  SUPPRESS : 0,
  CRITICAL: 1,
  WARN: 2,
  INFO: 3,
  DEBUG: 4,
  VERBOSE: 5
}

/**
 * The current logging level.
 * @type {number}
 * @global
 */
let currentLogLevel = logLevel.INFO 

/**
 * Easy to use logging API which will  send log events to all registered log plugins 
 */
const api = {
  /**
   * Sets the log level {@see logLevel}
   * @param {Number} level The log level
   * @returns {void}
   */
  setLogLevel: level => pluginManager.invoke(ep.log.setLogLevel, {level}),

  /**
   * Logs a debug message, with varying levels of verbosity
   * @param {string} message The debug message
   * @param {Number} level The log level, which is normally either DEBUG (4) or VERBOSE (5)
   * @returns {void}
   */
  debug: (message, level = logLevel.DEBUG) => pluginManager.invoke(ep.log.debug, {message, level}),

  /**
   * Logs an informational message
   * @param {string} message 
   * @returns {void}
   */
  info: message => pluginManager.invoke(ep.log.info, {message}),

  /**
   * Logs an warning message
   * @param {string} message 
   * @returns {void}
   */
  warn: message => pluginManager.invoke(ep.log.warn, {message}),

  /**
   * Logs an message about a critical or fatal error
   * @param {string} message 
   * @returns {void}
   */
  critical: message => pluginManager.invoke(ep.log.fatal, {message})
}

/**
 * component plugin
 */
const plugin = {
  name,
  install: () => console.info("Console-based logger installed."),
  log: {
    setLogLevel,
    debug,
    info,
    warn,
    critical
  }
}

export { api, plugin, logLevel, setLogLevel }
export default plugin

//
// implementation
//

/**
 * Returns the current stack trace 
 * @returns {String}
 */
function getStack() {
  const obj = {};
  if ("captureStackTrace" in Error) {
    // Avoid getStack itself in the stack trace
    Error.captureStackTrace(obj, getStack);
  }
  return obj.stack;
}

function getLocation() {
  return getStack()
}



/**
 * Sets the global debugging level.
 * Only debug messages with a level less than or equal to this value will be displayed.
 * @param {object} options - An object containing the message and level.
 * @param {number} options.level The new debugging level.
 * @returns {void}
 */
function setLogLevel({level}) {
  currentLogLevel = level
}

/**
 * Logs a debug message if the message's level is less than or equal to the current global log level.
 * The message will be prefixed with "DEBUG: ".
 * @param {object} options - An object containing the message and level.
 * @param {any} options.message - The message or object to log.
 * @param {number} [options.level=1] - The level of this debug message. Defaults to 1.
 * @returns {void}
 */
function debug({message, level = logLevel.DEBUG}) {
  if (level >= currentLogLevel) {
    console.groupCollapsed(`DEBUG`, message)
    console.trace()
    console.groupEnd()
  }
}

/**
 * Logs an informational message using console.info.
 * @param {object} options - An object containing the message and level.
 * @param {any} options.message - The message or object to log.
 * @returns {void}
 */
function info({message}) {
  if (currentLogLevel >= logLevel.INFO) {
    console.info(message)
  }
}

/**
 * Logs a warning message using console.warn.
 * @param {object} options - An object containing the message and level.
 * @param {any} options.message - The message or object to log.
 * @returns {void}
 */
function warn({message}) {
  if (currentLogLevel >= logLevel.WARN) {
    console.warn(message)
  }
}

/**
 * Logs a fatal error message using console.error.
 * @param {object} options - An object containing the message and level.
 * @param {any} options.message - The message or object to log.
 * @returns {void}
 */
function critical({message}) {
  if (currentLogLevel >= logLevel.CRITICAL) {
    console.error(message)
  }
}