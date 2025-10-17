#!/usr/bin/env node

/**
 * Unified Backend Test Runner
 *
 * Orchestrates backend integration test execution with pluggable server managers.
 * Supports two execution modes:
 * - Local mode (--local): Fast iteration with local FastAPI server
 * - Container mode (--container): Isolated testing with containerized server
 *
 * Usage:
 *   # Run all backend tests with local server (default)
 *   node tests/backend-test-runner.js
 *   node tests/backend-test-runner.js --local
 *
 *   # Run specific tests
 *   node tests/backend-test-runner.js --grep validation
 *   node tests/backend-test-runner.js --grep-invert "slow tests"
 *
 *   # Container mode for CI
 *   node tests/backend-test-runner.js --container
 *
 *   # Fast iteration (keep database)
 *   node tests/backend-test-runner.js --keep-db --grep auth
 *
 *   # Debug mode (keep server running)
 *   node tests/backend-test-runner.js --no-cleanup --verbose
 *
 *   # Custom test directory
 *   node tests/backend-test-runner.js --test-dir fastapi_app/tests/backend
 *
 *   # Load environment from file
 *   node tests/backend-test-runner.js --env-file .env.testing
 *   node tests/backend-test-runner.js --env-file .env --env DEBUG=1
 *
 * Environment Variables:
 *   CI=true - Automatically use container mode
 */

import { spawn } from 'child_process';
import { glob } from 'glob';
import { fileURLToPath } from 'url';
import { dirname, join, relative, resolve } from 'path';
import { existsSync } from 'fs';
import dotenv from 'dotenv';
import { LocalServerManager } from './lib/local-server-manager.js';
import { ContainerServerManager } from './lib/container-server-manager.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = dirname(__dirname);

/**
 * Parse command line arguments
 *
 * @returns {Object} Parsed options
 */
function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    mode: 'local', // 'local' or 'container'
    grep: null,
    grepInvert: null,
    cleanDb: true,
    noCleanup: false,
    verbose: false,
    noRebuild: false,
    testDir: null,
    env: {},
    envFile: null,
    timeout: 30 * 1000, // 30 seconds default
  };

  // Auto-detect CI environment
  if (process.env.CI === 'true') {
    options.mode = 'container';
  }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    switch (arg) {
      case '--local':
        options.mode = 'local';
        break;
      case '--container':
        options.mode = 'container';
        break;
      case '--grep':
        options.grep = args[++i];
        break;
      case '--grep-invert':
        options.grepInvert = args[++i];
        break;
      case '--keep-db':
        options.cleanDb = false;
        break;
      case '--no-cleanup':
        options.noCleanup = true;
        break;
      case '--verbose':
      case '-v':
        options.verbose = true;
        break;
      case '--no-rebuild':
        options.noRebuild = true;
        break;
      case '--test-dir':
        options.testDir = args[++i];
        break;
      case '--env-file':
        options.envFile = args[++i];
        break;
      case '--env':
        const envSpec = args[++i];
        if (envSpec.includes('=')) {
          const [key, ...valueParts] = envSpec.split('=');
          options.env[key] = valueParts.join('=');
        } else {
          // Pass through from environment
          if (process.env[envSpec]) {
            options.env[envSpec] = process.env[envSpec];
          }
        }
        break;
      case '--timeout':
        options.timeout = parseInt(args[++i], 10) * 1000; // Convert seconds to ms
        break;
      case '--help':
      case '-h':
        printHelp();
        process.exit(0);
        break;
      default:
        console.error(`Unknown option: ${arg}`);
        printHelp();
        process.exit(1);
    }
  }

  return options;
}

/**
 * Load environment variables from a .env file
 *
 * @param {string} envFilePath - Path to .env file (relative or absolute)
 * @returns {Object} Environment variables as key-value pairs
 * @throws {Error} If file doesn't exist
 */
function loadEnvFile(envFilePath) {
  const resolvedPath = resolve(projectRoot, envFilePath);

  if (!existsSync(resolvedPath)) {
    throw new Error(`Environment file not found: ${resolvedPath}`);
  }

  console.log(`📄 Loading environment from: ${relative(projectRoot, resolvedPath)}`);

  const result = dotenv.config({ path: resolvedPath });

  if (result.error) {
    throw new Error(`Failed to parse environment file: ${result.error.message}`);
  }

  return result.parsed || {};
}

/**
 * Print help message
 */
function printHelp() {
  console.log(`
Unified Backend Test Runner

Usage: node tests/backend-test-runner.js [options]

Modes:
  --local              Use local server (default, fast iteration)
  --container          Use containerized server (CI-ready)

Test Selection:
  --grep <pattern>     Only run tests matching pattern
  --grep-invert <pat>  Exclude tests matching pattern
  --test-dir <path>    Test directory (default: auto-detect)

Server Options:
  --clean-db           Wipe database before tests (default, local only)
  --keep-db            Keep existing database (faster, local only)
  --no-cleanup         Keep server running after tests (debug mode)
  --no-rebuild         Skip image rebuild (container only)
  --verbose, -v        Show server output during tests

Environment:
  --env-file <path>    Load environment variables from .env file
  --env VAR_NAME       Pass environment variable from host
  --env VAR=value      Set environment variable (overrides --env-file)
  --timeout <seconds>  Test timeout in seconds (default: 60)

Examples:
  # Run all tests with local server
  node tests/backend-test-runner.js

  # Run validation tests only
  node tests/backend-test-runner.js --grep validation

  # Fast iteration with database kept
  node tests/backend-test-runner.js --keep-db --grep auth

  # Debug mode (keep server running)
  node tests/backend-test-runner.js --no-cleanup --verbose

  # Container mode for CI
  node tests/backend-test-runner.js --container

  # Run specific test directory
  node tests/backend-test-runner.js --test-dir fastapi_app/tests/backend

  # Load environment from file
  node tests/backend-test-runner.js --env-file .env.testing
  node tests/backend-test-runner.js --env-file .env --env DEBUG=1
`);
}

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
      const pattern = join(dir, '**', '*.test.js');
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
    const testProcess = spawn('node', ['--test', ...testFiles], {
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
  const options = parseArgs();

  console.log('🧪 Backend Test Runner');
  console.log(`📦 Mode: ${options.mode}`);
  console.log(`📁 Project root: ${projectRoot}`);
  console.log();

  // Load environment file if provided
  if (options.envFile) {
    try {
      const envVars = loadEnvFile(options.envFile);
      // Merge with explicitly provided --env options (--env takes precedence)
      Object.assign(options.env, { ...envVars, ...options.env });
      console.log(`✅ Loaded ${Object.keys(envVars).length} environment variables`);
      console.log();
    } catch (err) {
      console.error(`❌ Failed to load environment file: ${err.message}`);
      process.exit(1);
    }
  }

  let serverManager;
  let exitCode = 0;

  try {
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
      serverManager = new LocalServerManager();
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
