/**
 * This component provides a simple logging component which can be extended later
 * or replaced with a shim to an external library
 */
import { app, App } from '../app.js'

// name of the component
const name = "logger"

/**
 * component API
 */
const loggerComponent = {
  setDebugLevel,
  debug,
  info,
  warn,
  fatal
}

/**
 * Runs when the main app starts so the plugins can register the app components they supply
 * @param {App} app The main application
 */
function install(app) {
  app.registerComponent(name, loggerComponent, name)
  loggerComponent.info("Logging component installed.")
}

/**
 * component plugin
 */
const loggerPlugin = {
  name,
  install
}

export { loggerComponent, loggerPlugin }
export default loggerPlugin

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
 * The current debugging level.
 * Only debug messages with a level less than or equal to this value will be displayed.
 * Defaults to 0 (no debug messages).
 * @type {number}
 * @global
 */
let debugLevel = 0 

/**
 * Sets the global debugging level.
 * Only debug messages with a level less than or equal to this value will be displayed.
 * @param {number} level The new debugging level.
 * @returns {void}
 */
function setDebugLevel(level) {
  debugLevel = level
}

/**
 * Logs a debug message if the message's level is less than or equal to the current global debug level.
 * The message will be prefixed with "DEBUG: ".
 * @param {any} msg The message or object to log.
 * @param {number} [level=1] The level of this debug message. Defaults to 1.
 * @returns {void}
 */
function debug(msg, level = 1) {
  if (level <= debugLevel) {
    console.groupCollapsed(`DEBUG`, msg)
    console.trace()
    console.groupEnd()
  }
}

/**
 * Logs an informational message using console.info.
 * @param {any} msg The message or object to log.
 * @returns {void}
 */
function info(...msg) {
  console.info(...msg)
}

/**
 * Logs a warning message using console.warn.
 * @param {any} msg The message or object to log.
 * @returns {void}
 */
function warn(...msg) {
  console.warn(...msg)
}

/**
 * Logs a fatal error message using console.error.
 * @param {any} msg The message or object to log.
 * @returns {void}
 */
function fatal(...msg) {
  console.error(...msg)
}