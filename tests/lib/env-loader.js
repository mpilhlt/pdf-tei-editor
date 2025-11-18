#!/usr/bin/env node

/**
 * Environment Loader - Utilities for loading .env files with automatic detection
 *
 * Handles environment variable loading with priority system:
 * 1. Explicit --env-file flag
 * 2. .env in --test-dir
 * 3. .env in default search directories
 */

import { existsSync } from 'fs';
import { resolve } from 'path';
import { relative } from 'path';
import dotenv from 'dotenv';
import { logger } from '../api/helpers/test-logger.js';

/**
 * Load environment variables from .env file
 * Handles explicit paths and automatic detection
 *
 * @param {Object} options
 * @param {string} [options.envFile] - Explicit .env file path
 * @param {string} [options.testDir] - Test directory to search
 * @param {string[]} [options.searchDirs] - Default directories to search
 * @param {string} options.projectRoot - Project root directory
 * @param {boolean} [options.verbose] - Show debug output
 * @returns {Object} Environment variables
 */
export function loadEnvFile(options) {
  const { envFile, testDir, searchDirs = [], projectRoot, verbose = false } = options;

  let envPath = null;
  let source = null;

  // Priority 1: Explicit --env-file flag
  if (envFile) {
    envPath = resolve(projectRoot, envFile);
    source = 'explicit --env-file';
    if (!existsSync(envPath)) {
      throw new Error(`Environment file not found: ${envFile}`);
    }
  }

  // Priority 2: .env or .env.test in --test-dir
  if (!envPath && testDir) {
    // Try .env.test first (more specific for testing)
    const testDirEnvTest = resolve(projectRoot, testDir, '.env.test');
    if (existsSync(testDirEnvTest)) {
      envPath = testDirEnvTest;
      source = '--test-dir';
    } else {
      // Fallback to .env
      const testDirEnv = resolve(projectRoot, testDir, '.env');
      if (existsSync(testDirEnv)) {
        envPath = testDirEnv;
        source = '--test-dir';
      } else if (verbose) {
        logger.info(`No .env or .env.test file found in test directory: ${testDir}`);
      }
    }
  }

  // Priority 3: .env or .env.test in default search directories
  if (!envPath) {
    for (const dir of searchDirs) {
      // Try .env.test first
      const searchPathTest = resolve(projectRoot, dir, '.env.test');
      if (existsSync(searchPathTest)) {
        envPath = searchPathTest;
        source = 'default search';
        break;
      }
      // Fallback to .env
      const searchPath = resolve(projectRoot, dir, '.env');
      if (existsSync(searchPath)) {
        envPath = searchPath;
        source = 'default search';
        break;
      }
    }
  }

  if (!envPath) {
    if (verbose) {
      logger.info('No .env file found (not an error)');
    }
    return {}; // No .env file found, not an error
  }

  const relativePath = relative(projectRoot, envPath);
  logger.info(`Loading environment from: ${relativePath} (${source})`);

  const result = dotenv.config({ path: envPath });

  if (result.error) {
    throw new Error(`Failed to parse .env file: ${result.error.message}`);
  }

  if (verbose) {
    const varCount = Object.keys(result.parsed || {}).length;
    logger.success(`Loaded ${varCount} environment variable${varCount !== 1 ? 's' : ''}`);
  }

  return result.parsed || {};
}
