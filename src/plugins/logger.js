/**
 * This component provides a simple logging component which can be extended later
 * or replaced with a shim to an external library
 */
import { app, App } from '../app.js'

// name of the component
const name = "logger"

/**
 * A object mapping human readable log level names to numbers
 */
const logLevel = {
  SUPPRESS : 0,
  FATAL: 1,
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
 * Easy to use logging API which will also send log events to all registered log plugins 
 */
const api = {
  setLogLevel: level => app.plugin.invoke(app.ext.log.setLogLevel, {level}),
  debug: (message, level) => app.plugin.invoke(app.ext.log.debug, {message, level}),
  info: message => app.plugin.invoke(app.ext.log.info, {message}),
  warn: message => app.plugin.invoke(app.ext.log.warn, {message}),
  fatal: message => app.plugin.invoke(app.ext.log.fatal, {message})
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
    fatal
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
function fatal({message}) {
  if (currentLogLevel >= logLevel.FATAL) {
    console.error(message)
  }
}