import { ServerManager } from './server-manager.js';
import { getPortWithFallback } from './port-allocator.js';
import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import { join } from 'path';
import { platform, tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Standalone WebDAV server manager for sync tests.
 *
 * Manages WsgiDAV server lifecycle independently of backend server:
 * - Cross-platform process management
 * - Configurable port and root directory
 * - Health check via directory listing
 * - Automatic cleanup
 *
 * Can be used by both local and containerized test environments.
 *
 * @extends ServerManager
 */
export class WebdavServerManager extends ServerManager {
  /**
   * @param {Object} [config] - Configuration options
   * @param {number} [config.port=8081] - Port to run WebDAV server on
   * @param {string} [config.webdavRoot] - Root directory for WebDAV (default: OS temp dir + webdav-test)
   * @param {string} [config.remoteRoot='/pdf-tei-editor'] - Remote root path within WebDAV
   */
  constructor(config = {}) {
    super();
    this.projectRoot = join(__dirname, '..', '..');
    this.explicitPort = config.port; // Explicit port from config (undefined if not set)
    this.port = null; // Actual port, set during start()
    // Use OS-specific temp directory on Windows, /tmp on Unix
    this.webdavRoot = config.webdavRoot || (platform() === 'win32'
      ? join(tmpdir(), 'webdav-test')
      : '/tmp/webdav-test');
    this.remoteRoot = config.remoteRoot || '/pdf-tei-editor';
    this.serverUrl = null; // Set during start()
    this.webdavProcess = null;
  }

  /**
   * @inheritdoc
   */
  getType() {
    return 'webdav';
  }

  /**
   * @inheritdoc
   */
  getBaseUrl() {
    if (!this.webdavProcess || !this.serverUrl) {
      throw new Error('WebDAV server is not running');
    }
    return this.serverUrl;
  }

  /**
   * Kill any existing WsgiDAV servers on the configured port
   *
   * @private
   * @returns {Promise<void>}
   */
  async killExistingServers() {
    console.log(`\n==> Killing any running WebDAV servers on port ${this.port}`);

    if (platform() === 'win32') {
      // Windows: kill by port (requires netstat + taskkill)
      try {
        const { exec } = await import('child_process');
        await new Promise((resolve) => {
          exec(
            `FOR /F "tokens=5" %P IN ('netstat -ano ^| findstr :${this.port}') DO @taskkill /F /PID %P`,
            () => resolve()
          );
        });
      } catch (err) {
        // Ignore errors
      }
    } else {
      // Unix: kill by pattern
      try {
        const { exec } = await import('child_process');
        await new Promise((resolve) => {
          exec('pkill -9 -f "wsgidav"', () => resolve());
        });
      } catch (err) {
        // Ignore errors
      }

      // Also kill by port
      try {
        const { exec } = await import('child_process');
        await new Promise((resolve) => {
          exec(`lsof -ti:${this.port}`, (err, stdout) => {
            if (err || !stdout.trim()) {
              resolve();
              return;
            }
            const pids = stdout.trim().split('\n');
            const killPromises = pids.map(
              (pid) =>
                new Promise((res) => {
                  exec(`kill -9 ${pid}`, () => res());
                })
            );
            Promise.all(killPromises).then(resolve).catch(resolve);
          });
        });
      } catch (err) {
        // Ignore errors
      }
    }

    // Wait for ports to be released
    await new Promise((resolve) => setTimeout(resolve, 1000));
    console.log('[SUCCESS] WebDAV servers stopped');
  }

  /**
   * Create WebDAV root directory and remote subdirectory
   *
   * @private
   * @returns {Promise<void>}
   */
  async createDirectories() {
    console.log('\n==> Creating WebDAV directories');

    try {
      await fs.mkdir(this.webdavRoot, { recursive: true });
      console.log(`[INFO] Created WebDAV root: ${this.webdavRoot}`);

      const remoteDir = join(this.webdavRoot, this.remoteRoot.replace(/^\//, ''));
      await fs.mkdir(remoteDir, { recursive: true });
      console.log(`[INFO] Created remote root directory: ${remoteDir}`);
    } catch (err) {
      throw new Error(`Failed to create WebDAV directories: ${err.message}`);
    }
  }

  /**
   * Start WsgiDAV server process
   *
   * @private
   * @param {boolean} verbose - Whether to show server output
   * @returns {Promise<void>}
   */
  async startServerProcess(verbose = false) {
    console.log(`\n==> Starting WsgiDAV server on port ${this.port}`);

    this.webdavProcess = spawn(
      'uv',
      [
        'run',
        'wsgidav',
        '--host',
        '127.0.0.1',
        '--port',
        String(this.port),
        '--root',
        this.webdavRoot,
        '--auth',
        'anonymous',
        '--server',
        'cheroot',
        '--no-config',
      ],
      {
        cwd: this.projectRoot,
        stdio: verbose ? 'pipe' : 'ignore',
      }
    );

    if (verbose && this.webdavProcess.stdout && this.webdavProcess.stderr) {
      this.webdavProcess.stdout.on('data', (data) => {
        process.stdout.write(`[WebDAV] ${data}`);
      });
      this.webdavProcess.stderr.on('data', (data) => {
        process.stderr.write(`[WebDAV] ${data}`);
      });
    }

    console.log(`[INFO] WebDAV process PID: ${this.webdavProcess.pid}`);

    // Handle process exit
    this.webdavProcess.on('exit', (code) => {
      if (code !== 0 && code !== null) {
        console.error(`[ERROR] WebDAV process exited with code ${code}`);
      }
    });

    // Wait briefly for startup (longer on Windows)
    const startupWait = platform() === 'win32' ? 4000 : 2000;
    await new Promise((resolve) => setTimeout(resolve, startupWait));

    // Check if process started successfully
    if (this.webdavProcess.exitCode !== null) {
      throw new Error('WebDAV server failed to start');
    }

    console.log(`[SUCCESS] WebDAV server started on port ${this.port}`);
    console.log('[INFO]   Auth: anonymous (no credentials needed for testing)');
  }

  /**
   * @inheritdoc
   */
  async isHealthy(timeoutMs = 5000) {
    // Retry health check with exponential backoff (especially important on Windows)
    const maxRetries = 5;
    const retryDelay = 1000;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        // Check if we can list the root directory
        const response = await fetch(`${this.serverUrl}/`, {
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (response.ok) {
          console.log(`[SUCCESS] WebDAV health check passed`);
          return true;
        }
        console.error(`[ERROR] WebDAV health check failed: status ${response.status}`);
        return false;
      } catch (err) {
        if (attempt < maxRetries) {
          console.log(`[INFO] Health check attempt ${attempt}/${maxRetries} failed, retrying in ${retryDelay}ms...`);
          await new Promise((resolve) => setTimeout(resolve, retryDelay));
        } else {
          console.error(`[ERROR] WebDAV health check failed after ${maxRetries} attempts: ${err.message}`);
          return false;
        }
      }
    }
    return false;
  }

  /**
   * @inheritdoc
   */
  async start(options = {}) {
    const { verbose = false } = options;

    // Step 0: Resolve port - use explicit port if specified, otherwise find available port
    if (this.explicitPort) {
      // Explicit port specified - use it directly and kill any existing servers on it
      this.port = this.explicitPort;
      console.log(`[INFO] Using explicitly specified port ${this.port} for WebDAV server`);
      this.serverUrl = `http://localhost:${this.port}`;

      // Kill existing WebDAV servers on the explicit port
      await this.killExistingServers();
    } else {
      // No explicit port - auto-select available port in 8010+ range
      this.port = await getPortWithFallback(8012, 8012, 8999);
      console.log(`[INFO] Auto-selected available port ${this.port} for WebDAV server`);
      this.serverUrl = `http://localhost:${this.port}`;
      // No need to kill servers - port is already available
    }

    // Step 2: Create directories
    await this.createDirectories();

    // Step 3: Start server
    await this.startServerProcess(verbose);

    // Step 4: Verify health
    const healthy = await this.isHealthy();
    if (!healthy) {
      throw new Error('WebDAV server health check failed');
    }

    return this.serverUrl;
  }

  /**
   * @inheritdoc
   */
  async stop(options = {}) {
    const { keepRunning = false } = options;

    if (keepRunning) {
      console.warn('\n[WARNING] Skipping WebDAV cleanup (keepRunning=true)');
      console.log(`[INFO] WebDAV server still running on port ${this.port}`);
      return;
    }

    console.log('\n==> Cleaning up WebDAV server...');

    // Stop WebDAV process
    if (this.webdavProcess) {
      console.log(`[INFO] Stopping WebDAV server (PID: ${this.webdavProcess.pid})`);
      try {
        this.webdavProcess.kill('SIGTERM');
        await new Promise((resolve) => {
          const timeout = setTimeout(() => {
            this.webdavProcess?.kill('SIGKILL');
            resolve();
          }, 3000);
          this.webdavProcess?.once('exit', () => {
            clearTimeout(timeout);
            resolve();
          });
        });
      } catch (err) {
        // Ignore errors
      }
      this.webdavProcess = null;
    }

    // Clean up WebDAV root
    try {
      await fs.rm(this.webdavRoot, { recursive: true, force: true });
      console.log(`[INFO] Cleaned up WebDAV root: ${this.webdavRoot}`);
    } catch (err) {
      console.warn(`[WARNING] Failed to clean up WebDAV root: ${err.message}`);
    }

    console.log('[SUCCESS] WebDAV cleanup complete');
  }

  /**
   * Get WebDAV configuration for environment variables
   *
   * @returns {Object} Configuration object with WebDAV settings
   */
  getConfig() {
    return {
      WEBDAV_ENABLED: 'true',
      WEBDAV_BASE_URL: this.serverUrl,
      WEBDAV_USERNAME: '',
      WEBDAV_PASSWORD: '',
      WEBDAV_REMOTE_ROOT: this.remoteRoot,
    };
  }
}
