#!/usr/bin/env node

/**
 * Fixture Loader - Utilities for loading test fixture presets
 *
 * Manages fixture loading into runtime directories for test execution.
 * Supports multiple fixture presets (minimal, standard, complex).
 *
 * IMPORTANT: Files are imported using FileImporter to ensure they are:
 * - Stored in content-addressable hash-sharded structure
 * - Registered in the metadata database
 * - Available via the API
 */

import { existsSync, readdirSync, statSync } from 'fs';
import { resolve, join, relative } from 'path';
import { cp, rm, mkdir } from 'fs/promises';
import { spawn } from 'child_process';
import { logger } from '../api/helpers/test-logger.js';

/**
 * Load fixture preset into runtime directory (Phase 1: Config only)
 *
 * This prepares the runtime directory with JSON config files.
 * File import happens later via importFixtureFiles() after server starts.
 *
 * @param {Object} options
 * @param {string} options.fixtureName - Fixture preset name (minimal, standard, complex)
 * @param {string} options.fixturesDir - Base fixtures directory (relative to projectRoot)
 * @param {string} options.runtimeDir - Runtime directory (relative to projectRoot)
 * @param {string} options.projectRoot - Project root directory
 * @param {boolean} [options.verbose] - Show detailed output
 * @returns {Promise<string>} Path to fixture files directory (for later import)
 */
export async function loadFixture(options) {
  const { fixtureName, fixturesDir, runtimeDir, projectRoot, verbose = false } = options;

  const fixturePath = resolve(projectRoot, fixturesDir, fixtureName);

  if (!existsSync(fixturePath)) {
    const available = getAvailableFixtures(resolve(projectRoot, fixturesDir));
    throw new Error(
      `Fixture '${fixtureName}' not found at ${fixturePath}\n` +
      `Available fixtures: ${available.join(', ')}`
    );
  }

  const runtimePath = resolve(projectRoot, runtimeDir);

  logger.info(`Loading fixture: ${fixtureName}`);
  if (verbose) {
    console.log(`   From: ${relative(projectRoot, fixturePath)}`);
    console.log(`   To: ${relative(projectRoot, runtimePath)}`);
  }

  // Clean runtime directory
  if (existsSync(runtimePath)) {
    await rm(runtimePath, { recursive: true, force: true });
  }

  // Create runtime structure matching FastAPI expectations
  await mkdir(join(runtimePath, 'db'), { recursive: true });
  await mkdir(join(runtimePath, 'config'), { recursive: true });
  await mkdir(join(runtimePath, 'files'), { recursive: true });
  await mkdir(join(runtimePath, 'logs'), { recursive: true });

  // Copy fixture config to runtime/config (for db_init to read from)
  const fixtureConfig = join(fixturePath, 'config');
  if (existsSync(fixtureConfig)) {
    await cp(fixtureConfig, join(runtimePath, 'config'), { recursive: true });
    if (verbose) {
      logger.success('Copied config/');
    }
  }

  logger.success('Fixture config loaded');

  // Return path to fixture files for later import
  return join(fixturePath, 'files');
}

/**
 * Import fixture files using the FileImporter Python script (Phase 2: After server starts)
 *
 * @param {string} fixtureFilesPath - Path to fixture files directory
 * @param {string} runtimePath - Path to runtime directory
 * @param {string} projectRoot - Project root directory
 * @param {boolean} verbose - Show detailed output
 * @returns {Promise<void>}
 */
export async function importFixtureFiles(fixtureFilesPath, runtimePath, projectRoot, verbose = false) {
  // Check if fixture files directory exists
  if (!existsSync(fixtureFilesPath)) {
    logger.info('No files to import (fixture has no files directory)');
    return;
  }

  // Check if directory is empty
  const files = readdirSync(fixtureFilesPath);
  if (files.length === 0) {
    logger.info('No files to import (files directory is empty)');
    return;
  }

  logger.info('Importing files into database...');

  // Build paths for the import script
  const importScript = join(projectRoot, 'bin', 'import_files.py');
  const dbPath = join(runtimePath, 'db', 'metadata.db');
  const storageRoot = join(runtimePath, 'files');

  // Run the import script using uv (for proper Python environment)
  // Use 'python' on Windows, 'python3' on Unix
  const pythonCommand = process.platform === 'win32' ? 'python' : 'python3';
  const args = [
    'run',
    pythonCommand,
    importScript,
    '--db-path', dbPath,
    '--storage-root', storageRoot,
    '--collection', 'default', // Default collection for fixture files (matches default group access)
    fixtureFilesPath
  ];

  if (verbose) {
    args.push('--verbose');
  }

  return new Promise((resolve, reject) => {
    const importProcess = spawn('uv', args, {
      cwd: projectRoot,
      stdio: verbose ? 'inherit' : 'pipe'
    });

    let stderr = '';

    if (!verbose) {
      importProcess.stderr.on('data', (data) => {
        stderr += data.toString();
      });
    }

    importProcess.on('exit', (code) => {
      if (code === 0) {
        logger.success('Files imported successfully');
        resolve();
      } else {
        const error = new Error(`File import failed with exit code ${code}`);
        if (stderr) {
          error.message += `\n${stderr}`;
        }
        reject(error);
      }
    });

    importProcess.on('error', (err) => {
      reject(new Error(`Failed to run import script: ${err.message}`));
    });
  });
}

/**
 * Get list of available fixture presets
 *
 * @param {string} fixturesDir - Fixtures directory (absolute path)
 * @returns {string[]} Array of fixture names
 */
export function getAvailableFixtures(fixturesDir) {
  if (!existsSync(fixturesDir)) return [];

  return readdirSync(fixturesDir)
    .filter(name => statSync(join(fixturesDir, name)).isDirectory())
    .filter(name => !name.startsWith('.'));
}
