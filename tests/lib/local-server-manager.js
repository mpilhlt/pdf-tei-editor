import { ServerManager } from './server-manager.js';
import { WebdavServerManager } from './webdav-server-manager.js';
import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import { join } from 'path';
import { platform } from 'os';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Local server manager for development and testing.
 *
 * Manages FastAPI server lifecycle on the local machine:
 * - Kills existing servers on port 8000
 * - Optionally wipes database for clean slate
 * - Starts local server via npm run dev:fastapi
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
    this.serverUrl = 'http://localhost:8000';
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
    if (!this.serverProcess) {
      throw new Error('Server is not running');
    }
    return this.serverUrl;
  }

  /**
   * Kill any existing FastAPI/uvicorn servers on port 8000
   *
   * @private
   * @returns {Promise<void>}
   */
  async killExistingServers() {
    console.log('\n==> Killing any running FastAPI servers');

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
      // Unix: kill by pattern
      try {
        const { exec } = await import('child_process');
        await new Promise((resolve) => {
          exec('pkill -9 -f "uvicorn.*fastapi_app"', () => resolve());
        });
      } catch (err) {
        // Ignore errors
      }

      // Also kill by port
      try {
        const { exec } = await import('child_process');
        await new Promise((resolve, reject) => {
          exec('lsof -ti:8000', (err, stdout) => {
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
   * Removes all SQLite database files but preserves JSON fixture files
   * (users.json, config.json, prompt.json) that should already be in place
   * from the fixture loader.
   *
   * @private
   * @returns {Promise<void>}
   */
  async wipeDatabase() {
    console.log('\n==> Wiping database for clean slate');

    // Check if JSON fixture files exist (indicating fixture loader ran)
    const usersJson = join(this.dbDir, 'users.json');
    const fixturesLoaded = await fs.access(usersJson).then(() => true).catch(() => false);

    if (fixturesLoaded) {
      // Fixtures already loaded - just remove SQLite files
      console.log('[INFO] Fixtures detected, removing only SQLite database files');
      const dbFiles = ['metadata.db', 'sessions.db', 'locks.db'];

      for (const dbFile of dbFiles) {
        try {
          const dbPath = join(this.dbDir, dbFile);
          await fs.rm(dbPath, { force: true });
          // Also remove WAL and SHM files
          await fs.rm(`${dbPath}-wal`, { force: true });
          await fs.rm(`${dbPath}-shm`, { force: true });
        } catch (err) {
          // Ignore if doesn't exist
        }
      }
    } else {
      // No fixtures - old behavior for backward compatibility
      console.log('[INFO] No fixtures detected, wiping entire db directory');

      // Remove database directory completely
      try {
        await fs.rm(this.dbDir, { recursive: true, force: true });
        console.log(`[INFO] Removed ${this.dbDir}`);
      } catch (err) {
        // Ignore if doesn't exist
      }

      // Recreate db directory
      await fs.mkdir(this.dbDir, { recursive: true });
    }

    // Also remove old metadata.db in data directory if it exists
    const oldMetadataDb = join(this.dataDir, 'metadata.db');
    try {
      await fs.unlink(oldMetadataDb);
      console.log(`[INFO] Removed old ${oldMetadataDb}`);
    } catch (err) {
      // Ignore if doesn't exist
    }

    console.log('[SUCCESS] Database wiped - starting with clean slate');
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

    const tempFileName = join(
      tmpdir(),
      `fastapi-test-${randomBytes(8).toString('hex')}.env`
    );

    const envContent = `# FastAPI Test Configuration with WebDAV
HOST=127.0.0.1
PORT=8000
DATA_ROOT=fastapi_app/data
DB_DIR=fastapi_app/db

# WebDAV Configuration for Sync Tests
WEBDAV_ENABLED=${webdavConfig.WEBDAV_ENABLED}
WEBDAV_BASE_URL=${webdavConfig.WEBDAV_BASE_URL}
WEBDAV_USERNAME=${webdavConfig.WEBDAV_USERNAME}
WEBDAV_PASSWORD=${webdavConfig.WEBDAV_PASSWORD}
WEBDAV_REMOTE_ROOT=${webdavConfig.WEBDAV_REMOTE_ROOT}

SESSION_TIMEOUT=3600
LOG_LEVEL=INFO
`;

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
    console.log('\n==> Starting FastAPI development server');

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
    if (verbose) {
      this.serverProcess = spawn('npm', ['run', 'dev:fastapi'], {
        cwd: this.projectRoot,
        stdio: 'pipe',
      });

      // If verbose, tee output to both console and log file
      this.serverProcess.stdout?.on('data', (data) => {
        process.stdout.write(data);
        fs.appendFile(this.logFile, data);
      });
      this.serverProcess.stderr?.on('data', (data) => {
        process.stderr.write(data);
        fs.appendFile(this.logFile, data);
      });
    } else {
      // Redirect to log file using shell redirection
      // Use PYTHONUNBUFFERED=1 to ensure Python output isn't buffered
      const { spawn: spawnShell } = await import('child_process');
      this.serverProcess = spawnShell(
        'sh',
        ['-c', `PYTHONUNBUFFERED=1 npm run dev:fastapi >> "${this.logFile}" 2>&1`],
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
    console.log(`\n==> Waiting for server startup (timeout: ${timeoutSec}s)`);

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

    // Step 1: Kill existing servers
    await this.killExistingServers();

    // Step 2: Wipe database (unless cleanDb is false)
    if (cleanDb) {
      await this.wipeDatabase();
    } else {
      console.log('\n==> Keeping existing database (cleanDb=false)');
      console.warn('[WARNING] Tests may fail if database schema is outdated');
    }

    // Step 2.5: Start WebDAV server if needed
    if (needsWebdav) {
      // Create and start WebDAV server manager
      this.webdavManager = new WebdavServerManager();
      await this.webdavManager.start({ verbose });

      // Create temporary .env file with WebDAV configuration
      const webdavConfig = this.webdavManager.getConfig();
      this.tempEnvFile = await this.createTempEnvFile(webdavConfig);
      process.env.FASTAPI_ENV_FILE = this.tempEnvFile;
      console.log(`[INFO] Set FASTAPI_ENV_FILE=${this.tempEnvFile}\n`);
    }

    // Apply any additional environment variables
    Object.assign(process.env, env);

    // Step 3: Start server
    await this.startServerProcess(verbose);

    // Step 4: Wait for startup
    const started = await this.waitForStartup();
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

    console.log('\n==> Cleaning up...');

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
          // Unix: send SIGTERM
          this.serverProcess.kill('SIGTERM');
          await new Promise((resolve) => {
            const timeout = setTimeout(() => {
              this.serverProcess?.kill('SIGKILL');
              resolve();
            }, 5000);
            this.serverProcess?.once('exit', () => {
              clearTimeout(timeout);
              resolve();
            });
          });
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
