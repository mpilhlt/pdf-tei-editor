#!/usr/bin/env node

/**
 * Unified Backend Test Runner
 *
 * Orchestrates backend integration test execution with pluggable server managers.
 * Features:
 * - Dynamic fixture selection (--fixture minimal|standard)
 * - Automatic .env file detection from test directories
 * - Commander.js for automatic help generation
 *
 * Run with --help to see all options and examples.
 *
 * Environment Variables:
 *   CI=true - Automatically use container mode
 */

import { spawn } from 'child_process';
import { glob } from 'glob';
import { fileURLToPath } from 'url';
import { dirname, join, relative, resolve } from 'path';
import { LocalServerManager } from './lib/local-server-manager.js';
// import { ContainerServerManager } from './lib/container-server-manager.js'; // Removed - not used in new container approach
import { createTestRunnerCommand, processEnvArgs, resolveMode, validateFixture } from './lib/cli-builder.js';
import { loadEnvFile } from './lib/env-loader.js';
import { loadFixture, importFixtureFiles } from './lib/fixture-loader.js';
import { TestLogger } from './api/helpers/test-logger.js';


const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = dirname(__dirname);

// Create logger instance
const logger = new TestLogger();

// Create Commander program with examples
const program = createTestRunnerCommand({
  name: 'backend-test-runner',
  description: 'Run backend API integration tests with local or containerized server',
  examples: [
    '# Run all tests with local server',
    'node tests/backend-test-runner.js',
    '',
    '# Run validation tests only',
    'node tests/backend-test-runner.js --grep validation',
    '',
    '# Fast iteration with database kept',
    'node tests/backend-test-runner.js --keep-db --grep auth',
    '',
    '# Debug mode (keep server running)',
    'node tests/backend-test-runner.js --no-cleanup --verbose',
    '',
    '# Run specific test directory',
    'node tests/backend-test-runner.js --test-dir tests/api/v1',
    '',
    '# Use minimal fixture for smoke tests',
    'node tests/backend-test-runner.js --fixture minimal',
    '',
    '# Load environment from file',
    'node tests/backend-test-runner.js --env-file .env.testing',
    'node tests/backend-test-runner.js --env-file .env --env DEBUG=1',
  ],
});

// Parse arguments - Commander handles --help automatically
program.parse(process.argv);
const cliOptions = program.opts();


/**
 * Discover test files from the test directory
 *
 * @param {string|null} testDir - Test directory (null for auto-detect)
 * @returns {Promise<string[]>} Array of test file paths
 */
async function discoverTests(testDir = null) {
  const defaultDirs = [
    join(projectRoot, 'tests', 'api'), // Phase 9: API tests (v0, v1)
    join(projectRoot, 'fastapi_app', 'tests', 'backend'), // Legacy FastAPI tests
    join(projectRoot, 'tests', 'e2e', 'backend'), // Legacy E2E backend tests
  ];

  const searchDirs = testDir ? [join(projectRoot, testDir)] : defaultDirs;

  const allTests = [];

  for (const dir of searchDirs) {
    try {
      // Normalize to forward slashes for glob (required on Windows)
      const pattern = join(dir, '**', '*.test.js').replace(/\\/g, '/');
      const files = await glob(pattern);
      allTests.push(...files);
    } catch (err) {
      // Directory doesn't exist, skip
    }
  }

  return allTests;
}

/**
 * Filter tests by grep patterns
 *
 * @param {string[]} tests - Test file paths
 * @param {string|null} grep - Include pattern
 * @param {string|null} grepInvert - Exclude pattern
 * @returns {string[]} Filtered test file paths
 */
function filterTests(tests, grep = null, grepInvert = null) {
  let filtered = tests;

  if (grep) {
    const grepRegex = new RegExp(grep, 'i');
    filtered = filtered.filter((test) => grepRegex.test(test));
    logger.info(`Filtered to ${filtered.length} tests matching: ${grep}`);
  }

  if (grepInvert) {
    const invertRegex = new RegExp(grepInvert, 'i');
    filtered = filtered.filter((test) => !invertRegex.test(test));
    logger.info(`Excluded ${tests.length - filtered.length} tests matching: ${grepInvert}`);
  }

  return filtered;
}

/**
 * Run tests using Node.js test runner
 *
 * @param {string[]} testFiles - Test file paths
 * @param {string} baseUrl - Server base URL (E2E_BASE_URL)
 * @param {number} timeout - Test timeout in milliseconds (default: 180 seconds)
 * @returns {Promise<number>} Exit code
 */
async function runTests(testFiles, baseUrl, timeout = 180 * 1000) {
  logger.info('Running backend integration tests');
  logger.info(`Base URL: ${baseUrl}`);
  logger.info(`Test files: ${testFiles.length}`);
  logger.info(`Timeout: ${timeout / 1000}s`);

  for (const testFile of testFiles) {
    console.log(`  - ${relative(projectRoot, testFile)}`);
  }

  console.log();

  return new Promise((resolve) => {
    let lastTestName = null;
    let lastTestFile = null;
    let lastOutput = [];
    const maxOutputLines = 50;
    const runningTests = new Map(); // Map of test name -> start time

    const testProcess = spawn('node', ['--test', '--test-concurrency=1', ...testFiles], {
      cwd: projectRoot,
      stdio: ['inherit', 'pipe', 'pipe'],
      env: {
        ...process.env,
        E2E_BASE_URL: baseUrl,
      },
    });

    // Capture stdout and track test progress
    testProcess.stdout.on('data', (data) => {
      const output = data.toString();
      process.stdout.write(output);

      // Track last N lines for timeout diagnostics
      const lines = output.split('\n');
      lastOutput.push(...lines);
      if (lastOutput.length > maxOutputLines) {
        lastOutput = lastOutput.slice(-maxOutputLines);
      }

      // Parse test runner output to track current test
      // Node test runner format:
      // - "▶ test name" when starting (suite name)
      // - "  ✔ test name (Xms)" when passing (individual test)
      // - "  ✖ test name (Xms)" when failing
      // - "✔ suite name (Xms)" when suite completes
      // - "# Subtest: file.test.js" for test file
      const testStartMatch = output.match(/▶\s+(.+)/);
      const testPassMatch = output.match(/^\s+✔\s+(.+?)\s+\(/m);
      const testFailMatch = output.match(/^\s+✖\s+(.+?)\s+\(/m);
      const suiteCompleteMatch = output.match(/^✔\s+(.+?)\s+\(/m);
      const fileMatch = output.match(/# Subtest:\s+(.+)/);

      if (fileMatch) {
        lastTestFile = fileMatch[1];
        lastTestName = null; // Reset test name when entering new file
      }
      if (testStartMatch) {
        const testName = testStartMatch[1];
        lastTestName = testName;
        runningTests.set(testName, Date.now());
      }
      if (testPassMatch || testFailMatch) {
        const testName = (testPassMatch || testFailMatch)[1];
        // Don't clear lastTestName yet - might be in middle of suite
      }
      if (suiteCompleteMatch) {
        const suiteName = suiteCompleteMatch[1];
        runningTests.delete(suiteName);
        lastTestName = null;
      }
    });

    // Capture stderr
    testProcess.stderr.on('data', (data) => {
      const output = data.toString();
      process.stderr.write(output);

      // Track stderr output too
      const lines = output.split('\n');
      lastOutput.push(...lines.map(line => `[stderr] ${line}`));
      if (lastOutput.length > maxOutputLines) {
        lastOutput = lastOutput.slice(-maxOutputLines);
      }
    });

    // Set up timeout to kill stalled tests
    const timeoutId = setTimeout(() => {
      console.error(''); // Empty line before error
      logger.error(`Tests timed out after ${timeout / 1000}s - killing process`);

      if (lastTestFile) {
        logger.error(`Last test file: ${lastTestFile}`);
      }

      // Show running test suites (only show the longest running one)
      if (runningTests.size > 0) {
        // Find the longest-running suite
        let longestSuite = null;
        let longestDuration = 0;
        for (const [testName, startTime] of runningTests.entries()) {
          const duration = (Date.now() - startTime) / 1000;
          if (duration > longestDuration) {
            longestDuration = duration;
            longestSuite = testName;
          }
        }
        if (longestSuite) {
          logger.error(`Test suite still running: ${longestSuite} (${longestDuration.toFixed(1)}s)`);
          logger.error(`Note: ${runningTests.size - 1} other suite(s) also in progress`);
        }
      } else if (lastTestName) {
        logger.error(`Last test suite: ${lastTestName}`);
      } else if (lastTestFile) {
        logger.error(`Test may have hung after completion or during setup/teardown`);
      }

      // Show last output for debugging
      if (lastOutput.length > 0) {
        logger.info(`\nLast ${lastOutput.length} lines of output:`);
        lastOutput.forEach(line => {
          if (line.trim()) console.log(`  ${line}`);
        });
      }

      testProcess.kill('SIGTERM');

      // Force kill if it doesn't respond to SIGTERM
      setTimeout(() => {
        if (!testProcess.killed) {
          logger.warn('Process did not respond to SIGTERM, forcing SIGKILL');
          testProcess.kill('SIGKILL');
        }
      }, 5000);

      resolve(124); // Exit code for timeout
    }, timeout);

    testProcess.on('exit', (code) => {
      clearTimeout(timeoutId);
      resolve(code || 0);
    });

    testProcess.on('error', (err) => {
      clearTimeout(timeoutId);
      logger.error(`Failed to run tests: ${err.message}`);
      resolve(1);
    });
  });
}

/**
 * Main test orchestration
 */
async function main() {
  // Resolve mode from CLI options
  const mode = resolveMode(cliOptions);

  // Auto-detect test directory
  const testDir = cliOptions.testDir || 'tests/api/v1';
  const fixturesDir = 'tests/api/fixtures';
  const runtimeDir = 'tests/api/runtime';

  logger.info('================ Backend API Test Runner ================');
  logger.info(`Mode: ${mode}`);
  logger.info(`Project root: ${projectRoot}`);
  console.log();

  let serverManager;
  let exitCode = 0;
  let options; // Declare options at function scope so it's available in finally block

  let fixtureFilesPath = null;

  try {
    // Step 0a: Validate and load fixture config (local mode only)
    if (mode === 'local') {
      validateFixture(cliOptions.fixture, resolve(projectRoot, fixturesDir));
      fixtureFilesPath = await loadFixture({
        fixtureName: cliOptions.fixture,
        fixturesDir,
        runtimeDir,
        projectRoot,
        verbose: cliOptions.verbose,
      });
    }

    // Step 0b: Load environment
    const envFromFile = loadEnvFile({
      envFile: cliOptions.envFile,
      testDir,
      searchDirs: [testDir, 'tests/api/v1', 'tests/api/v0'],
      projectRoot,
      verbose: cliOptions.verbose,
    });

    // Process --env arguments
    const envFromArgs = processEnvArgs(cliOptions.env || []);

    // Merge (--env args take precedence)
    const env = { ...envFromFile, ...envFromArgs };

    // Convert Commander options to internal format
    options = {
      mode,
      grep: cliOptions.grep,
      grepInvert: cliOptions.grepInvert,
      cleanDb: cliOptions.keepDb ? false : cliOptions.cleanDb,
      noCleanup: cliOptions.cleanup === false,
      verbose: cliOptions.verbose,
      noRebuild: cliOptions.rebuild === false,
      testDir,
      env,
      timeout: parseInt(cliOptions.timeout, 10) * 1000,
    };

    // Step 1: Discover tests
    logger.info('Discovering tests');
    const allTests = await discoverTests(options.testDir);

    if (allTests.length === 0) {
      logger.error('No test files found');
      process.exit(1);
    }

    logger.success(`Found ${allTests.length} test files`);

    // Step 2: Filter tests
    const filteredTests = filterTests(allTests, options.grep, options.grepInvert);

    if (filteredTests.length === 0) {
      logger.error('No tests match the filter criteria');
      process.exit(1);
    }

    logger.success(`Running ${filteredTests.length} test files`);
    console.log();

    // Check if any tests need WebDAV
    const needsWebdav = filteredTests.some((test) => test.includes('sync'));

    // Step 3: Initialize server manager
    // Resolve host and port: env vars take precedence over CLI options
    const host = options.env.HOST || options.env.E2E_HOST || cliOptions.host;
    // Only pass port if explicitly set via env var or CLI (not default)
    const portFromEnv = options.env.PORT || options.env.E2E_PORT;
    const portFromCli = cliOptions.port !== '8010' ? cliOptions.port : undefined;
    const port = portFromEnv || portFromCli;

    if (options.mode === 'local') {
      // Pass DB_DIR, DATA_ROOT, LOG_DIR, host, and port to LocalServerManager
      // so it wipes the correct directories and logs to the right location
      const managerOptions = {
        dbDir: options.env.DB_DIR,
        dataRoot: options.env.DATA_ROOT,
        logDir: options.env.LOG_DIR,
        host,
        port: port ? parseInt(port, 10) : undefined,
      };
      serverManager = new LocalServerManager(managerOptions);
    } else {
      // Container mode removed - use `npm run test:container` instead
      throw new Error(
        '--container mode is no longer supported. Use `npm run test:container` to run tests inside a container.'
      );
    }

    logger.info(`Starting ${serverManager.getType()} server`);

    // Step 4: Start server
    const startOptions = {
      cleanDb: options.cleanDb,
      verbose: options.verbose,
      noRebuild: options.noRebuild,
      env: options.env,
      needsWebdav: needsWebdav,
    };

    const baseUrl = await serverManager.start(startOptions);

    // Step 4.5: Import fixture files after server is ready (local mode only)
    if (mode === 'local' && fixtureFilesPath) {
      await importFixtureFiles(
        fixtureFilesPath,
        resolve(projectRoot, runtimeDir),
        projectRoot,
        cliOptions.verbose
      );
    }

    // Step 5: Run tests
    exitCode = await runTests(filteredTests, baseUrl, options.timeout);

    // Step 6: Report results
    logger.info('Test Results');
    if (exitCode !== 0) {
      if (exitCode === 124) {
        logger.error(`Tests FAILED: Timeout after ${options.timeout / 1000}s`);
        logger.error(`This usually indicates a hanging test or infinite loop`);
      } else {
        logger.error(`Tests FAILED with exit code ${exitCode}`);
      }
      if (options.mode === 'local') {
        logger.info(`Server log: ${serverManager.logFile}`);
      }
    } else {
      logger.success('All tests PASSED!');
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    logger.error(`Test runner failed: ${errorMessage}`);
    if (err instanceof Error && err.stack) {
      console.error(err.stack);
    }
    exitCode = 1;
  } finally {
    // Step 7: Cleanup
    // Store the test result exit code before cleanup to ensure cleanup errors don't override it
    const testExitCode = exitCode;

    if (serverManager) {
      try {
        await serverManager.stop({ keepRunning: options.noCleanup });
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        logger.warn(`Error during cleanup: ${errorMessage}`);
        // Don't change exit code if tests passed - cleanup errors are non-fatal
      }
    }

    // Restore the test result exit code (in case cleanup modified it somehow)
    exitCode = testExitCode;
  }

  process.exit(exitCode);
}

// Handle signals
process.on('SIGINT', async () => {
  logger.warn('Interrupted by user');
  process.exit(130);
});

process.on('SIGTERM', async () => {
  // SIGTERM during cleanup is expected (from server cleanup killing processes on port)
  // Only log in verbose mode to avoid confusing test output
  if (process.env.VERBOSE) {
    logger.warn('Received SIGTERM during cleanup');
  }
  // Don't exit with non-zero code if we received SIGTERM during normal cleanup
  // The finally block will handle proper cleanup
});

// Run
main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
