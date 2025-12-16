#!/usr/bin/env node

/**
 * Container Management Script for PDF TEI Editor
 *
 * Comprehensive script for building, pushing, starting, stopping, and restarting containers.
 * Automatically detects Docker or Podman and uses the appropriate command.
 */

import { execSync, spawn } from 'child_process';
import fs from 'fs';
import readline from 'readline';
import { Command } from 'commander';

// ============================================================================
// Configuration
// ============================================================================

const APP_NAME = 'pdf-tei-editor';

/** @type {string|null} */
let containerCmd = null;

/** @type {{username?: string, token?: string}} */
let credentials = {};

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Detect container tool (podman or docker)
 */
function detectContainerTool() {
  try {
    execSync('podman --version', { stdio: 'ignore' });
    containerCmd = 'podman';
    console.log('[INFO] Using podman as container tool');
    return true;
  } catch {
    // podman not found, try docker
  }

  try {
    execSync('docker --version', { stdio: 'ignore' });
    containerCmd = 'docker';
    console.log('[INFO] Using docker as container tool');
    return true;
  } catch {
    // docker not found
  }

  console.log('[ERROR] Neither podman nor docker found. Please install one of them.');
  process.exit(1);
}

/**
 * Load environment variables from .env file
 */
function loadEnv() {
  const envPath = '.env';
  if (fs.existsSync(envPath)) {
    console.log('[INFO] Loading environment variables from .env file...');
    const envContent = fs.readFileSync(envPath, 'utf8');

    envContent.split('\n').forEach(line => {
      line = line.trim();
      if (line && !line.startsWith('#')) {
        const [key, ...valueParts] = line.split('=');
        const value = valueParts.join('=');
        if (key && value) {
          const cleanValue = value.replace(/^["']|["']$/g, '');
          process.env[key] = process.env[key] || cleanValue;
        }
      }
    });
    console.log('[SUCCESS] Environment variables loaded');
  } else {
    console.log('[WARNING] No .env file found');
  }
}

/**
 * Validate required environment variables for push operations
 */
function validateEnv() {
  const requiredVars = ['DOCKER_HUB_USERNAME', 'DOCKER_HUB_TOKEN'];
  const missingVars = requiredVars.filter(varName => !process.env[varName]);

  if (missingVars.length > 0) {
    console.log(`[ERROR] Missing required environment variables: ${missingVars.join(', ')}`);
    console.log();
    console.log('[INFO] Please add these to your .env file:');
    missingVars.forEach(varName => {
      console.log(`  ${varName}=your_value_here`);
    });
    console.log();
    console.log('[INFO] For Docker Hub token, create a Personal Access Token at:');
    console.log('  https://hub.docker.com/settings/security');
    process.exit(1);
  }

  console.log('[SUCCESS] All required environment variables found');
  credentials.username = process.env.DOCKER_HUB_USERNAME;
  credentials.token = process.env.DOCKER_HUB_TOKEN;
}

/**
 * Get version tag from git or use provided/default value
 * @param {string|undefined} providedTag
 */
function getVersionTag(providedTag) {
  if (providedTag) {
    console.log(`[INFO] Using provided version tag: ${providedTag}`);
    return providedTag;
  }

  // Try to get version from git
  try {
    execSync('git rev-parse --git-dir', { stdio: 'ignore' });

    const gitHash = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
    const gitBranch = execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf8' }).trim();

    let tag;
    if (gitBranch === 'main' || gitBranch === 'master') {
      tag = 'latest';
    } else {
      tag = `${gitBranch}-${gitHash}`;
    }
    console.log(`[INFO] Auto-generated version tag: ${tag}`);
    return tag;
  } catch {
    console.log('[WARNING] Not in a git repository, using \'latest\' tag');
    return 'latest';
  }
}

/**
 * Execute command with live output
 * @param {string} command
 * @param {string[]} args
 * @param {{silent?: boolean}} options
 */
function executeCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const childProcess = spawn(command, args, {
      stdio: options.silent ? 'ignore' : 'inherit',
      ...options
    });

    childProcess.on('close', (code) => {
      if (code === 0) {
        resolve(undefined);
      } else {
        reject(new Error(`Command failed with exit code ${code}`));
      }
    });

    childProcess.on('error', (err) => {
      reject(err);
    });
  });
}

/**
 * Prompt user for confirmation
 * @param {string} question
 */
function askForConfirmation(question) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.toLowerCase().startsWith('y'));
    });
  });
}

// ============================================================================
// Build Command
// ============================================================================

/**
 * Build container image locally
 * @param {string} tag
 * @param {boolean} noCache
 */
async function buildImage(tag, noCache) {
  const imageName = APP_NAME;
  const fullTag = `${imageName}:${tag}`;
  const latestTag = `${imageName}:latest`;

  console.log(`[INFO] Building container image: ${fullTag}`);

  try {
    const buildArgs = [
      'build',
      '--target', 'production'
    ];

    if (noCache) {
      buildArgs.push('--no-cache');
    }

    buildArgs.push('-t', fullTag);

    if (tag !== 'latest') {
      buildArgs.push('-t', latestTag);
    }

    buildArgs.push('.');

    if (!containerCmd) {
      throw new Error('Container command not available');
    }
    await executeCommand(containerCmd, buildArgs);
    console.log('[SUCCESS] Container image built successfully');

    console.log('[INFO] Image details:');
    try {
      if (!containerCmd) {
        throw new Error('Container command not available');
      }
      execSync(`${containerCmd} images "${imageName}" --format "table {{.Repository}}\\t{{.Tag}}\\t{{.Size}}\\t{{.CreatedSince}}"`, { stdio: 'inherit' });
    } catch (err) {
      console.log('[WARNING] Could not display image details');
    }

    return true;
  } catch (err) {
    console.log('[ERROR] Container image build failed');
    console.log('[ERROR]', err instanceof Error ? err.message : String(err));
    return false;
  }
}

/**
 * Handle build command
 * @param {{tag?: string, noCache?: boolean, yes?: boolean}} options
 */
async function handleBuild(options) {
  console.log('PDF TEI Editor - Container Build');
  console.log('================================');
  console.log();

  detectContainerTool();
  const tag = getVersionTag(options.tag);

  console.log();
  console.log('[INFO] Configuration:');
  console.log(`[INFO]   Version Tag: ${tag}`);
  console.log(`[INFO]   Image Name: ${APP_NAME}:${tag}`);
  console.log(`[INFO]   Build Target: production`);

  if (options.noCache) {
    console.log(`[INFO]   Cache: Disabled (--no-cache - will rebuild all layers)`);
  } else {
    console.log(`[INFO]   Cache: Enabled (use --no-cache to force rebuild)`);
  }
  console.log();

  if (!options.yes) {
    const confirmed = await askForConfirmation('Continue with build? (y/N): ');
    if (!confirmed) {
      console.log('[INFO] Build cancelled by user');
      process.exit(0);
    }
  }

  console.log();
  console.log('[INFO] Starting build process...');

  if (!(await buildImage(tag, options.noCache || false))) {
    process.exit(1);
  }

  console.log();
  console.log('[SUCCESS] Build completed successfully!');
  console.log('[INFO] Image available locally for testing:');
  console.log(`[INFO]   ${containerCmd} run -p 8000:8000 ${APP_NAME}:${tag}`);
  console.log(`[INFO] To push to registry, use: node bin/container.js push --tag ${tag}`);
}

// ============================================================================
// Push Command
// ============================================================================

/**
 * Login to Docker Hub
 */
async function registryLogin() {
  console.log(`[INFO] Logging in to Docker Hub as ${credentials.username}...`);

  try {
    if (!containerCmd) {
      throw new Error('Container command not available');
    }

    const childProcess = spawn(containerCmd, ['login', '--username', credentials.username || '', '--password-stdin', 'docker.io'], {
      stdio: ['pipe', 'inherit', 'inherit']
    });

    if (childProcess.stdin) {
      childProcess.stdin.write(credentials.token || '');
      childProcess.stdin.end();
    }

    await new Promise((resolve, reject) => {
      childProcess.on('close', (/** @type {number|null} */ code) => {
        if (code === 0) {
          resolve(undefined);
        } else {
          reject(new Error('Login failed'));
        }
      });
    });

    console.log('[SUCCESS] Successfully logged in to Docker Hub');
    return true;
  } catch (err) {
    console.log('[ERROR] Docker Hub login failed');
    console.log('[ERROR]', err instanceof Error ? err.message : String(err));
    return false;
  }
}

/**
 * Push image to Docker Hub
 * @param {string} tag
 */
async function pushImage(tag) {
  const imageName = `${credentials.username}/${APP_NAME}`;
  const fullTag = `${imageName}:${tag}`;
  const latestTag = `${imageName}:latest`;

  console.log('[INFO] Pushing image to Docker Hub...');

  try {
    if (!containerCmd) {
      throw new Error('Container command not available');
    }

    console.log(`[INFO] Pushing ${fullTag}...`);
    await executeCommand(containerCmd, ['push', fullTag]);
    console.log(`[SUCCESS] Successfully pushed ${fullTag}`);

    if (tag !== 'latest') {
      console.log(`[INFO] Pushing ${latestTag}...`);
      try {
        await executeCommand(containerCmd, ['push', latestTag]);
        console.log(`[SUCCESS] Successfully pushed ${latestTag}`);
      } catch (err) {
        console.log('[WARNING] Failed to push latest tag (version tag push succeeded)');
      }
    }

    console.log('[SUCCESS] All images pushed successfully!');

    console.log();
    console.log('[INFO] Your image is now available at:');
    console.log(`[INFO]   ${containerCmd} pull ${fullTag}`);
    if (tag !== 'latest') {
      console.log(`[INFO]   ${containerCmd} pull ${latestTag}`);
    }
    console.log(`[INFO]   https://hub.docker.com/r/${credentials.username}/${APP_NAME}`);

    return true;
  } catch (err) {
    console.log('[ERROR] Failed to push images');
    console.log('[ERROR]', err instanceof Error ? err.message : String(err));
    return false;
  }
}

/**
 * Tag local image for registry
 * @param {string} tag
 */
function tagImageForRegistry(tag) {
  const localImageName = `${APP_NAME}:${tag}`;
  const registryImageName = `${credentials.username}/${APP_NAME}:${tag}`;

  try {
    if (!containerCmd) {
      throw new Error('Container command not available');
    }

    console.log(`[INFO] Tagging local image for registry...`);
    execSync(`${containerCmd} tag ${localImageName} ${registryImageName}`, { stdio: 'inherit' });

    if (tag !== 'latest') {
      const localLatest = `${APP_NAME}:latest`;
      const registryLatest = `${credentials.username}/${APP_NAME}:latest`;
      try {
        execSync(`${containerCmd} tag ${localLatest} ${registryLatest}`, { stdio: 'inherit' });
      } catch {
        console.log('[WARNING] Could not tag latest image');
      }
    }

    console.log('[SUCCESS] Images tagged for registry');
    return true;
  } catch (err) {
    console.log('[ERROR] Failed to tag images');
    console.log('[ERROR]', err instanceof Error ? err.message : String(err));
    return false;
  }
}

/**
 * Cleanup function
 */
function cleanup() {
  console.log('[INFO] Logging out of Docker Hub...');
  try {
    if (containerCmd) {
      execSync(`${containerCmd} logout docker.io`, { stdio: 'ignore' });
    }
  } catch {
    // Ignore cleanup errors
  }
}

/**
 * Handle push command
 * @param {{tag?: string, noBuild?: boolean, noCache?: boolean, yes?: boolean}} options
 */
async function handlePush(options) {
  console.log('PDF TEI Editor - Container Push');
  console.log('================================');
  console.log();

  detectContainerTool();
  loadEnv();
  validateEnv();
  const tag = getVersionTag(options.tag);

  process.on('exit', cleanup);
  process.on('SIGINT', () => {
    cleanup();
    process.exit(0);
  });

  console.log();
  console.log('[INFO] Configuration:');
  console.log(`[INFO]   Docker Hub User: ${credentials.username}`);
  console.log(`[INFO]   Version Tag: ${tag}`);
  console.log(`[INFO]   Image Name: ${credentials.username}/${APP_NAME}:${tag}`);

  if (!options.noBuild) {
    console.log(`[INFO]   Build Target: production`);
    if (options.noCache) {
      console.log(`[INFO]   Cache: Disabled (--no-cache - will rebuild all layers)`);
    } else {
      console.log(`[INFO]   Cache: Enabled (use --no-cache to force rebuild)`);
    }
  } else {
    console.log(`[INFO]   Mode: Push only (--no-build)`);
  }
  console.log();

  const action = options.noBuild ? 'push' : 'build and push';

  if (!options.yes) {
    const confirmed = await askForConfirmation(`Continue with ${action}? (y/N): `);
    if (!confirmed) {
      console.log(`[INFO] ${action.charAt(0).toUpperCase() + action.slice(1)} cancelled by user`);
      process.exit(0);
    }
  }

  console.log();
  console.log(`[INFO] Starting ${action} process...`);

  if (!options.noBuild) {
    if (!(await buildImage(tag, options.noCache || false))) {
      process.exit(1);
    }
    console.log();
    if (!tagImageForRegistry(tag)) {
      process.exit(1);
    }
  } else {
    console.log('[INFO] Skipping build step (--no-build option)');

    const imageName = `${credentials.username}/${APP_NAME}:${tag}`;
    try {
      if (!containerCmd) {
        throw new Error('Container command not available');
      }
      execSync(`${containerCmd} image inspect ${imageName}`, { stdio: 'ignore' });
      console.log(`[INFO] Image ${imageName} found locally`);
    } catch {
      console.log(`[ERROR] Image ${imageName} not found locally. Please build it first or remove --no-build option.`);
      process.exit(1);
    }
  }

  console.log();
  if (!(await registryLogin())) {
    process.exit(1);
  }

  console.log();
  if (!(await pushImage(tag))) {
    process.exit(1);
  }

  console.log();
  console.log('[SUCCESS] Push completed successfully!');
}

// ============================================================================
// Environment Variable Processing
// ============================================================================

/**
 * Process --env parameters and add them to container run arguments
 * @param {string[]} runArgs - Container run arguments array
 * @param {string[] | undefined} envSpecs - Environment variable specifications
 */
function processEnvParameters(runArgs, envSpecs) {
  if (!envSpecs || !Array.isArray(envSpecs)) {
    return;
  }

  for (const envSpec of envSpecs) {
    if (envSpec.includes('=')) {
      // --env FOO=BAR format - use the specified value
      runArgs.push('-e', envSpec);
      const [key] = envSpec.split('=');
      console.log(`[INFO] Added environment variable: ${key}=<specified value>`);
    } else {
      // --env FOO format - transfer from host environment
      const value = process.env[envSpec];
      if (value !== undefined) {
        runArgs.push('-e', `${envSpec}=${value}`);
        console.log(`[INFO] Added environment variable from host: ${envSpec}`);
      } else {
        console.log(`[WARNING] Environment variable ${envSpec} not found in host environment, skipping`);
      }
    }
  }
}

// ============================================================================
// Start Command
// ============================================================================

/**
 * Handle start command
 * @param {{tag?: string, name?: string, port?: number, detach?: boolean, rebuild?: boolean, noCache?: boolean, env?: string[]}} options
 */
async function handleStart(options) {
  console.log('PDF TEI Editor - Container Start');
  console.log('=================================');
  console.log();

  detectContainerTool();

  const tag = options.tag || 'latest';
  const name = options.name || `${APP_NAME}-${tag}`;
  const port = options.port || 8000;

  // Rebuild image if requested
  if (options.rebuild) {
    console.log('[INFO] Rebuilding image before starting container...');
    console.log();
    if (!(await buildImage(tag, options.noCache || false))) {
      process.exit(1);
    }
    console.log();
  }
  const detach = options.detach !== false;

  console.log(`   Tag: ${tag}`);
  console.log(`   Name: ${name}`);
  console.log(`   Port: ${port}`);
  console.log(`   Mode: ${detach ? 'detached' : 'foreground'}`);
  console.log(`   Engine: ${containerCmd}`);

  // Check if container with this name already exists
  try {
    const existingContainer = execSync(
      `${containerCmd} ps -a --filter "name=^${name}$" --format "{{.ID}}"`,
      { encoding: 'utf8', stdio: 'pipe' }
    ).trim();

    if (existingContainer) {
      console.log(`\n   Container '${name}' already exists (ID: ${existingContainer})`);
      console.log('   Stopping and removing...');
      execSync(`${containerCmd} stop ${name}`, { stdio: 'inherit' });
      execSync(`${containerCmd} rm ${name}`, { stdio: 'inherit' });
    }
  } catch (error) {
    // No existing container, continue
  }

  // Check for local image first, then registry image
  console.log(`\n   Checking for image...`);

  let imageName = null;
  const localImageName = `${APP_NAME}:${tag}`;
  const registryImageName = `cboulanger/${APP_NAME}:${tag}`;

  // Try local image first
  try {
    execSync(`${containerCmd} image inspect ${localImageName}`, { stdio: 'pipe' });
    imageName = localImageName;
    console.log(`   Found local image: ${localImageName}`);
  } catch {
    // Try registry image
    try {
      execSync(`${containerCmd} image inspect ${registryImageName}`, { stdio: 'pipe' });
      imageName = registryImageName;
      console.log(`   Found registry image: ${registryImageName}`);
    } catch {
      // Neither exists, try to pull from registry
      console.log(`   No local image found, pulling from registry...`);
      try {
        execSync(`${containerCmd} pull ${registryImageName}`, { stdio: 'inherit' });
        imageName = registryImageName;
      } catch (error) {
        console.error(`\n   Failed to pull image`);
        console.error(`\nTried:`);
        console.error(`   1. Local image: ${localImageName}`);
        console.error(`   2. Registry image: ${registryImageName}`);
        console.error(`\nBuild locally with: node bin/container.js build --tag ${tag}`);
        process.exit(1);
      }
    }
  }

  // Build run command
  const runArgs = [
    'run',
    detach ? '-d' : '',
    '--name', name,
    '-p', `${port}:8000`,
  ].filter(Boolean);

  // Process environment variables
  processEnvParameters(runArgs, options.env);

  runArgs.push(imageName);

  const runCmd = `${containerCmd} ${runArgs.join(' ')}`;

  console.log(`\n   Starting container...`);
  console.log(`   Command: ${runCmd}`);

  try {
    const output = execSync(runCmd, { encoding: 'utf8', stdio: detach ? 'pipe' : 'inherit' });

    if (detach) {
      const containerId = output.trim();
      console.log(`\n   Container started successfully!`);
      console.log(`   Container ID: ${containerId.substring(0, 12)}`);
      console.log(`   Name: ${name}`);
      console.log(`   URL: http://localhost:${port}`);
      console.log(`\nTo view logs:`);
      console.log(`   ${containerCmd} logs -f ${name}`);
      console.log(`\nTo stop:`);
      console.log(`   node bin/container.js stop --name ${name}`);
    }
  } catch (error) {
    console.error(`\n   Failed to start container: ${String(error)}`);
    process.exit(1);
  }
}

// ============================================================================
// Stop Command
// ============================================================================

/**
 * Handle stop command
 * @param {{name?: string, all?: boolean, remove?: boolean}} options
 */
async function handleStop(options) {
  console.log('PDF TEI Editor - Container Stop');
  console.log('================================');
  console.log();

  detectContainerTool();

  if (options.all) {
    console.log(`   Stopping all ${APP_NAME} containers...`);

    try {
      const containers = execSync(
        `${containerCmd} ps -a --filter "name=${APP_NAME}" --format "{{.ID}} {{.Names}}"`,
        { encoding: 'utf8', stdio: 'pipe' }
      ).trim();

      if (!containers) {
        console.log(`   No ${APP_NAME} containers found`);
        return;
      }

      const containerLines = containers.split('\n');
      console.log(`   Found ${containerLines.length} container(s)`);

      for (const line of containerLines) {
        const [id, name] = line.split(' ');
        console.log(`\n   Stopping ${name}...`);
        try {
          execSync(`${containerCmd} stop ${id}`, { stdio: 'inherit' });
          if (options.remove) {
            console.log(`   Removing ${name}...`);
            execSync(`${containerCmd} rm ${id}`, { stdio: 'inherit' });
          }
        } catch (error) {
          console.error(`   Failed to stop ${name}: ${String(error)}`);
        }
      }

      console.log('\n   Done');
    } catch (error) {
      console.error(`\n   Failed to list containers: ${String(error)}`);
      process.exit(1);
    }
  } else {
    const name = options.name || `${APP_NAME}-latest`;
    console.log(`   Stopping container: ${name}`);

    try {
      const containerId = execSync(
        `${containerCmd} ps -a --filter "name=^${name}$" --format "{{.ID}}"`,
        { encoding: 'utf8', stdio: 'pipe' }
      ).trim();

      if (!containerId) {
        console.error(`\n   Container '${name}' not found`);
        console.log('\nRunning containers:');
        try {
          execSync(`${containerCmd} ps --filter "name=${APP_NAME}" --format "table {{.Names}}\\t{{.Status}}\\t{{.Ports}}"`, {
            stdio: 'inherit'
          });
        } catch {
          console.log(`   No ${APP_NAME} containers running`);
        }
        process.exit(1);
      }

      console.log(`   Container ID: ${containerId.substring(0, 12)}`);
      try {
        execSync(`${containerCmd} stop ${name}`, { stdio: 'inherit' });
        console.log('   Stopped successfully');

        if (options.remove) {
          console.log(`   Removing container...`);
          execSync(`${containerCmd} rm ${name}`, { stdio: 'inherit' });
          console.log('   Removed successfully');
        }

        console.log('\n   Done');
      } catch (error) {
        console.error(`\n   Failed to stop container: ${String(error)}`);
        process.exit(1);
      }
    } catch (error) {
      console.error(`\n   Error: ${String(error)}`);
      process.exit(1);
    }
  }
}

// ============================================================================
// Restart Command
// ============================================================================

/**
 * Handle restart command
 * @param {{name?: string, tag?: string, port?: number, rebuild?: boolean, noCache?: boolean, env?: string[]}} options
 */
async function handleRestart(options) {
  console.log('PDF TEI Editor - Container Restart');
  console.log('===================================');
  console.log();

  detectContainerTool();

  const name = options.name || `${APP_NAME}-latest`;

  // Rebuild image if requested
  if (options.rebuild) {
    const tag = options.tag || 'latest';
    console.log('[INFO] Rebuilding image before restarting container...');
    console.log();
    if (!(await buildImage(tag, options.noCache || false))) {
      process.exit(1);
    }
    console.log();
  }

  console.log(`   Restarting container: ${name}`);

  // Check if container exists
  try {
    const containerId = execSync(
      `${containerCmd} ps -a --filter "name=^${name}$" --format "{{.ID}}"`,
      { encoding: 'utf8', stdio: 'pipe' }
    ).trim();

    if (containerId) {
      // If rebuild was requested, remove the container to use the new image
      if (options.rebuild) {
        console.log(`   Container ID: ${containerId.substring(0, 12)}`);
        console.log('   Removing container to use rebuilt image...');
        try {
          execSync(`${containerCmd} stop ${name}`, { stdio: 'inherit' });
          execSync(`${containerCmd} rm ${name}`, { stdio: 'inherit' });
          console.log('   Removed successfully');
        } catch (error) {
          console.error(`   Failed to remove: ${String(error)}`);
          process.exit(1);
        }

        // Create and start new container with the rebuilt image
        console.log('   Creating new container with rebuilt image...');
        console.log();
        // Don't rebuild again - we already did it above
        const startOptions = { ...options, rebuild: false };
        await handleStart(startOptions);
      } else {
        // Container exists, stop and start it
        console.log(`   Container ID: ${containerId.substring(0, 12)}`);
        console.log('   Stopping...');
        try {
          execSync(`${containerCmd} stop ${name}`, { stdio: 'inherit' });
          console.log('   Stopped successfully');
        } catch (error) {
          console.error(`   Failed to stop: ${String(error)}`);
          process.exit(1);
        }

        // Start the existing container
        console.log('   Starting...');
        try {
          execSync(`${containerCmd} start ${name}`, { stdio: 'inherit' });
          console.log('   Started successfully');
          console.log(`\n   Container '${name}' restarted`);
          console.log(`\nTo view logs:`);
          console.log(`   ${containerCmd} logs -f ${name}`);
        } catch (error) {
          console.error(`   Failed to start: ${String(error)}`);
          process.exit(1);
        }
      }
    } else {
      // Container doesn't exist, create and start it
      console.log(`   Container '${name}' not found, creating new container...`);
      console.log();
      await handleStart(options);
    }
  } catch (error) {
    console.error(`\n   Error: ${String(error)}`);
    process.exit(1);
  }
}

// ============================================================================
// Deploy Command
// ============================================================================

/**
 * Check if a command is available
 * @param {string} command
 */
function isCommandAvailable(command) {
  try {
    // nginx uses -v instead of --version
    const versionFlag = command === 'nginx' ? '-v' : '--version';
    execSync(`${command} ${versionFlag}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Check required dependencies for deployment features
 * @param {{nginx: boolean, ssl: boolean}} features
 */
function checkDeployDependencies(features) {
  const missing = [];

  if (features.nginx && !isCommandAvailable('nginx')) {
    missing.push('nginx (required for reverse proxy setup)');
  }

  if (features.ssl && !isCommandAvailable('certbot')) {
    missing.push('certbot (required for SSL certificate setup)');
  }

  if (missing.length > 0) {
    console.log('[ERROR] Missing required dependencies:');
    missing.forEach(dep => console.log(`  - ${dep}`));
    console.log();
    return false;
  }

  return true;
}

/**
 * Setup nginx configuration for the deployment
 * @param {string} fqdn
 * @param {number} port
 */
async function setupNginx(fqdn, port) {
  console.log('[INFO] Setting up nginx configuration...');

  const configFile = `/etc/nginx/sites-available/${APP_NAME}-${fqdn}`;
  const nginxConfig = `# PDF TEI Editor configuration for ${fqdn}
server {
    server_name ${fqdn};

    location / {
        proxy_pass http://127.0.0.1:${port};
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Host $host;
        proxy_redirect off;
    }

    # Special handling for Server-Sent Events
    location /sse/ {
        proxy_pass http://127.0.0.1:${port};
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Host $host;
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 300;
        proxy_connect_timeout 75;
    }

    listen 80;
}
`;

  try {
    fs.writeFileSync(configFile, nginxConfig);
    console.log(`[INFO] Created nginx config: ${configFile}`);

    // Enable the site
    const enabledLink = `/etc/nginx/sites-enabled/${APP_NAME}-${fqdn}`;
    if (fs.existsSync(enabledLink)) {
      fs.unlinkSync(enabledLink);
    }
    fs.symlinkSync(configFile, enabledLink);
    console.log('[INFO] Enabled site');

    // Test and reload nginx
    console.log('[INFO] Testing nginx configuration...');
    execSync('nginx -t', { stdio: 'inherit' });

    console.log('[INFO] Reloading nginx...');
    try {
      execSync('systemctl reload nginx', { stdio: 'inherit' });
    } catch {
      execSync('systemctl restart nginx', { stdio: 'inherit' });
    }

    console.log('[SUCCESS] Nginx configured successfully');
    return true;
  } catch (err) {
    console.log('[ERROR] Failed to setup nginx');
    console.log('[ERROR]', err instanceof Error ? err.message : String(err));
    return false;
  }
}

/**
 * Check if domain resolves via DNS
 * @param {string} fqdn
 */
async function checkDNSResolution(fqdn) {
  console.log(`[INFO] Checking DNS resolution for ${fqdn}...`);

  try {
    // Try to resolve the domain using nslookup or dig
    let output;
    try {
      output = execSync(`nslookup ${fqdn}`, { encoding: 'utf8', stdio: 'pipe' });
    } catch {
      // Try dig if nslookup fails
      try {
        output = execSync(`dig +short ${fqdn}`, { encoding: 'utf8', stdio: 'pipe' });
      } catch {
        console.log('[ERROR] Neither nslookup nor dig command found');
        console.log('[WARNING] Cannot verify DNS resolution - proceeding anyway');
        return true;
      }
    }

    // Check if we got any IP address in the output
    const hasIP = /\d+\.\d+\.\d+\.\d+/.test(output);

    if (hasIP) {
      console.log(`[SUCCESS] Domain ${fqdn} resolves successfully`);
      return true;
    } else {
      console.log('[ERROR] Domain does not resolve to any IP address');
      console.log('[ERROR] DNS lookup output:');
      console.log(output);
      console.log();
      console.log('[ERROR] Please configure your DNS settings first:');
      console.log(`[ERROR]   1. Add an A record for ${fqdn} pointing to this server's IP address`);
      console.log('[ERROR]   2. Wait for DNS propagation (can take up to 48 hours)');
      console.log('[ERROR]   3. Verify with: nslookup ' + fqdn);
      console.log();
      console.log('[ERROR] Let\'s Encrypt requires the domain to be publicly resolvable');
      return false;
    }
  } catch (err) {
    console.log('[ERROR] Failed to check DNS resolution');
    console.log('[ERROR]', err instanceof Error ? err.message : String(err));
    return false;
  }
}

/**
 * Setup SSL certificate with certbot
 * @param {string} fqdn
 * @param {string} email
 */
async function setupSSL(fqdn, email) {
  console.log('[INFO] Setting up SSL certificate with Let\'s Encrypt...');

  // Check if domain resolves before attempting SSL
  if (!(await checkDNSResolution(fqdn))) {
    console.log('[ERROR] SSL setup aborted due to DNS resolution failure');
    return false;
  }

  try {
    await executeCommand('certbot', [
      '--nginx',
      '-d', fqdn,
      '--non-interactive',
      '--agree-tos',
      '--email', email
    ]);

    console.log('[SUCCESS] SSL certificate configured successfully');
    return true;
  } catch (err) {
    console.log('[ERROR] Failed to setup SSL certificate');
    console.log('[ERROR]', err instanceof Error ? err.message : String(err));
    return false;
  }
}

/**
 * Handle deploy command
 * @param {{
 *   fqdn: string,
 *   name?: string,
 *   tag?: string,
 *   port?: number,
 *   type?: string,
 *   dataDir?: string,
 *   noNginx?: boolean,
 *   noSsl?: boolean,
 *   email?: string,
 *   rebuild?: boolean,
 *   noCache?: boolean,
 *   env?: string[],
 *   yes?: boolean
 * }} options
 */
async function handleDeploy(options) {
  console.log('PDF TEI Editor - Container Deploy');
  console.log('==================================');
  console.log();

  // Check platform - deploy only works on Linux
  if (process.platform === 'win32') {
    console.log('[ERROR] The deploy command is not supported on Windows');
    console.log('[ERROR] Deploy requires Linux-specific tools: nginx, certbot, systemctl');
    console.log();
    console.log('[INFO] For Windows deployment, use the basic start command:');
    console.log('[INFO]   node bin/container.js start --tag <tag> --port <port>');
    console.log();
    console.log('[INFO] Or deploy on a Linux server using this command');
    process.exit(1);
  }

  // Validate FQDN
  if (!options.fqdn) {
    console.log('[ERROR] FQDN is required for deployment');
    console.log('[INFO] Usage: node bin/container.js deploy --fqdn <FQDN>');
    process.exit(1);
  }

  const useNginx = !options.noNginx;
  const useSSL = !options.noSsl;

  // Check for root access FIRST if nginx/ssl needed
  if ((useNginx || useSSL) && process.getuid && process.getuid() !== 0) {
    console.log('[ERROR] This command needs to be run with sudo for nginx/SSL configuration');
    console.log('[INFO] Usage: sudo env "PATH=$PATH" node bin/container.js deploy --fqdn <FQDN>');
    console.log('[INFO] Or configure sudoers to preserve PATH: Defaults env_keep += "PATH"');
    console.log('[INFO] To skip nginx/SSL, use: node bin/container.js deploy --fqdn <FQDN> --no-nginx --no-ssl');
    process.exit(1);
  }

  // Check dependencies
  if (!checkDeployDependencies({ nginx: useNginx, ssl: useSSL })) {
    process.exit(1);
  }

  detectContainerTool();

  const tag = options.tag || 'latest';
  const port = options.port || 8001;
  const deploymentType = options.type || 'production';
  const email = options.email || `admin@${options.fqdn}`;
  const containerName = `${APP_NAME}-${options.fqdn.replace(/\./g, '-')}`;

  // Validate deployment type
  if (deploymentType !== 'production' && deploymentType !== 'demo') {
    console.log('[ERROR] Invalid deployment type. Must be "production" or "demo"');
    process.exit(1);
  }

  // Warn about demo deployment with external directories
  let dataDir = options.dataDir;

  if (deploymentType === 'demo') {
    if (dataDir) {
      console.log('[WARNING] Demo deployment: ignoring external data directory (data will not persist)');
      dataDir = undefined;
    }
  }

  console.log('[INFO] Configuration:');
  console.log(`[INFO]   FQDN: ${options.fqdn}`);
  console.log(`[INFO]   Container: ${containerName}`);
  console.log(`[INFO]   Image Tag: ${tag}`);
  console.log(`[INFO]   Port: ${port}`);
  console.log(`[INFO]   Type: ${deploymentType}`);
  console.log(`[INFO]   Nginx: ${useNginx}`);
  console.log(`[INFO]   SSL: ${useSSL}`);

  if (deploymentType === 'production') {
    console.log(`[INFO]   Data root: ${dataDir || '(container internal)'}`);
  }

  console.log();
  console.log('[INFO] See .env.production for available environment variables');
  console.log('[INFO] Key variables: GEMINI_API_KEY, GROBID_SERVER_URL, KISSKI_API_KEY, LOG_LEVEL');
  console.log();

  if (!options.yes) {
    const confirmed = await askForConfirmation('Continue with deployment? (y/N): ');
    if (!confirmed) {
      console.log('[INFO] Deployment cancelled by user');
      process.exit(0);
    }
  }

  console.log();
  console.log('[INFO] Starting deployment process...');
  console.log();

  // Rebuild if requested
  if (options.rebuild) {
    console.log('[INFO] Rebuilding image...');
    if (!(await buildImage(tag, options.noCache || false))) {
      process.exit(1);
    }
    console.log();
  }

  // Check for image
  const imageName = `${APP_NAME}:${tag}`;
  try {
    if (!containerCmd) {
      throw new Error('Container command not available');
    }
    execSync(`${containerCmd} image inspect ${imageName}`, { stdio: 'ignore' });
    console.log(`[INFO] Using image: ${imageName}`);
  } catch {
    console.log(`[ERROR] Image ${imageName} not found. Build it first or use --rebuild`);
    process.exit(1);
  }

  // Stop existing container
  try {
    if (!containerCmd) {
      throw new Error('Container command not available');
    }
    const existingContainer = execSync(
      `${containerCmd} ps -a --filter "name=^${containerName}$" --format "{{.ID}}"`,
      { encoding: 'utf8', stdio: 'pipe' }
    ).trim();

    if (existingContainer) {
      console.log(`[INFO] Stopping existing container: ${containerName}`);
      execSync(`${containerCmd} stop ${containerName}`, { stdio: 'inherit' });
      execSync(`${containerCmd} rm ${containerName}`, { stdio: 'inherit' });
    }
  } catch {
    // No existing container
  }

  // Build container run command
  const runArgs = [
    'run', '-d',
    '--name', containerName,
    '--restart', 'unless-stopped',
    '-p', `${port}:8000`,
    '-e', 'PORT=8000'
  ];

  // Add DATA_ROOT environment variable if dataDir is specified
  if (dataDir) {
    runArgs.push('-e', `DATA_ROOT=/app/data`);
  }

  // Process --env parameters
  processEnvParameters(runArgs, options.env);

  // Add volume mount for production
  if (deploymentType === 'production') {
    if (dataDir) {
      if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
      }
      runArgs.push('-v', `${dataDir}:/app/data`);
      console.log(`[INFO] Mounted data root: ${dataDir} -> /app/data (contains files/ and db/ subdirectories)`);
    }
  } else {
    console.log('[INFO] Demo deployment: using container-internal storage (non-persistent)');
  }

  runArgs.push(imageName);

  // Start container
  console.log();
  console.log('[INFO] Starting container...');
  try {
    if (!containerCmd) {
      throw new Error('Container command not available');
    }
    await executeCommand(containerCmd, runArgs);
    console.log('[SUCCESS] Container started successfully');
  } catch (err) {
    console.log('[ERROR] Failed to start container');
    console.log('[ERROR]', err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  // Wait for container to be ready
  console.log();
  console.log('[INFO] Waiting for container to be ready...');
  let ready = false;
  for (let attempt = 1; attempt <= 30; attempt++) {
    try {
      execSync(`curl -s http://localhost:${port}`, { stdio: 'ignore' });
      console.log('[SUCCESS] Container is ready');
      ready = true;
      break;
    } catch {
      if (attempt % 5 === 0) {
        console.log(`[INFO] Attempt ${attempt}/30 - waiting for container...`);
      }
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }

  if (!ready) {
    console.log('[WARNING] Container may not be fully ready yet, but continuing...');
  }

  // Setup nginx
  if (useNginx) {
    console.log();
    if (!(await setupNginx(options.fqdn, port))) {
      console.log('[WARNING] Nginx setup failed, but container is running');
    }
  }

  // Setup SSL
  if (useSSL) {
    console.log();
    if (!(await setupSSL(options.fqdn, email))) {
      console.log('[WARNING] SSL setup failed, but container is running');
    }
  }

  // Final status
  console.log();
  console.log('[SUCCESS] Deployment completed successfully!');
  console.log();

  const urlScheme = useSSL ? 'https' : 'http';
  console.log(`[INFO] 📍 Application URL: ${urlScheme}://${options.fqdn}`);
  console.log(`[INFO] 🐳 Container: ${containerName}`);
  console.log(`[INFO] 📊 Monitor logs: ${containerCmd} logs -f ${containerName}`);
  console.log(`[INFO] 🛑 Stop container: ${containerCmd} stop ${containerName}`);

  if (deploymentType === 'demo') {
    console.log('[INFO] 🔄 Note: Demo deployment - data will not persist across container restarts');
  }
}

// ============================================================================
// Main CLI Setup
// ============================================================================

const program = new Command();

program
  .name('container')
  .description('Container management for PDF TEI Editor')
  .version('1.0.0');

// Build command
program
  .command('build')
  .description('Build container image locally')
  .option('--tag <tag>', 'Version tag (default: auto-generated from git)')
  .option('--no-cache', 'Force rebuild all layers')
  .option('--yes', 'Skip confirmation prompt')
  .action(handleBuild);

// Push command
program
  .command('push')
  .description('Build and push image to Docker Hub registry')
  .option('--tag <tag>', 'Version tag (default: auto-generated from git)')
  .option('--no-build', 'Skip build step, push existing image only')
  .option('--no-cache', 'Force rebuild all layers')
  .option('--yes', 'Skip confirmation prompt')
  .action(handlePush);

// Start command
program
  .command('start')
  .description('Start a container')
  .option('--tag <tag>', 'Image tag to use (default: latest)')
  .option('--name <name>', `Container name (default: ${APP_NAME}-<tag>)`)
  .option('--port <port>', 'Host port to bind (default: 8000)', parseInt)
  .option('--env <var>', 'Environment variable (FOO or FOO=bar, can be used multiple times)', (value, previous) => previous ? [...previous, value] : [value])
  .option('--rebuild', 'Rebuild image before starting')
  .option('--no-cache', 'Force rebuild all layers (use with --rebuild)')
  .option('--no-detach', 'Run in foreground')
  .action(handleStart);

// Stop command
program
  .command('stop')
  .description('Stop a running container')
  .option('--name <name>', `Container name (default: ${APP_NAME}-latest)`)
  .option('--all', `Stop all ${APP_NAME} containers`)
  .option('--remove', 'Remove container after stopping')
  .action(handleStop);

// Restart command
program
  .command('restart')
  .description('Restart a container (stop then start)')
  .option('--name <name>', `Container name (default: ${APP_NAME}-latest)`)
  .option('--tag <tag>', 'Image tag (used if container doesn\'t exist)')
  .option('--port <port>', 'Host port (used if container doesn\'t exist)', parseInt)
  .option('--env <var>', 'Environment variable (FOO or FOO=bar, can be used multiple times)', (value, previous) => previous ? [...previous, value] : [value])
  .option('--rebuild', 'Rebuild image before restarting')
  .option('--no-cache', 'Force rebuild all layers (use with --rebuild)')
  .action(handleRestart);

// Deploy command
program
  .command('deploy')
  .description('Deploy container with nginx reverse proxy and SSL (requires sudo)')
  .requiredOption('--fqdn <fqdn>', 'Fully qualified domain name')
  .option('--name <name>', 'Container name (default: pdf-tei-editor-latest)')
  .option('--tag <tag>', 'Image tag to use (default: latest)')
  .option('--port <port>', 'Host port to bind (default: 8001)', parseInt)
  .option('--type <type>', 'Deployment type: production|demo (default: production)')
  .option('--data-dir <dir>', 'External data root directory (contains files/ and db/ subdirectories, production only)')
  .option('--env <var>', 'Environment variable (FOO or FOO=bar, can be used multiple times)', (value, previous) => previous ? [...previous, value] : [value])
  .option('--no-nginx', 'Skip nginx configuration')
  .option('--no-ssl', 'Skip SSL certificate setup')
  .option('--email <email>', 'Email for SSL certificate (default: admin@<fqdn>)')
  .option('--rebuild', 'Rebuild image before deploying')
  .option('--no-cache', 'Force rebuild all layers (use with --rebuild)')
  .option('--yes', 'Skip confirmation prompt')
  .addHelpText('after', `
Examples:
  # Production deployment with external data directory
  sudo env "PATH=$PATH" node bin/container.js deploy \\
    --fqdn editor.company.com \\
    --data-dir /opt/${APP_NAME}/data

  # Demo deployment (no external volumes, no persistence)
  sudo env "PATH=$PATH" node bin/container.js deploy \\
    --fqdn demo.example.com \\
    --type demo

  # Deploy without SSL (HTTP only)
  sudo env "PATH=$PATH" node bin/container.js deploy \\
    --fqdn local.test \\
    --no-ssl

  # Deploy without nginx/SSL (just container)
  node bin/container.js deploy \\
    --fqdn test.local \\
    --no-nginx --no-ssl

  # With environment variables (transfer from host)
  GEMINI_API_KEY=your-key LOG_LEVEL=WARNING sudo env "PATH=$PATH" node bin/container.js deploy \\
    --fqdn app.example.com \\
    --env GEMINI_API_KEY \\
    --env LOG_LEVEL

  # With environment variables (specify values directly)
  sudo env "PATH=$PATH" node bin/container.js deploy \\
    --fqdn app.example.com \\
    --env GEMINI_API_KEY=your-key \\
    --env LOG_LEVEL=WARNING

  # Automated deployment (skip confirmation)
  sudo env "PATH=$PATH" node bin/container.js deploy \\
    --fqdn app.example.com \\
    --data-dir /opt/${APP_NAME}/data \\
    --yes

Environment Variables:
  See .env.production for all available environment variables.
  Use --env to pass variables to the container:
    --env FOO         Transfer FOO from host environment
    --env FOO=bar     Set FOO to "bar" in container

  Key variables include:
    - GEMINI_API_KEY, GROBID_SERVER_URL, KISSKI_API_KEY (AI/ML features)
    - LOG_LEVEL, LOG_CATEGORIES (logging)
    - WEBDAV_ENABLED, WEBDAV_BASE_URL (WebDAV integration)
    - DOCS_FROM_GITHUB (documentation source)

Notes:
  - Requires sudo for nginx and SSL setup
  - Use --no-nginx --no-ssl to run without sudo
  - Demo deployments ignore external directories
  - Nginx and certbot must be installed for full deployment
  - data-dir must contain files/ and db/ subdirectories (created automatically)
`)
  .action(handleDeploy);

// Parse arguments
program.parse();
