#!/usr/bin/env node

/**
 * Playwright E2E Test Runner
 *
 * Focused runner for Playwright browser tests with flexible backend options.
 * Backend integration tests are handled by backend-test-runner.js.
 *
 * Modes:
 *   --local      Run Playwright against local FastAPI server (default, fast iteration)
 *   --container  Run Playwright against containerized FastAPI server (CI-ready)
 *
 * Environment Variables:
 *   E2E_BASE_URL - Override base URL for tests
 *   E2E_PORT     - Port for containerized server (default: 8001)
 *
 * Usage:
 *   # Local mode (fast iteration)
 *   node tests/e2e-runner.js
 *   node tests/e2e-runner.js --local --browser firefox --headed
 *
 *   # Container mode (CI-ready)
 *   node tests/e2e-runner.js --container
 *   node tests/e2e-runner.js --container --grep "upload"
 *
 *   # Debug with local server
 *   node tests/e2e-runner.js --local --headed --debugger --verbose
 */

import { spawn, execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { LocalServerManager } from './lib/local-server-manager.js';
import { ContainerServerManager } from './lib/container-server-manager.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = dirname(__dirname);

/**
 * Playwright E2E test runner with flexible backend
 */
class PlaywrightRunner {
  constructor() {
    /** @type {LocalServerManager | ContainerServerManager | null} */
    this.serverManager = null;
    this.mode = 'local'; // default to local mode
  }

  /**
   * Parse command line arguments
   * @param {string[]} args
   */
  parseArgs(args) {
    const parsed = {
      mode: 'local',
      browser: 'chromium',
      headed: false,
      debugger: false,
      debugMessages: false,
      grep: /** @type {string | null} */ (null),
      grepInvert: /** @type {string | null} */ (null),
      help: false,
      noRebuild: false,
      cleanDb: true,
      verbose: false,
      noCleanup: false,
      workers: 1,
      failFast: false,
      envFile: /** @type {string | null} */ (null),
      envVars: /** @type {Record<string, string>} */ ({}),
    };

    for (let i = 0; i < args.length; i++) {
      const arg = args[i];

      switch (arg) {
        case '--local':
          parsed.mode = 'local';
          break;
        case '--container':
          parsed.mode = 'container';
          break;
        case '--browser':
          parsed.browser = args[++i];
          break;
        case '--headed':
          parsed.headed = true;
          break;
        case '--debugger':
          parsed.debugger = true;
          break;
        case '--debug-messages':
          parsed.debugMessages = true;
          break;
        case '--grep':
          parsed.grep = args[++i] || '';
          break;
        case '--grep-invert':
          parsed.grepInvert = args[++i] || '';
          break;
        case '--no-rebuild':
          parsed.noRebuild = true;
          break;
        case '--clean-db':
          parsed.cleanDb = true;
          break;
        case '--keep-db':
          parsed.cleanDb = false;
          break;
        case '--verbose':
        case '-v':
          parsed.verbose = true;
          break;
        case '--no-cleanup':
          parsed.noCleanup = true;
          break;
        case '--workers':
          parsed.workers = Number(args[++i]);
          if (isNaN(parsed.workers)) {
            throw new Error('--workers option must be a number');
          }
          break;
        case '--fail-fast':
          parsed.failFast = true;
          break;
        case '--env-file':
          parsed.envFile = args[++i];
          break;
        case '--env':
          const envArg = args[++i];
          if (envArg) {
            if (envArg.includes('=')) {
              const [key, ...valueParts] = envArg.split('=');
              parsed.envVars[key] = valueParts.join('=');
            } else {
              // Pass through from environment
              if (process.env[envArg]) {
                parsed.envVars[envArg] = process.env[envArg];
              }
            }
          }
          break;
        case '--help':
        case '-h':
          parsed.help = true;
          break;
      }
    }

    return parsed;
  }

  /**
   * Show help message
   */
  showHelp() {
    console.log('Playwright E2E Test Runner');
    console.log('===========================');
    console.log('');
    console.log('Run Playwright browser tests against local or containerized backend.');
    console.log('Backend integration tests are handled by backend-test-runner.js.');
    console.log('');
    console.log('Usage:');
    console.log('  node tests/e2e-runner.js [mode] [options]');
    console.log('');
    console.log('Modes:');
    console.log('  --local              Use local FastAPI server (default, fast iteration)');
    console.log('  --container          Use containerized FastAPI server (CI-ready)');
    console.log('');
    console.log('Playwright Options:');
    console.log('  --browser <name>     Browser to use (chromium|firefox|webkit) [default: chromium]');
    console.log('  --headed             Run tests in headed mode (show browser)');
    console.log('  --debugger           Enable Playwright debugger (step-through debugging)');
    console.log('  --debug-messages     Enable verbose E2E debug output');
    console.log('  --grep <pattern>     Run tests matching pattern');
    console.log('  --grep-invert <pat>  Exclude tests matching pattern');
    console.log('  --workers <number>   Number of workers (default: 1, sequential)');
    console.log('  --fail-fast          Abort on first test failure');
    console.log('');
    console.log('Server Options:');
    console.log('  --clean-db           Wipe database before tests (default, local only)');
    console.log('  --keep-db            Keep existing database (faster, local only)');
    console.log('  --no-rebuild         Skip image rebuild (container only)');
    console.log('  --no-cleanup         Keep server running after tests (debug mode)');
    console.log('  --verbose, -v        Show server output during tests');
    console.log('');
    console.log('Environment:');
    console.log('  --env-file <path>    Load environment from .env file');
    console.log('  --env VAR_NAME       Pass environment variable from host');
    console.log('  --env VAR=value      Set environment variable');
    console.log('');
    console.log('Examples:');
    console.log('  # Fast local iteration');
    console.log('  node tests/e2e-runner.js');
    console.log('  node tests/e2e-runner.js --keep-db --grep "upload"');
    console.log('');
    console.log('  # Debug with browser visible');
    console.log('  node tests/e2e-runner.js --headed --debugger');
    console.log('');
    console.log('  # CI-ready container mode');
    console.log('  node tests/e2e-runner.js --container');
    console.log('  node tests/e2e-runner.js --container --no-rebuild');
    console.log('');
    console.log('  # With environment variables');
    console.log('  node tests/e2e-runner.js --env-file .env.testing');
    console.log('  node tests/e2e-runner.js --env OPENAI_API_KEY');
    console.log('');
  }

  /**
   * Check if Playwright is installed
   */
  async checkPlaywrightInstalled() {
    console.log('🔍 Checking Playwright installation...');
    try {
      execSync('npx playwright --version', { stdio: 'pipe' });
      console.log('✅ Playwright is available');
      return true;
    } catch (error) {
      console.error('❌ Playwright is not installed');
      console.error('');
      console.error('Please install Playwright:');
      console.error('  npm install @playwright/test');
      console.error('  npx playwright install');
      console.error('');
      console.error('Or run: npm install');
      return false;
    }
  }

  /**
   * Start the server (local or containerized)
   * @param {{mode: string, cleanDb: boolean, verbose: boolean, envVars: Record<string, string>, noRebuild: boolean}} options
   */
  async startServer(options) {
    console.log('\n🚀 Starting server...');
    console.log(`📦 Mode: ${options.mode}`);

    if (options.mode === 'local') {
      this.serverManager = new LocalServerManager();
      await this.serverManager.start({
        cleanDb: options.cleanDb,
        verbose: options.verbose,
        env: options.envVars,
        needsWebdav: false, // Playwright tests don't need WebDAV
      });
    } else {
      this.serverManager = new ContainerServerManager();
      await this.serverManager.start({
        rebuild: !options.noRebuild,
        env: options.envVars,
      });
    }

    const baseUrl = this.serverManager.getBaseUrl();
    console.log(`✅ Server ready at ${baseUrl}`);
    return baseUrl;
  }

  /**
   * Run Playwright tests
   * @param {{browser: string, headed: boolean, debugger: boolean, debugMessages: boolean, workers: number, grep: string|null, grepInvert: string|null, failFast: boolean}} options
   */
  async runPlaywrightTests(options) {
    console.log('\n🧪 Running Playwright tests...');
    console.log(`🌐 Browser: ${options.browser}`);
    console.log(`👁️  Mode: ${options.headed ? 'headed' : 'headless'}`);

    // Build Playwright command
    const cmd = ['playwright', 'test'];

    if (options.browser) {
      cmd.push(`--project=${options.browser}`);
    }
    if (options.headed) {
      cmd.push('--headed');
    }
    if (options.debugger) {
      cmd.push('--debug');
    }
    if (options.workers) {
      cmd.push('--workers', String(options.workers));
    }
    if (options.grep) {
      cmd.push('--grep', options.grep);
    }
    if (options.grepInvert) {
      cmd.push('--grep-invert', options.grepInvert);
    }
    if (options.failFast) {
      cmd.push('--max-failures=1');
    }

    console.log(`🚀 Executing: npx ${cmd.join(' ')}`);

    // Get base URL from server manager
    const baseUrl = this.serverManager?.getBaseUrl();

    // Run Playwright tests
    const testProcess = spawn('npx', cmd, {
      stdio: 'inherit',
      cwd: projectRoot,
      env: {
        ...process.env,
        E2E_BASE_URL: baseUrl,
        E2E_DEBUG: options.debugMessages ? 'true' : 'false',
      },
    });

    return new Promise((resolve, reject) => {
      testProcess.on('exit', (code) => {
        if (code === 0) {
          console.log('\n🎉 All Playwright tests passed!');
          resolve(code);
        } else {
          console.log('\n💥 Some Playwright tests failed!');
          reject(new Error(`Tests failed with exit code ${code}`));
        }
      });

      testProcess.on('error', (error) => {
        console.error('\n💥 Playwright process error:', error.message);
        reject(error);
      });
    });
  }

  /**
   * Stop the server
   * @param {{noCleanup: boolean}} options
   */
  async stopServer(options) {
    if (this.serverManager) {
      await this.serverManager.stop({
        keepRunning: options.noCleanup,
      });
      this.serverManager = null;
    }
  }

  /**
   * Run the test suite
   * @param {string[]} args
   */
  async run(args) {
    const options = this.parseArgs(args);

    if (options.help) {
      this.showHelp();
      return 0;
    }

    try {
      console.log('🧪 Playwright E2E Test Runner');
      console.log('==============================\n');

      // Check Playwright installation
      const hasPlaywright = await this.checkPlaywrightInstalled();
      if (!hasPlaywright) {
        return 1;
      }

      // Start server
      await this.startServer(options);

      // Run tests
      await this.runPlaywrightTests(options);

      // Stop server
      await this.stopServer(options);

      return 0;
    } catch (error) {
      console.error('💥 Playwright runner failed:', String(error));

      // Ensure cleanup
      await this.stopServer({ noCleanup: false });

      return 1;
    }
  }
}

// Main execution
async function main() {
  const runner = new PlaywrightRunner();

  // Setup cleanup handlers
  const cleanup = async () => {
    await runner.stopServer({ noCleanup: false });
    process.exit(1);
  };

  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  const exitCode = await runner.run(process.argv.slice(2));
  process.exit(exitCode);
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error('Unexpected error:', error.message);
    process.exit(1);
  });
}

// Export for use as module
export { PlaywrightRunner };
