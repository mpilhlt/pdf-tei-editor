#!/usr/bin/env node

/**
 * Unified Backend Test Runner
 *
 * Orchestrates backend integration test execution with pluggable server managers.
 * Supports two execution modes:
 * - Local mode (--local): Fast iteration with local FastAPI server
 * - Container mode (--container): Isolated testing with containerized server
 *
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
import { ContainerServerManager } from './lib/container-server-manager.js';
import { createTestRunnerCommand, processEnvArgs, resolveMode, validateFixture } from './lib/cli-builder.js';
import { loadEnvFile } from './lib/env-loader.js';
import { loadFixture, importFixtureFiles } from './lib/fixture-loader.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = dirname(__dirname);

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
    '# Container mode for CI',
    'node tests/backend-test-runner.js --container',
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
    console.log(`🔍 Filtered to ${filtered.length} tests matching: ${grep}`);
  }

  if (grepInvert) {
    const invertRegex = new RegExp(grepInvert, 'i');
    filtered = filtered.filter((test) => !invertRegex.test(test));
    console.log(`🔍 Excluded ${tests.length - filtered.length} tests matching: ${grepInvert}`);
  }

  return filtered;
}

/**
 * Run tests using Node.js test runner
 *
 * @param {string[]} testFiles - Test file paths
 * @param {string} baseUrl - Server base URL (E2E_BASE_URL)
 * @param {number} timeout - Test timeout in milliseconds (default: 60 seconds)
 * @returns {Promise<number>} Exit code
 */
async function runTests(testFiles, baseUrl, timeout = 60 * 1000) {
  console.log('\n==> Running backend integration tests');
  console.log(`📋 Base URL: ${baseUrl}`);
  console.log(`📋 Test files: ${testFiles.length}`);
  console.log(`⏱️  Timeout: ${timeout / 1000}s`);

  for (const testFile of testFiles) {
    console.log(`  - ${relative(projectRoot, testFile)}`);
  }

  console.log();

  return new Promise((resolve) => {
    const testProcess = spawn('node', ['--test', '--test-concurrency=1', ...testFiles], {
      cwd: projectRoot,
      stdio: 'inherit',
      env: {
        ...process.env,
        E2E_BASE_URL: baseUrl,
      },
    });

    // Set up timeout to kill stalled tests
    const timeoutId = setTimeout(() => {
      console.error(`\n❌ Tests timed out after ${timeout / 1000}s - killing process`);
      testProcess.kill('SIGTERM');

      // Force kill if it doesn't respond to SIGTERM
      setTimeout(() => {
        if (!testProcess.killed) {
          console.error('⚠️  Process did not respond to SIGTERM, forcing SIGKILL');
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
      console.error(`❌ Failed to run tests: ${err.message}`);
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

  console.log('🧪 Backend API Test Runner');
  console.log(`📦 Mode: ${mode}`);
  console.log(`📁 Project root: ${projectRoot}`);
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
    console.log('==> Discovering tests');
    const allTests = await discoverTests(options.testDir);

    if (allTests.length === 0) {
      console.error('❌ No test files found');
      process.exit(1);
    }

    console.log(`✅ Found ${allTests.length} test files`);

    // Step 2: Filter tests
    const filteredTests = filterTests(allTests, options.grep, options.grepInvert);

    if (filteredTests.length === 0) {
      console.error('❌ No tests match the filter criteria');
      process.exit(1);
    }

    console.log(`✅ Running ${filteredTests.length} test files`);
    console.log();

    // Check if any tests need WebDAV
    const needsWebdav = filteredTests.some((test) => test.includes('sync'));

    // Step 3: Initialize server manager
    if (options.mode === 'local') {
      // Pass DB_DIR, DATA_ROOT, and LOG_DIR from environment to LocalServerManager
      // so it wipes the correct directories and logs to the right location
      const managerOptions = {
        dbDir: options.env.DB_DIR,
        dataRoot: options.env.DATA_ROOT,
        logDir: options.env.LOG_DIR,
      };
      serverManager = new LocalServerManager(managerOptions);
    } else {
      serverManager = new ContainerServerManager();
    }

    console.log(`==> Starting ${serverManager.getType()} server`);

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
    console.log('\n==> Test Results');
    if (exitCode !== 0) {
      console.error(`❌ Tests FAILED with exit code ${exitCode}`);
      if (options.mode === 'local') {
        console.log(`\n📋 Server log: ${serverManager.logFile}`);
      }
    } else {
      console.log('✅ All tests PASSED!');
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    console.error(`❌ Test runner failed: ${errorMessage}`);
    if (err instanceof Error && err.stack) {
      console.error(err.stack);
    }
    exitCode = 1;
  } finally {
    // Step 7: Cleanup
    if (serverManager) {
      try {
        await serverManager.stop({ keepRunning: options.noCleanup });
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        console.error(`⚠️ Error during cleanup: ${errorMessage}`);
      }
    }
  }

  process.exit(exitCode);
}

// Handle signals
process.on('SIGINT', async () => {
  console.log('\n⚠️ Interrupted by user');
  process.exit(130);
});

process.on('SIGTERM', async () => {
  console.log('\n⚠️ Terminated');
  process.exit(143);
});

// Run
main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
