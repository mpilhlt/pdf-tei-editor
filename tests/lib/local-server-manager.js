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
   * @private
   * @returns {Promise<void>}
   */
  async killExistingServers() {
    logger.info(`Killing any running FastAPI servers on port ${this.port}`);

    if (platform() === 'win32') {
      // Windows: use taskkill
      try {
        const { exec } = await import('child_process');
        await new Promise((resolve) => {
          exec(
            'taskkill /F /IM python.exe /FI "WINDOWTITLE eq *uvicorn*"',
            () => resolve()
          );
        });
      } catch (err) {
        // Ignore errors
      }
    } else {
      // Unix: kill by pattern - run commands separately for reliability
      try {
        const { exec } = await import('child_process');
        await new Promise((resolve) => {
          exec('pkill -9 -f "uvicorn.*run_fastapi"', () => {
            exec('pkill -9 -f "bin/start-dev-fastapi"', () => resolve());
          });
        });
      } catch (err) {
        // Ignore errors
      }

      // Also kill by port
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
    console.log('[SUCCESS] Servers stopped');
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
   * @returns {Promise<string>} Path to temporary env file
   */
  async createTempEnvFile(webdavConfig) {
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
        : ['run', 'python', 'bin/start-dev-fastapi'];

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
        ['-c', `PYTHONUNBUFFERED=1 HOST=${this.host} PORT=${this.port} FASTAPI_CONFIG_DIR="${configDir}" uv run python bin/start-dev-fastapi >> "${this.logFile}" 2>&1`],
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
    this.tempEnvFile = await this.createTempEnvFile(webdavConfig);
    process.env.FASTAPI_ENV_FILE = this.tempEnvFile;
    console.log(`[INFO] Set FASTAPI_ENV_FILE=${this.tempEnvFile}\n`);

    // Apply any additional environment variables
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
      console.log(`[INFO] Stopping FastAPI server (PID: ${this.serverProcess.pid})`);
      try {
        if (platform() === 'win32') {
          // Windows: kill process tree
          const { exec } = await import('child_process');
          await new Promise((resolve) => {
            exec(`taskkill /F /T /PID ${this.serverProcess.pid}`, () => resolve());
          });
        } else {
          // Unix: kill entire process tree (parent + all children)
          const { exec } = await import('child_process');
          const pid = this.serverProcess.pid;

          // Use process group kill to terminate all related processes
          // Run pkill commands separately for more reliable execution
          await new Promise((resolve) => {
            exec('pkill -9 -f "uvicorn.*run_fastapi"', () => {
              exec('pkill -9 -f "bin/start-dev-fastapi"', () => {
                // Also try to kill the parent process directly
                try {
                  process.kill(pid, 'SIGKILL');
                } catch (err) {
                  // Process may already be dead
                }
                resolve();
              });
            });
          });

          // Wait for processes to die (SIGKILL should be immediate but give it time)
          await new Promise((resolve) => setTimeout(resolve, 2000));

          // Wait for parent process to exit
          if (this.serverProcess && this.serverProcess.exitCode === null) {
            await new Promise((resolve) => {
              const timeout = setTimeout(() => resolve(), 2000);
              this.serverProcess?.once('exit', () => {
                clearTimeout(timeout);
                resolve();
              });
            });
          }
        }
      } catch (err) {
        // Ignore errors
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
