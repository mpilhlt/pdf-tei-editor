import { ServerManager } from './server-manager.js';
import { WebdavServerManager } from './webdav-server-manager.js';
import { getPortWithFallback, allocateports } from './port-allocator.js';
import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import { join } from 'path';
import { platform } from 'os';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { logger } from '../api/helpers/test-logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Local server manager for development and testing.
 *
 * Manages FastAPI server lifecycle on the local machine:
 * - Kills existing servers on port 8000
 * - Optionally wipes database for clean slate
 * - Starts local server
 * - Optionally starts WebDAV server for sync tests (via WebdavServerManager)
 * - Waits for /health endpoint
 * - Cleanup on exit
 *
 * @extends ServerManager
 */
export class LocalServerManager extends ServerManager {
  constructor(options = {}) {
    super();
    this.projectRoot = join(__dirname, '..', '..');
    this.fastapiApp = join(this.projectRoot, 'fastapi_app');

    // DB and data directories can be overridden via options (from env file)
    // Default to fastapi_app locations for backward compatibility
    this.dbDir = options.dbDir ? join(this.projectRoot, options.dbDir) : join(this.fastapiApp, 'db');
    this.dataDir = options.dataRoot ? join(this.projectRoot, options.dataRoot) : join(this.fastapiApp, 'data');

    // Log directory can be overridden via options (from env file)
    this.logDir = options.logDir ? join(this.projectRoot, options.logDir) : join(this.projectRoot, 'log');
    this.logFile = join(this.logDir, 'server.log');

    // Host and port can be overridden via options (from env vars or CLI)
    // Port will be resolved to available port during start() if not explicitly specified
    this.host = options.host || 'localhost';
    this.explicitPort = options.port; // Explicit port from env/CLI (undefined if not set)
    this.port = null; // Actual port, set during start()
    this.serverUrl = null; // Set during start()

    this.serverProcess = null;
    this.webdavManager = null;
    this.tempEnvFile = null;
  }

  /**
   * @inheritdoc
   */
  getType() {
    return 'local';
  }

  /**
   * @inheritdoc
   */
  getBaseUrl() {
    if (!this.serverProcess || !this.serverUrl) {
      throw new Error('Server is not running');
    }
    return this.serverUrl;
  }

  /**
   * Kill any existing FastAPI/uvicorn servers on the configured port
   *
   * Only kills processes on the specific port, not all uvicorn processes.
   * This prevents killing dev servers running on other ports (e.g., port 8000).
   *
   * @private
   * @returns {Promise<void>}
   */
  async killExistingServers() {
    logger.info(`Killing any running FastAPI servers on port ${this.port}`);

    if (platform() === 'win32') {
      // Windows: kill by port only
      try {
        const { exec } = await import('child_process');
        await new Promise((resolve) => {
          exec(`netstat -ano | findstr :${this.port}`, (err, stdout) => {
            if (err || !stdout.trim()) {
              resolve();
              return;
            }
            // Extract PIDs from netstat output
            const pids = new Set();
            for (const line of stdout.split('\n')) {
              const match = line.match(/\s+(\d+)\s*$/);
              if (match) pids.add(match[1]);
            }
            if (pids.size === 0) {
              resolve();
              return;
            }
            const killPromises = Array.from(pids).map(
              (pid) =>
                new Promise((res) => {
                  exec(`taskkill /F /PID ${pid}`, () => res());
                })
            );
            Promise.all(killPromises).then(resolve).catch(resolve);
          });
        });
      } catch (err) {
        // Ignore errors
      }
    } else {
      // Unix: kill by port only (more targeted than pattern matching)
      try {
        const { exec } = await import('child_process');
        await new Promise((resolve, reject) => {
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
    await new Promise((resolve) => setTimeout(resolve, 2000));
    console.log('[SUCCESS] Servers on port', this.port, 'stopped');
  }

  /**
   * Wipe database for clean slate
   *
   * Clears all data for a fresh test run:
   * 1. Removes SQLite databases (metadata.db, sessions.db, locks.db)
   * 2. Removes all files from runtime/files storage
   * 3. Preserves JSON config files (users.json, config.json, roles.json)
   *    which will be used by db_init on server startup
   *
   * After this, the fixture loader will import fresh files.
   *
   * @private
   * @returns {Promise<void>}
   */
  async wipeDatabase() {
    logger.info('Wiping database for clean slate');

    // Remove SQLite database files
    console.log('[INFO] Removing SQLite database files');
    const dbFiles = ['metadata.db', 'sessions.db', 'locks.db'];

    for (const dbFile of dbFiles) {
      try {
        const dbPath = join(this.dbDir, dbFile);
        await fs.rm(dbPath, { force: true });
        // Also remove WAL and SHM files
        await fs.rm(`${dbPath}-wal`, { force: true });
        await fs.rm(`${dbPath}-shm`, { force: true });
        console.log(`[INFO] Removed ${dbFile}`);
      } catch (err) {
        // Ignore if doesn't exist
      }
    }

    // Note: JSON config files are NOT removed here.
    // They are copied fresh by loadFixture to runtime/db before wipeDatabase runs.
    // This ensures config files like users.json are available when the server starts.

    // Remove all files from storage (runtime/files)
    // This removes the hash-sharded storage but preserves the directory structure
    console.log('[INFO] Cleaning file storage');
    try {
      const filesDir = join(this.dataDir, 'files');
      const filesDirExists = await fs.access(filesDir).then(() => true).catch(() => false);

      if (filesDirExists) {
        // Remove the entire files directory
        await fs.rm(filesDir, { recursive: true, force: true });
        console.log('[INFO] Removed files directory');

        // Recreate empty files directory
        await fs.mkdir(filesDir, { recursive: true });
        console.log('[INFO] Recreated empty files directory');
      } else {
        // Files directory doesn't exist - create it
        await fs.mkdir(filesDir, { recursive: true });
        console.log('[INFO] Created files directory');
      }
    } catch (err) {
      console.log('[WARN] Could not clean files directory:', err.message);
    }

    console.log('[SUCCESS] Database wiped - ready for fixture import');
  }


  /**
   * Create temporary .env file with WebDAV configuration
   *
   * @private
   * @param {Object} webdavConfig - WebDAV configuration object
   * @param {Object} customEnv - Custom environment variables from test runner
   * @returns {Promise<string>} Path to temporary env file
   */
  async createTempEnvFile(webdavConfig, customEnv = {}) {
    const { tmpdir } = await import('os');
    const { randomBytes } = await import('crypto');
    const { resolve } = await import('path');

    const tempFileName = join(
      tmpdir(),
      `fastapi-test-${randomBytes(8).toString('hex')}.env`
    );

    // Config dir is one level up from db dir (tests/api/runtime/config)
    // Use absolute paths since FastAPI may have different CWD
    const configDir = resolve(join(this.dbDir, '..', 'config'));
    const dbDirAbs = resolve(this.dbDir);
    const dataDirAbs = resolve(this.dataDir);

    let envContent = `# FastAPI Test Configuration
HOST=${this.host}
PORT=${this.port}
DATA_ROOT=${dataDirAbs}
DB_DIR=${dbDirAbs}
CONFIG_DIR=${configDir}

SESSION_TIMEOUT=3600
LOG_LEVEL=INFO
`;

    // Add WebDAV configuration if provided
    if (webdavConfig) {
      envContent += `
# WebDAV Configuration for Sync Tests
WEBDAV_ENABLED=${webdavConfig.WEBDAV_ENABLED}
WEBDAV_BASE_URL=${webdavConfig.WEBDAV_BASE_URL}
WEBDAV_USERNAME=${webdavConfig.WEBDAV_USERNAME}
WEBDAV_PASSWORD=${webdavConfig.WEBDAV_PASSWORD}
WEBDAV_REMOTE_ROOT=${webdavConfig.WEBDAV_REMOTE_ROOT}
`;
    }

    // Add custom environment variables from .env.test or --env flags
    if (customEnv && Object.keys(customEnv).length > 0) {
      envContent += '\n# Custom Test Environment Variables\n';
      for (const [key, value] of Object.entries(customEnv)) {
        // Skip variables that are already set above or are Node.js specific
        if (!['HOST', 'PORT', 'DATA_ROOT', 'DB_DIR', 'CONFIG_DIR', 'SESSION_TIMEOUT', 'LOG_LEVEL',
              'PATH', 'HOME', 'USER', 'SHELL', 'NODE_ENV'].includes(key)) {
          envContent += `${key}=${value}\n`;
        }
      }
    }

    await fs.writeFile(tempFileName, envContent, 'utf-8');
    console.log(`[INFO] Created temporary env file: ${tempFileName}`);
    console.log('[SUCCESS] WebDAV configuration written to temp env file');

    return tempFileName;
  }

  /**
   * Start the FastAPI development server
   *
   * @private
   * @param {boolean} verbose - Whether to show server output
   * @returns {Promise<void>}
   */
  async startServerProcess(verbose = false) {
    logger.info('Starting FastAPI development server');

    // Ensure log directory exists
    await fs.mkdir(this.logDir, { recursive: true });

    // Clear previous log
    await fs.writeFile(this.logFile, '', 'utf-8');

    console.log(
      verbose
        ? '[INFO] Starting server with verbose output...'
        : `[INFO] Starting server (output in ${this.logFile})...`
    );

    // Start server
    // On Windows, always use pipe mode since shell redirection is unreliable
    // On Unix, use shell redirection for better performance
    if (verbose || platform() === 'win32') {
      // Set environment variables:
      // - PYTHONUNBUFFERED=1 for immediate Python output
      // - HOST and PORT for server configuration
      // - FASTAPI_CONFIG_DIR for fixture config directory
      const configDir = join(this.dbDir, '..', 'config');
      const env = {
        ...process.env,
        PYTHONUNBUFFERED: '1',
        HOST: this.host,
        PORT: String(this.port),
        FASTAPI_CONFIG_DIR: configDir,
      };

      // On Windows, bypass the Python wrapper script and call uvicorn directly
      // The wrapper script has issues with piped stdio on Windows
      const uvicornArgs = platform() === 'win32'
        ? ['run', 'uvicorn', 'run_fastapi:app', '--host', this.host, '--port', String(this.port), '--log-level', 'info']
        : ['run', 'python', 'bin/start-dev'];

      // Spawn the server process
      // Note: We don't use detached mode because we rely on lsof to find and kill
      // all processes on the port, which is more reliable than process groups
      this.serverProcess = spawn('uv', uvicornArgs, {
        cwd: this.projectRoot,
        stdio: 'pipe',
        env,
      });

      // Redirect output to log file
      this.serverProcess.stdout?.on('data', (data) => {
        if (verbose) {
          process.stdout.write(data);
        }
        fs.appendFile(this.logFile, data);
      });
      this.serverProcess.stderr?.on('data', (data) => {
        if (verbose) {
          process.stderr.write(data);
        }
        fs.appendFile(this.logFile, data);
      });
    } else {
      // Unix only: use sh with shell redirection for better performance
      const { spawn: spawnShell } = await import('child_process');
      const configDir = join(this.dbDir, '..', 'config');
      this.serverProcess = spawnShell(
        'sh',
        ['-c', `PYTHONUNBUFFERED=1 HOST=${this.host} PORT=${this.port} FASTAPI_CONFIG_DIR="${configDir}" uv run python bin/start-dev >> "${this.logFile}" 2>&1`],
        {
          cwd: this.projectRoot,
          stdio: 'ignore',
        }
      );
    }

    console.log(`[INFO] Server PID: ${this.serverProcess.pid}`);

    // Handle process exit
    this.serverProcess.on('exit', (code) => {
      if (code !== 0 && code !== null) {
        console.error(`[ERROR] Server process exited with code ${code}`);
      }
    });
  }

  /**
   * Check server log for errors
   *
   * @private
   * @returns {Promise<string|null>} Error message if found
   */
  async checkServerLogForErrors() {
    try {
      const logContent = await fs.readFile(this.logFile, 'utf-8');
      const errorLines = [];

      for (const line of logContent.split('\n')) {
        const lowerLine = line.toLowerCase();
        if (
          (lowerLine.includes('error') ||
            lowerLine.includes('exception') ||
            lowerLine.includes('failed')) &&
          !lowerLine.includes('INFO')
        ) {
          errorLines.push(line);
        }
      }

      if (errorLines.length > 0) {
        return errorLines.slice(-10).join('\n');
      }
    } catch (err) {
      // Ignore errors
    }
    return null;
  }

  /**
   * Wait for server to start up and verify health
   *
   * @private
   * @param {number} timeoutSec - Timeout in seconds
   * @returns {Promise<boolean>} True if server started successfully
   */
  async waitForStartup(timeoutSec = 15) {
    logger.info(`Waiting for server startup (timeout: ${timeoutSec}s)`);

    for (let i = 0; i < timeoutSec; i++) {
      await new Promise((resolve) => setTimeout(resolve, 1000));

      // Check if process is still running
      if (this.serverProcess?.exitCode !== null) {
        console.error('[ERROR] Server process died during startup!');
        console.error(`[ERROR] Check log file: ${this.logFile}`);
        console.error('\n[ERROR] Last 20 lines of log:');
        try {
          const logContent = await fs.readFile(this.logFile, 'utf-8');
          const lines = logContent.split('\n').slice(-20);
          lines.forEach((line) => console.error(line));
        } catch (err) {
          // Ignore
        }
        return false;
      }

      // Check for startup errors in log
      const errors = await this.checkServerLogForErrors();
      if (errors) {
        console.error('[ERROR] Errors detected in server log during startup!');
        console.error(`[ERROR] Check log file: ${this.logFile}`);
        console.error('\n[ERROR] Errors found:');
        console.error(errors);
        return false;
      }

      // Check if server is responding
      try {
        const response = await fetch(`${this.serverUrl}/health`, {
          signal: AbortSignal.timeout(1000),
        });
        if (response.ok) {
          console.log(
            `[SUCCESS] Server started successfully and responding at ${this.serverUrl}`
          );
          return true;
        }
      } catch (err) {
        // Server not ready yet, continue waiting
      }

      if ((i + 1) % 3 === 0) {
        console.log(`[INFO] Still waiting... (${i + 1}s)`);
      }
    }

    console.error(`[ERROR] Server failed to start within ${timeoutSec}s`);
    console.error(`[ERROR] Check log file: ${this.logFile}`);
    console.error('\n[ERROR] Last 30 lines of log:');
    try {
      const logContent = await fs.readFile(this.logFile, 'utf-8');
      const lines = logContent.split('\n').slice(-30);
      lines.forEach((line) => console.error(line));
    } catch (err) {
      // Ignore
    }
    return false;
  }

  /**
   * @inheritdoc
   */
  async isHealthy(timeoutMs = 5000) {
    try {
      const response = await fetch(`${this.serverUrl}/health`, {
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (response.ok) {
        const data = await response.json();
        if (data.status === 'ok') {
          console.log(`[SUCCESS] Health check passed: ${JSON.stringify(data)}`);
          return true;
        }
        console.error(`[ERROR] Health check failed: ${JSON.stringify(data)}`);
        return false;
      }
      return false;
    } catch (err) {
      console.error(`[ERROR] Health check failed: ${err.message}`);
      return false;
    }
  }

  /**
   * @inheritdoc
   */
  async start(options = {}) {
    const {
      cleanDb = true,
      verbose = false,
      env = {},
      needsWebdav = false,
    } = options;

    // Step 0: Resolve ports - allocate main server and WebDAV ports together to avoid conflicts
    let webdavPort = null;

    if (this.explicitPort) {
      // Explicit port specified - use it directly and kill any existing servers on it
      this.port = this.explicitPort;
      console.log(`[INFO] Using explicitly specified port ${this.port} for local server`);
      this.serverUrl = `http://${this.host}:${this.port}`;

      // Kill existing servers on the explicit port
      await this.killExistingServers();

      // If WebDAV needed, allocate its port separately (excluding the explicit main port)
      if (needsWebdav) {
        webdavPort = await getPortWithFallback(8012, 8012, 8999, [this.port]);
      }
    } else {
      // No explicit port - auto-select available port(s) in 8010+ range
      if (needsWebdav) {
        // Allocate both main and WebDAV ports together to avoid conflicts
        const [mainPort, wdavPort] = await allocateports(2, 8010, 8999);
        this.port = mainPort;
        webdavPort = wdavPort;
        console.log(`[INFO] Auto-selected available ports: ${this.port} (main), ${webdavPort} (WebDAV)`);
      } else {
        // Just allocate main server port
        this.port = await getPortWithFallback(8010, 8010, 8999);
        console.log(`[INFO] Auto-selected available port ${this.port} for local server`);
      }
      this.serverUrl = `http://${this.host}:${this.port}`;
      // No need to kill servers - ports are already available
    }

    // Step 2: Wipe database (unless cleanDb is false)
    if (cleanDb) {
      await this.wipeDatabase();
    } else {
      logger.info('Keeping existing database (cleanDb=false)');
      console.warn('[WARNING] Tests may fail if database schema is outdated');
    }

    // Step 2.5: Start WebDAV server if needed and create temp env file
    let webdavConfig = null;
    if (needsWebdav) {
      // Create and start WebDAV server manager with pre-allocated port
      this.webdavManager = new WebdavServerManager({ port: webdavPort });
      await this.webdavManager.start({ verbose });
      webdavConfig = this.webdavManager.getConfig();
    }

    // Always create temporary .env file (even without WebDAV) to set CONFIG_DIR
    // Pass custom env vars so they're written to the temp file for FastAPI to read
    this.tempEnvFile = await this.createTempEnvFile(webdavConfig, env);
    process.env.FASTAPI_ENV_FILE = this.tempEnvFile;
    console.log(`[INFO] Set FASTAPI_ENV_FILE=${this.tempEnvFile}\n`);

    // Apply any additional environment variables to test runner process
    Object.assign(process.env, env);

    // Step 3: Start server
    await this.startServerProcess(verbose);

    // Step 4: Wait for startup
    // Use longer timeout on Windows (server startup is slower)
    const timeoutSec = platform() === 'win32' ? 30 : 15;
    const started = await this.waitForStartup(timeoutSec);
    if (!started) {
      throw new Error('Server failed to start');
    }

    // Verify health
    const healthy = await this.isHealthy();
    if (!healthy) {
      throw new Error('Server health check failed');
    }

    return this.serverUrl;
  }

  /**
   * @inheritdoc
   */
  async stop(options = {}) {
    const { keepRunning = false } = options;

    if (keepRunning) {
      console.warn('\n[WARNING] Skipping cleanup (keepRunning=true)');
      console.log(`[INFO] FastAPI server still running at ${this.serverUrl}`);
      if (this.webdavManager) {
        console.log(`[INFO] WebDAV server still running at ${this.webdavManager.getBaseUrl()}`);
      }
      console.log(`[INFO] View logs: tail -f ${this.logFile}`);
      return;
    }

    logger.info('Cleaning up...');

    // Stop FastAPI server
    if (this.serverProcess) {
      const serverPid = this.serverProcess.pid;
      console.log(`[INFO] Stopping FastAPI server (PID: ${serverPid})`);
      try {
        if (platform() === 'win32') {
          // Windows: kill process tree
          const { exec } = await import('child_process');
          await new Promise((resolve) => {
            exec(`taskkill /F /T /PID ${serverPid}`, () => resolve());
          });
        } else {
          // Unix: Use graceful shutdown (SIGTERM first, then SIGKILL if needed)
          const { exec } = await import('child_process');

          // Try graceful shutdown first (SIGTERM to all processes on the port)
          // Use lsof to find all processes on the port (more reliable than process groups with uv/uvicorn)
          await new Promise((resolve) => {
            exec(`lsof -ti:${this.port}`, (err, stdout) => {
              if (err || !stdout.trim()) {
                // No processes found on port, try killing just the parent process
                try {
                  process.kill(serverPid, 'SIGTERM');
                } catch (err) {
                  // Process may already be dead, which is fine
                }
                resolve();
                return;
              }
              // Send SIGTERM to all processes on the port
              const pids = stdout.trim().split('\n');
              const killPromises = pids.map(
                (pid) =>
                  new Promise((res) => {
                    exec(`kill -TERM ${pid}`, () => res());
                  })
              );
              Promise.all(killPromises).then(resolve).catch(resolve);
            });
          });

          // Wait for graceful shutdown (give it 3 seconds)
          await new Promise((resolve) => setTimeout(resolve, 3000));

          // Check if port is now free
          let gracefulShutdown = false;
          await new Promise((resolve) => {
            exec(`lsof -ti:${this.port}`, (err, stdout) => {
              gracefulShutdown = err || !stdout.trim();
              resolve();
            });
          });

          // If graceful shutdown failed, force kill processes on the port
          if (!gracefulShutdown) {
            await new Promise((resolve) => {
              exec(`lsof -ti:${this.port}`, (err, stdout) => {
                if (err || !stdout.trim()) {
                  // Port is already free
                  resolve();
                  return;
                }
                // Force kill all processes on the port
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

            // Wait for forced kill to complete
            await new Promise((resolve) => setTimeout(resolve, 1000));
          }
        }
      } catch (err) {
        // Log error but don't throw - cleanup failures shouldn't fail the test run
        console.warn(`[WARNING] Error stopping server: ${err.message}`);
      }
      this.serverProcess = null;
    }

    // Stop WebDAV server
    if (this.webdavManager) {
      await this.webdavManager.stop({ keepRunning: false });
      this.webdavManager = null;
    }

    // Clean up temporary env file
    if (this.tempEnvFile) {
      try {
        await fs.unlink(this.tempEnvFile);
        console.log(`[INFO] Cleaned up temp env file: ${this.tempEnvFile}`);
      } catch (err) {
        console.warn(`[WARNING] Failed to clean up temp env file: ${err.message}`);
      }
      this.tempEnvFile = null;
      delete process.env.FASTAPI_ENV_FILE;
    }

    console.log('[SUCCESS] Cleanup complete');
  }
}
