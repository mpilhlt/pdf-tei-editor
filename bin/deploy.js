#!/usr/bin/env node

/**
 * Deployment Wrapper Script
 *
 * Reads environment variables from a file and deploys a container
 * using bin/container.js deploy with appropriate parameters.
 *
 * Usage:
 *   node bin/deploy.js <env-file>
 *
 * Examples:
 *   node bin/deploy.js .env.example.org
 *   node bin/deploy.js config/production.env
 *   node bin/deploy.js /path/to/deployment.env
 *
 * The script:
 * - Passes all regular variables via --env VAR_NAME
 * - Converts DEPLOY_* variables to deploy command options
 *   - DEPLOY_FQDN=example.org → --fqdn example.org
 *   - DEPLOY_DATA_DIR=/path → --data-dir /path
 *   - DEPLOY_SSL=(1|true|on) → --ssl
 *   - DEPLOY_SSL=(''|0|false|off) → (omitted)
 * - If no DEPLOY_FQDN is present, adds --no-nginx --no-ssl
 */

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

/**
 * Parse environment file and split into deploy options and container env vars
 * @param {string} envFilePath - Path to .env file
 * @returns {{deployOptions: string[], containerEnv: string[]}}
 */
function parseEnvFile(envFilePath) {
  if (!fs.existsSync(envFilePath)) {
    console.error(`[ERROR] Environment file not found: ${envFilePath}`);
    process.exit(1);
  }

  const envConfig = dotenv.parse(fs.readFileSync(envFilePath, 'utf8'));
  const deployOptions = [];
  const containerEnv = [];

  for (const [key, value] of Object.entries(envConfig)) {
    if (key.startsWith('DEPLOY_')) {
      // Convert DEPLOY_* to deploy command options
      const optionName = key
        .substring(7) // Remove DEPLOY_ prefix
        .toLowerCase()
        .replace(/_/g, '-'); // Convert underscores to dashes

      // Handle boolean flags
      const isTruthy = ['1', 'true', 'on'].includes(value.toLowerCase());
      const isFalsy = ['', '0', 'false', 'off'].includes(value.toLowerCase());

      if (isTruthy) {
        deployOptions.push(`--${optionName}`);
      } else if (!isFalsy) {
        // Non-boolean value - add as key=value option
        deployOptions.push(`--${optionName}`, value);
      }
      // Falsy values are omitted
    } else {
      // Regular environment variable - pass to container
      containerEnv.push(`--env`, key);
    }
  }

  return { deployOptions, containerEnv };
}

/**
 * Main execution
 */
function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.error('[ERROR] Missing required parameter: <env-file>');
    console.error();
    console.error('Usage: node bin/deploy.js <env-file>');
    console.error();
    console.error('Examples:');
    console.error('  node bin/deploy.js .env.example.org');
    console.error('  node bin/deploy.js config/production.env');
    console.error('  node bin/deploy.js /path/to/deployment.env');
    process.exit(1);
  }

  const envFilePath = args[0];
  // Resolve to absolute path if relative
  const resolvedPath = path.isAbsolute(envFilePath)
    ? envFilePath
    : path.join(process.cwd(), envFilePath);

  console.log('PDF TEI Editor - Deployment from Environment File');
  console.log('==================================================');
  console.log();
  console.log(`[INFO] Reading environment from: ${resolvedPath}`);
  console.log();

  const { deployOptions, containerEnv } = parseEnvFile(resolvedPath);

  // Check if FQDN was provided and if it's localhost
  const fqdnIndex = deployOptions.findIndex(opt => opt === '--fqdn');
  const hasFqdn = fqdnIndex !== -1;
  const fqdnValue = hasFqdn ? deployOptions[fqdnIndex + 1] : null;
  const isLocalhost = fqdnValue === 'localhost' || fqdnValue === '127.0.0.1';

  if (!hasFqdn || isLocalhost) {
    if (!hasFqdn) {
      console.log('[INFO] No DEPLOY_FQDN found, adding --no-nginx --no-ssl');
    } else {
      console.log(`[INFO] DEPLOY_FQDN=${fqdnValue} detected, adding --no-nginx --no-ssl`);
    }
    // Only add if not already present
    if (!deployOptions.includes('--no-nginx')) {
      deployOptions.push('--no-nginx');
    }
    if (!deployOptions.includes('--no-ssl')) {
      deployOptions.push('--no-ssl');
    }
  }

  // Load environment variables from file so they're available when container.js runs
  dotenv.config({ path: resolvedPath });

  // Build command
  const cmdParts = ['node', 'bin/container.js', 'deploy'];
  cmdParts.push(...deployOptions);
  cmdParts.push(...containerEnv);

  const cmd = cmdParts.join(' ');

  console.log('[INFO] Executing deployment command:');
  console.log(`[INFO] ${cmd}`);
  console.log();

  try {
    execSync(cmd, {
      stdio: 'inherit',
      cwd: process.cwd(),
      env: process.env
    });
  } catch (error) {
    console.error('[ERROR] Deployment failed');
    process.exit(1);
  }
}

main();
