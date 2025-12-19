#!/usr/bin/env node

/**
 * CLI Builder - Shared utilities for test runner command-line interfaces
 *
 * Provides common option definitions and utilities for backend and E2E test runners
 * using Commander.js for automatic help generation and argument validation.
 */

import { Command, Option } from 'commander';
import { existsSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

/**
 * Create a test runner command with common options
 *
 * @param {Object} config - Command configuration
 * @param {string} config.name - Command name
 * @param {string} config.description - Command description
 * @param {Option[]} [config.extraOptions] - Additional runner-specific options
 * @param {string[]} [config.examples] - Array of example command lines
 * @returns {Command} Configured Commander program
 */
export function createTestRunnerCommand(config) {
  const { name, description, extraOptions = [], examples = [] } = config;

  const program = new Command();

  program
    .name(name)
    .description(description)
    .version('1.0.0');

  // Fixture selection
  program
    .option(
      '-f, --fixture <name>',
      'fixture preset to load (minimal|standard|complex)',
      'standard'
    );

  // Environment
  program
    .option(
      '--env-file <path>',
      'load environment from .env file (auto-detected if not specified)'
    )
    .option(
      '--env <VAR[=VALUE]>',
      'set environment variable (can be repeated)',
      collectEnvVars,
      []
    );

  // Test filtering
  program
    .option('-g, --grep <pattern>', 'only run tests matching pattern (matches file paths)')
    .option('--grep-invert <pattern>', 'exclude tests matching pattern (matches file paths)');

  // Test directory
  program
    .option('--test-dir <path>', 'test directory (auto-detected if not specified)');

  // Server options
  program
    .option('--host <host>', 'server host (env vars take precedence)', 'localhost')
    .option('--port <port>', 'server port (env vars take precedence, auto-selects if not specified)')
    .option('--clean-db', 'wipe database before tests (default, local only)', true)
    .option('--keep-db', 'keep existing database (faster, local only)')
    .option('--no-cleanup', 'keep server running after tests (debug mode)')
    .option('--no-rebuild', 'skip image rebuild (container only)');

  // Output options
  program
    .option('-v, --verbose', 'show server output during tests')
    .option('--timeout <seconds>', 'test timeout in seconds', '180');

  // Add runner-specific options
  for (const option of extraOptions) {
    program.addOption(option);
  }

  // Add examples to help text if provided
  if (examples.length > 0) {
    program.addHelpText('after', '\nExamples:\n' + examples.map(ex => `  ${ex}`).join('\n'));
  }

  return program;
}

/**
 * Collector function for --env option (allows multiple values)
 *
 * @param {string} value - Current env argument
 * @param {string[]} previous - Previously collected values
 * @returns {string[]} Updated array
 */
function collectEnvVars(value, previous) {
  return previous.concat([value]);
}

/**
 * Process environment variable arguments into key-value pairs
 *
 * @param {string[]} envArgs - Array of env arguments from --env
 * @returns {Object} Environment variable key-value pairs
 */
export function processEnvArgs(envArgs) {
  const env = {};
  for (const arg of envArgs) {
    if (arg.includes('=')) {
      const [key, ...valueParts] = arg.split('=');
      env[key] = valueParts.join('=');
    } else {
      // Pass through from process.env
      if (process.env[arg]) {
        env[arg] = process.env[arg];
      }
    }
  }
  return env;
}

/**
 * Resolve execution mode from options
 *
 * @param {Object} options - Parsed CLI options
 * @returns {string} 'local', since 'container' mode is no longer supported in this context
 */
export function resolveMode(options) {
  // Default to local
  return 'local';
}

/**
 * Validate fixture name
 *
 * @param {string} fixtureName - Fixture name to validate
 * @param {string} fixturesDir - Fixtures directory (absolute path)
 * @throws {Error} If fixture doesn't exist
 */
export function validateFixture(fixtureName, fixturesDir) {
  if (!existsSync(fixturesDir)) {
    throw new Error(`Fixtures directory not found: ${fixturesDir}`);
  }

  const available = readdirSync(fixturesDir)
    .filter(name => statSync(join(fixturesDir, name)).isDirectory())
    .filter(name => !name.startsWith('.'));

  if (!available.includes(fixtureName)) {
    throw new Error(
      `Fixture '${fixtureName}' not found.\n` +
      `Available fixtures: ${available.join(', ')}`
    );
  }
}
