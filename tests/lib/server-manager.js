/**
 * Abstract base class for server lifecycle management in tests.
 *
 * Provides a unified interface for starting, stopping, and checking health
 * of backend servers in different execution modes (local or containerized).
 *
 * @abstract
 */
export class ServerManager {
  /**
   * Start the server with the given options.
   *
   * @param {Object} options - Server startup options
   * @param {boolean} [options.cleanDb=true] - Whether to wipe database before starting
   * @param {boolean} [options.verbose=false] - Whether to show server output
   * @param {Object.<string, string>} [options.env={}] - Environment variables to set
   * @returns {Promise<string>} The base URL of the started server (E2E_BASE_URL)
   * @throws {Error} If server fails to start or health check fails
   */
  async start(options = {}) {
    throw new Error('ServerManager.start() must be implemented by subclass');
  }

  /**
   * Stop the server and perform cleanup.
   *
   * @param {Object} options - Cleanup options
   * @param {boolean} [options.keepRunning=false] - Whether to keep server running (debug mode)
   * @returns {Promise<void>}
   */
  async stop(options = {}) {
    throw new Error('ServerManager.stop() must be implemented by subclass');
  }

  /**
   * Check if the server is healthy and responding.
   *
   * @param {number} [timeoutMs=30000] - Timeout in milliseconds
   * @returns {Promise<boolean>} True if server is healthy, false otherwise
   */
  async isHealthy(timeoutMs = 30000) {
    throw new Error('ServerManager.isHealthy() must be implemented by subclass');
  }

  /**
   * Get the base URL of the server for test execution.
   *
   * @returns {string} The E2E_BASE_URL value
   * @throws {Error} If server is not running
   */
  getBaseUrl() {
    throw new Error('ServerManager.getBaseUrl() must be implemented by subclass');
  }

  /**
   * Get the server type identifier (e.g., 'local', 'container')
   *
   * @returns {string} Server type identifier
   */
  getType() {
    throw new Error('ServerManager.getType() must be implemented by subclass');
  }
}
