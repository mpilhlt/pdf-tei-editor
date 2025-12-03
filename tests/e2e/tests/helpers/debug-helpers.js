/**
 * Log additional debug output only when E2E_DEBUG environment variable is set
 */
const DEBUG = ['true', '1', 'yes', 'on'].includes(process.env.E2E_DEBUG);
export const debugLog = (...args) => {
  if (DEBUG) {
    console.log('[DEBUG]', ...args);
  }
};