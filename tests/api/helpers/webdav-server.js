/**
 * WebDAV Test Server Helper
 *
 * Manages a WsgiDAV server instance for integration testing.
 * Provides utilities to start, stop, and configure a lightweight WebDAV server.
 */

import { spawn } from 'child_process';
import { mkdir, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

/**
 * WebDAV server configuration and management
 */
class WebDAVTestServer {
  /**
   * @param {object} options - Server configuration
   * @param {number} options.port - Port to run server on (default: 8081)
   * @param {string} options.rootDir - Root directory for WebDAV (default: temp dir)
   * @param {string} options.username - Username for authentication (default: 'test')
   * @param {string} options.password - Password for authentication (default: 'test123')
   */
  constructor(options = {}) {
    this.port = options.port || 8081;
    this.rootDir = options.rootDir || join(tmpdir(), `webdav-test-${Date.now()}`);
    this.username = options.username || 'test';
    this.password = options.password || 'test123';
    this.process = null;
    this.startupTimeout = 10000; // 10 seconds
    this.baseUrl = `http://localhost:${this.port}`;
  }

  /**
   * Start the WebDAV server
   * @returns {Promise<void>}
   */
  async start() {
    // Create root directory
    await mkdir(this.rootDir, { recursive: true });
    console.log(`📁 Created WebDAV root directory: ${this.rootDir}`);

    // Start WsgiDAV server using Python
    // Using basic auth with specified credentials
    const args = [
      '-m', 'wsgidav',
      '--host', '127.0.0.1',
      '--port', this.port.toString(),
      '--root', this.rootDir,
      '--auth', 'http-basic',
      '--server', 'cheroot',
      '--no-config' // Don't look for config files
    ];

    console.log(`🚀 Starting WsgiDAV server on port ${this.port}...`);
    console.log(`   Command: python ${args.join(' ')}`);

    return new Promise((resolve, reject) => {
      // Use 'python3' or 'python' depending on system
      this.process = spawn('python3', args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          // Set HTTP auth via environment variable
          WSGIDAV_HTTP_BASIC_AUTH: `{"${this.username}": "${this.password}"}`
        }
      });

      let startupOutput = '';
      const timeoutId = setTimeout(() => {
        this.process?.kill();
        reject(new Error(`WebDAV server failed to start within ${this.startupTimeout}ms\nOutput: ${startupOutput}`));
      }, this.startupTimeout);

      // Capture output for debugging
      this.process.stdout?.on('data', (data) => {
        const output = data.toString();
        startupOutput += output;

        // Look for successful startup message
        if (output.includes('Serving on') || output.includes('listening on')) {
          clearTimeout(timeoutId);
          console.log(`✅ WebDAV server started successfully on ${this.baseUrl}`);
          console.log(`   Root: ${this.rootDir}`);
          console.log(`   Auth: ${this.username}:${this.password}`);
          resolve();
        }
      });

      this.process.stderr?.on('data', (data) => {
        const output = data.toString();
        startupOutput += output;
        // Some servers log to stderr, check for startup there too
        if (output.includes('Serving on') || output.includes('listening on')) {
          clearTimeout(timeoutId);
          console.log(`✅ WebDAV server started successfully on ${this.baseUrl}`);
          resolve();
        }
      });

      this.process.on('error', (error) => {
        clearTimeout(timeoutId);
        reject(new Error(`Failed to start WebDAV server: ${error.message}`));
      });

      this.process.on('exit', (code) => {
        if (code !== null && code !== 0) {
          clearTimeout(timeoutId);
          reject(new Error(`WebDAV server exited with code ${code}\nOutput: ${startupOutput}`));
        }
      });

      // Give server a moment to start even if we don't see the message
      setTimeout(() => {
        if (this.process && !this.process.killed) {
          clearTimeout(timeoutId);
          console.log(`⚠️  WebDAV server process started (no startup message detected)`);
          resolve();
        }
      }, 2000);
    });
  }

  /**
   * Stop the WebDAV server
   * @returns {Promise<void>}
   */
  async stop() {
    if (this.process && !this.process.killed) {
      console.log(`🛑 Stopping WebDAV server...`);

      return new Promise((resolve) => {
        this.process.once('exit', () => {
          console.log(`✅ WebDAV server stopped`);
          resolve();
        });

        this.process.kill('SIGTERM');

        // Force kill after 3 seconds if still running
        setTimeout(() => {
          if (this.process && !this.process.killed) {
            console.log(`⚠️  Force killing WebDAV server...`);
            this.process.kill('SIGKILL');
            resolve();
          }
        }, 3000);
      });
    }
  }

  /**
   * Clean up the WebDAV root directory
   * @returns {Promise<void>}
   */
  async cleanup() {
    try {
      await rm(this.rootDir, { recursive: true, force: true });
      console.log(`🧹 Cleaned up WebDAV directory: ${this.rootDir}`);
    } catch (error) {
      console.warn(`⚠️  Failed to cleanup WebDAV directory: ${error.message}`);
    }
  }

  /**
   * Stop server and cleanup directory
   * @returns {Promise<void>}
   */
  async destroy() {
    await this.stop();
    await this.cleanup();
  }

  /**
   * Get WebDAV connection configuration for tests
   * @returns {object} Configuration object
   */
  getConfig() {
    return {
      baseUrl: this.baseUrl,
      username: this.username,
      password: this.password,
      remoteRoot: '/pdf-tei-editor' // Default remote root path
    };
  }
}

/**
 * Create and start a WebDAV test server
 * @param {object} options - Server options
 * @returns {Promise<WebDAVTestServer>} Started server instance
 */
async function startWebDAVServer(options = {}) {
  const server = new WebDAVTestServer(options);
  await server.start();
  return server;
}

export {
  WebDAVTestServer,
  startWebDAVServer
};
