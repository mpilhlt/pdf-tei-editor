#!/usr/bin/env node

/**
 * Playwright E2E Test Runner
 *
 * Focused runner for Playwright browser tests with flexible backend options.
 * Backend integration tests are handled by backend-test-runner.js.
 *
 * Features:
 * - Dynamic fixture selection (--fixture minimal|standard)
 * - Automatic .env file detection from test directories
 * - Commander.js for automatic help generation
 * - Playwright-specific options (browser, headed, debugger)
 *
 * Run with --help to see all options and examples.
 *
 * Environment Variables:
 *   E2E_BASE_URL - Override base URL for tests
 *   E2E_PORT     - Port for containerized server (default: 8001)
 *   CI=true      - Automatically use container mode
 */

import { spawn, execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { Option } from 'commander';
import { LocalServerManager } from './lib/local-server-manager.js';
import { ContainerServerManager } from './lib/container-server-manager.js';
import { createTestRunnerCommand, processEnvArgs, resolveMode, validateFixture } from './lib/cli-builder.js';
import { loadEnvFile } from './lib/env-loader.js';
import { loadFixture, importFixtureFiles } from './lib/fixture-loader.js';
import { logger } from './api/helpers/test-logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = dirname(__dirname);

// Create Commander program with E2E-specific options
const program = createTestRunnerCommand({
  name: 'e2e-runner',
  description: 'Run Playwright E2E tests against local or containerized backend',
  extraOptions: [
    new Option('--browser <name>', 'browser to use')
      .choices(['chromium', 'firefox', 'webkit'])
      .default('chromium'),
    new Option('--headed', 'run tests in headed mode (show browser)'),
    new Option('--debugger', 'enable Playwright debugger'),
    new Option('--debug-messages', 'enable verbose E2E debug output'),
    new Option('--workers <number>', 'number of parallel workers')
      .default('1'),
    new Option('--fail-fast', 'abort on first test failure'),
  ],
  examples: [
    '# Fast local iteration',
    'node tests/e2e-runner.js',
    'node tests/e2e-runner.js --keep-db --grep "upload"',
    '',
    '# Debug with browser visible',
    'node tests/e2e-runner.js --headed --debugger',
    '',
    '# Use minimal fixture for smoke tests',
    'node tests/e2e-runner.js --fixture minimal',
    '',
    '# CI-ready container mode',
    'node tests/e2e-runner.js --container',
    'node tests/e2e-runner.js --container --no-rebuild',
    '',
    '# With environment variables',
    'node tests/e2e-runner.js --env-file .env.testing',
    'node tests/e2e-runner.js --env OPENAI_API_KEY',
  ],
});

// Parse arguments - Commander handles --help automatically
program.parse(process.argv);
const cliOptions = program.opts();

/**
 * @typedef {Object} ServerOptions
 * @property {string} mode - Execution mode ('local' or 'container')
 * @property {string} fixture - Fixture preset name
 * @property {boolean} cleanDb - Whether to wipe database before tests
 * @property {boolean} verbose - Show server output
 * @property {Record<string, string>} envVars - Environment variables from --env
 * @property {string} [envFile] - Path to .env file
 * @property {boolean} noRebuild - Skip image rebuild (container mode)
 */

/**
 * @typedef {Object} PlaywrightOptions
 * @property {string} browser - Browser to use
 * @property {boolean} headed - Run in headed mode
 * @property {boolean} debugger - Enable debugger
 * @property {boolean} debugMessages - Enable debug output
 * @property {number} workers - Number of parallel workers
 * @property {string|null} grep - Test filter pattern
 * @property {string|null} grepInvert - Test exclude pattern
 * @property {boolean} failFast - Abort on first failure
 */

/**
 * Playwright E2E test runner with flexible backend
 */
class PlaywrightRunner {
  constructor() {
    /** @type {LocalServerManager | ContainerServerManager | null} */
    this.serverManager = null;
  }

  /**
   * Check if Playwright is installed
   */
  async checkPlaywrightInstalled() {
    logger.info('Checking Playwright installation...');
    try {
      execSync('npx playwright --version', { stdio: 'pipe' });
      logger.success('Playwright is available');
      return true;
    } catch (error) {
      logger.error('Playwright is not installed');
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
   * Check if application is built and build if necessary
   */
  async ensureApplicationBuilt() {
    const { existsSync, statSync } = await import('fs');
    const appJsPath = resolve(projectRoot, 'app/web/app.js');
    const srcDir = resolve(projectRoot, 'app/src');

    logger.info('Checking if application is built...');

    // Check if build exists
    if (!existsSync(appJsPath)) {
      logger.info('Built application not found, building...');
      execSync('npm run build', { stdio: 'inherit', cwd: projectRoot });
      logger.success('Application built successfully');
      return true;
    }

    // Check if build is outdated (compare timestamps)
    const appJsTime = statSync(appJsPath).mtimeMs;
    let needsRebuild = false;

    // Check if any source files are newer than the build
    try {
      const srcFiles = execSync(`find "${srcDir}" -type f -name "*.js"`, { encoding: 'utf-8' })
        .split('\n')
        .filter(f => f.trim());

      for (const srcFile of srcFiles) {
        if (existsSync(srcFile)) {
          const srcTime = statSync(srcFile).mtimeMs;
          if (srcTime > appJsTime) {
            needsRebuild = true;
            break;
          }
        }
      }
    } catch (error) {
      // If we can't check, assume build is ok
      logger.info('Could not check source file timestamps, assuming build is current');
    }

    if (needsRebuild) {
      logger.info('Source files have changed, rebuilding...');
      execSync('npm run build', { stdio: 'inherit', cwd: projectRoot });
      logger.success('Application rebuilt successfully');
    } else {
      logger.success('Application is already built and up-to-date');
    }

    return true;
  }

  /**
   * Start the server (local or containerized)
   * @param {ServerOptions} options
   */
  async startServer(options) {
    const fixturesDir = 'tests/e2e/fixtures';
    const runtimeDir = 'tests/e2e/runtime';

    console.log('\n🚀 Starting server...');
    logger.info(`Mode: ${options.mode}`);

    // Phase 1: Load fixture config (local mode only)
    let fixtureFilesPath = null;
    if (options.mode === 'local') {
      validateFixture(options.fixture, resolve(projectRoot, fixturesDir));
      fixtureFilesPath = await loadFixture({
        fixtureName: options.fixture,
        fixturesDir,
        runtimeDir,
        projectRoot,
        verbose: options.verbose,
      });
    }

    // Load environment
    const envFromFile = loadEnvFile({
      envFile: options.envFile,
      testDir: 'tests/e2e',
      searchDirs: ['tests/e2e'],
      projectRoot,
      verbose: options.verbose,
    });

    // Merge with explicit --env options (--env takes precedence)
    const env = { ...envFromFile, ...options.envVars };

    if (options.mode === 'local') {
      this.serverManager = new LocalServerManager();
      await this.serverManager.start({
        cleanDb: options.cleanDb,
        verbose: options.verbose,
        env,
        needsWebdav: false, // Playwright tests don't need WebDAV
      });

      // Phase 2: Import fixture files after server is ready
      if (fixtureFilesPath) {
        await importFixtureFiles(
          fixtureFilesPath,
          resolve(projectRoot, runtimeDir),
          projectRoot,
          options.verbose
        );
      }
    } else {
      this.serverManager = new ContainerServerManager();
      await this.serverManager.start({
        rebuild: !options.noRebuild,
        env,
      });
    }

    const baseUrl = this.serverManager.getBaseUrl();
    logger.success(`Server ready at ${baseUrl}`);
    return baseUrl;
  }

  /**
   * Run Playwright tests
   * @param {PlaywrightOptions} options
   */
  async runPlaywrightTests(options) {
    console.log('\n🧪 Running Playwright tests...');
    console.log(`🌐 Browser: ${options.browser}`);
    logger.info(`Mode: ${options.headed ? 'headed' : 'headless'}`);

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

    logger.info(`Executing: npx ${cmd.join(' ')}`);

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
   */
  async run() {
    // Resolve mode from CLI options
    const mode = resolveMode(cliOptions);

    // Process --env arguments
    const envVars = processEnvArgs(cliOptions.env || []);

    // Convert Commander options to internal format
    /** @type {ServerOptions} */
    const serverOptions = {
      mode,
      fixture: cliOptions.fixture,
      cleanDb: cliOptions.keepDb ? false : cliOptions.cleanDb,
      verbose: cliOptions.verbose,
      envVars,
      envFile: cliOptions.envFile,
      noRebuild: cliOptions.rebuild === false,
    };

    /** @type {PlaywrightOptions} */
    const playwrightOptions = {
      browser: cliOptions.browser,
      headed: cliOptions.headed,
      debugger: cliOptions.debugger,
      debugMessages: cliOptions.debugMessages,
      workers: parseInt(cliOptions.workers, 10),
      grep: cliOptions.grep || null,
      grepInvert: cliOptions.grepInvert || null,
      failFast: cliOptions.failFast,
    };

    try {
      console.log('🧪 Playwright E2E Test Runner');
      console.log('==============================\n');

      // Check Playwright installation
      const hasPlaywright = await this.checkPlaywrightInstalled();
      if (!hasPlaywright) {
        return 1;
      }

      // Ensure application is built (E2E tests run against production build)
      const isBuilt = await this.ensureApplicationBuilt();
      if (!isBuilt) {
        return 1;
      }

      // Start server
      await this.startServer(serverOptions);

      // Run tests
      await this.runPlaywrightTests(playwrightOptions);

      // Stop server
      await this.stopServer({ noCleanup: cliOptions.cleanup === false });

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

  const exitCode = await runner.run();
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
