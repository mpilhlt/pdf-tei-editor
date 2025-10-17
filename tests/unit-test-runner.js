#!/usr/bin/env node
/**
 * JavaScript Unit Test Runner
 *
 * Thin wrapper around Node's built-in test runner that allows for
 * additional configuration and behavior.
 *
 * Usage:
 *   node tests/unit-test-runner.js [options] [test-files...]
 *
 * Options:
 *   --tap         Output in TAP format
 *   --reporter    Specify test reporter (default: spec)
 */

import { spawn } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = dirname(__dirname);

// Parse arguments
const args = process.argv.slice(2);
const tapMode = args.includes('--tap');
const testFiles = args.filter(arg => !arg.startsWith('--'));

// Default to all JS unit tests if no files specified
const testsToRun = testFiles.length > 0
  ? testFiles
  : ['tests/unit/js/**/*.test.js'];

// Build node test command
const nodeArgs = [
  '--test',
  ...(tapMode ? ['--test-reporter=tap'] : []),
  ...testsToRun
];

// Run tests
const proc = spawn('node', nodeArgs, {
  cwd: projectRoot,
  stdio: 'inherit',
  shell: false
});

proc.on('exit', (code) => {
  process.exit(code);
});

proc.on('error', (err) => {
  console.error('Failed to run tests:', err);
  process.exit(1);
});
