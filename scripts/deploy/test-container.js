#!/usr/bin/env node

/**
 * Container Test Runner
 *
 * Runs tests inside a container using the 'ci' Docker target.
 * - Builds container image (with optional --no-cache)
 * - Runs all tests inside container
 * - Streams test output to console in real-time
 * - Exits with container's exit code
 *
 * Usage:
 *   node bin/test-container.js [--no-cache] [test args...]
 *   npm run test:container [-- [--no-cache] [test args...]]
 *
 * Examples:
 *   npm run test:container
 *   npm run test:container -- --no-cache
 *   npm run test:container -- --all
 *   npm run test:container -- path/to/changed/file.js
 *   npm run test:container -- --no-cache --all
 */

import { spawn, execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = dirname(__dirname);

/**
 * Detect container tool (podman or docker)
 * @returns {string}
 */
function detectContainerTool() {
  try {
    execSync('podman --version', { stdio: 'ignore' });
    console.log('[INFO] Using podman as container tool');
    return 'podman';
  } catch {
    // podman not found, try docker
  }

  try {
    execSync('docker --version', { stdio: 'ignore' });
    console.log('[INFO] Using docker as container tool');
    return 'docker';
  } catch {
    // docker not found
  }

  console.error('[ERROR] Neither podman nor docker found. Please install one of them.');
  process.exit(1);
}

/**
 * Build container image
 * @param {string} containerCmd
 * @param {boolean} noCache
 */
function buildImage(containerCmd, noCache) {
  const imageName = 'pdf-tei-editor:ci';

  console.log(`[INFO] Building ${imageName} image...`);
  console.log();

  const buildArgs = [
    'build',
    '--target', 'ci',
    '-t', imageName
  ];

  if (noCache) {
    buildArgs.push('--no-cache');
    console.log('[INFO] Building with --no-cache (all layers will be rebuilt)');
  } else {
    console.log('[INFO] Building with cache (use --no-cache to force rebuild)');
  }

  buildArgs.push('.');

  console.log();

  try {
    execSync(`${containerCmd} ${buildArgs.join(' ')}`, {
      stdio: 'inherit',
      cwd: projectRoot,
    });
    console.log();
    console.log('[SUCCESS] Image built successfully');
  } catch (err) {
    console.error('[ERROR] Failed to build image');
    process.exit(1);
  }
}

/**
 * Run tests in container
 * @param {string} containerCmd
 * @param {string[]} testArgs
 */
function runTests(containerCmd, testArgs) {
  const imageName = 'pdf-tei-editor:ci';

  console.log('[INFO] Running tests in container...');
  console.log(`[INFO] Test arguments: ${testArgs.length > 0 ? testArgs.join(' ') : '(none - running smart test detection)'}`)  ;
  console.log();

  // Run container with --rm for automatic cleanup
  // stdio: 'inherit' ensures real-time streaming of output
  const child = spawn(containerCmd, [
    'run',
    '--rm',
    imageName,
    ...testArgs
  ], {
    stdio: 'inherit', // Stream stdout/stderr to parent process
    cwd: projectRoot,
  });

  child.on('error', (err) => {
    console.error('[ERROR] Failed to run container:', err.message);
    process.exit(1);
  });

  child.on('close', (code) => {
    console.log();
    if (code === 0) {
      console.log('[SUCCESS] All tests passed');
    } else {
      console.error(`[ERROR] Tests failed with exit code ${code}`);
    }
    process.exit(code || 0);
  });
}

/**
 * Main function
 */
function main() {
  console.log('PDF TEI Editor - Container Test Runner');
  console.log('======================================');
  console.log();

  const args = process.argv.slice(2);

  // Check for --no-cache flag
  const noCacheIndex = args.indexOf('--no-cache');
  const noCache = noCacheIndex !== -1;

  // Remove --no-cache from args (it's for build, not test runner)
  const testArgs = noCache ? args.filter((_, i) => i !== noCacheIndex) : args;

  // Detect container tool
  const containerCmd = detectContainerTool();
  console.log();

  // Build image
  buildImage(containerCmd, noCache);
  console.log();

  // Run tests
  runTests(containerCmd, testArgs);
}

main();
