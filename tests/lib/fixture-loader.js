#!/usr/bin/env node

/**
 * Fixture Loader - Utilities for loading test fixture presets
 *
 * Manages fixture loading into runtime directories for test execution.
 * Supports multiple fixture presets (minimal, standard, complex).
 */

import { existsSync, readdirSync, statSync } from 'fs';
import { resolve, join, relative } from 'path';
import { cp, rm, mkdir } from 'fs/promises';

/**
 * Load fixture preset into runtime directory
 *
 * @param {Object} options
 * @param {string} options.fixtureName - Fixture preset name (minimal, standard, complex)
 * @param {string} options.fixturesDir - Base fixtures directory (relative to projectRoot)
 * @param {string} options.runtimeDir - Runtime directory (relative to projectRoot)
 * @param {string} options.projectRoot - Project root directory
 * @param {boolean} [options.verbose] - Show detailed output
 * @returns {Promise<void>}
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

  console.log(`📦 Loading fixture: ${fixtureName}`);
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
      console.log(`   ✓ Copied config/`);
    }
  }

  // Copy fixture files to runtime/files
  const fixtureFiles = join(fixturePath, 'files');
  if (existsSync(fixtureFiles)) {
    await cp(fixtureFiles, join(runtimePath, 'files'), { recursive: true });
    if (verbose) {
      console.log(`   ✓ Copied files/`);
    }
  }

  console.log(`✅ Fixture loaded successfully`);
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
