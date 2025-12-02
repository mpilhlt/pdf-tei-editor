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
  const imageName = 'pdf-tei-editor';
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
 * @param {{tag?: string, noCache?: boolean}} options
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
  console.log(`[INFO]   Image Name: pdf-tei-editor:${tag}`);
  console.log(`[INFO]   Build Target: production`);

  if (options.noCache) {
    console.log(`[INFO]   Cache: Disabled (--no-cache - will rebuild all layers)`);
  } else {
    console.log(`[INFO]   Cache: Enabled (use --no-cache to force rebuild)`);
  }
  console.log();

  const confirmed = await askForConfirmation('Continue with build? (y/N): ');
  if (!confirmed) {
    console.log('[INFO] Build cancelled by user');
    process.exit(0);
  }

  console.log();
  console.log('[INFO] Starting build process...');

  if (!(await buildImage(tag, options.noCache || false))) {
    process.exit(1);
  }

  console.log();
  console.log('[SUCCESS] Build completed successfully!');
  console.log('[INFO] Image available locally for testing:');
  console.log(`[INFO]   ${containerCmd} run -p 8000:8000 pdf-tei-editor:${tag}`);
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
  const imageName = `${credentials.username}/pdf-tei-editor`;
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
    console.log(`[INFO]   https://hub.docker.com/r/${credentials.username}/pdf-tei-editor`);

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
  const localImageName = `pdf-tei-editor:${tag}`;
  const registryImageName = `${credentials.username}/pdf-tei-editor:${tag}`;

  try {
    if (!containerCmd) {
      throw new Error('Container command not available');
    }

    console.log(`[INFO] Tagging local image for registry...`);
    execSync(`${containerCmd} tag ${localImageName} ${registryImageName}`, { stdio: 'inherit' });

    if (tag !== 'latest') {
      const localLatest = 'pdf-tei-editor:latest';
      const registryLatest = `${credentials.username}/pdf-tei-editor:latest`;
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
 * @param {{tag?: string, noBuild?: boolean, noCache?: boolean}} options
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
  console.log(`[INFO]   Image Name: ${credentials.username}/pdf-tei-editor:${tag}`);

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
  const confirmed = await askForConfirmation(`Continue with ${action}? (y/N): `);
  if (!confirmed) {
    console.log(`[INFO] ${action.charAt(0).toUpperCase() + action.slice(1)} cancelled by user`);
    process.exit(0);
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

    const imageName = `${credentials.username}/pdf-tei-editor:${tag}`;
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
// Start Command
// ============================================================================

/**
 * Handle start command
 * @param {{tag?: string, name?: string, port?: number, detach?: boolean, rebuild?: boolean, noCache?: boolean}} options
 */
async function handleStart(options) {
  console.log('PDF TEI Editor - Container Start');
  console.log('=================================');
  console.log();

  detectContainerTool();

  const tag = options.tag || 'latest';
  const name = options.name || `pdf-tei-editor-${tag}`;
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
  const localImageName = `pdf-tei-editor:${tag}`;
  const registryImageName = `cboulanger/pdf-tei-editor:${tag}`;

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
    imageName,
  ].filter(Boolean);

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
    console.error(`\n   Failed to start container: ${error.message}`);
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
    console.log('   Stopping all pdf-tei-editor containers...');

    try {
      const containers = execSync(
        `${containerCmd} ps -a --filter "name=pdf-tei-editor" --format "{{.ID}} {{.Names}}"`,
        { encoding: 'utf8', stdio: 'pipe' }
      ).trim();

      if (!containers) {
        console.log('   No pdf-tei-editor containers found');
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
          console.error(`   Failed to stop ${name}: ${error.message}`);
        }
      }

      console.log('\n   Done');
    } catch (error) {
      console.error(`\n   Failed to list containers: ${error.message}`);
      process.exit(1);
    }
  } else {
    const name = options.name || 'pdf-tei-editor-latest';
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
          execSync(`${containerCmd} ps --filter "name=pdf-tei-editor" --format "table {{.Names}}\\t{{.Status}}\\t{{.Ports}}"`, {
            stdio: 'inherit'
          });
        } catch {
          console.log('   No pdf-tei-editor containers running');
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
        console.error(`\n   Failed to stop container: ${error.message}`);
        process.exit(1);
      }
    } catch (error) {
      console.error(`\n   Error: ${error.message}`);
      process.exit(1);
    }
  }
}

// ============================================================================
// Restart Command
// ============================================================================

/**
 * Handle restart command
 * @param {{name?: string, tag?: string, port?: number, rebuild?: boolean, noCache?: boolean}} options
 */
async function handleRestart(options) {
  console.log('PDF TEI Editor - Container Restart');
  console.log('===================================');
  console.log();

  detectContainerTool();

  const name = options.name || 'pdf-tei-editor-latest';

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
          console.error(`   Failed to remove: ${error.message}`);
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
          console.error(`   Failed to stop: ${error.message}`);
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
          console.error(`   Failed to start: ${error.message}`);
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
    console.error(`\n   Error: ${error.message}`);
    process.exit(1);
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
  .action(handleBuild);

// Push command
program
  .command('push')
  .description('Build and push image to Docker Hub registry')
  .option('--tag <tag>', 'Version tag (default: auto-generated from git)')
  .option('--no-build', 'Skip build step, push existing image only')
  .option('--no-cache', 'Force rebuild all layers')
  .action(handlePush);

// Start command
program
  .command('start')
  .description('Start a container')
  .option('--tag <tag>', 'Image tag to use (default: latest)')
  .option('--name <name>', 'Container name (default: pdf-tei-editor-<tag>)')
  .option('--port <port>', 'Host port to bind (default: 8000)', parseInt)
  .option('--rebuild', 'Rebuild image before starting')
  .option('--no-cache', 'Force rebuild all layers (use with --rebuild)')
  .option('--no-detach', 'Run in foreground')
  .action(handleStart);

// Stop command
program
  .command('stop')
  .description('Stop a running container')
  .option('--name <name>', 'Container name (default: pdf-tei-editor-latest)')
  .option('--all', 'Stop all pdf-tei-editor containers')
  .option('--remove', 'Remove container after stopping')
  .action(handleStop);

// Restart command
program
  .command('restart')
  .description('Restart a container (stop then start)')
  .option('--name <name>', 'Container name (default: pdf-tei-editor-latest)')
  .option('--tag <tag>', 'Image tag (used if container doesn\'t exist)')
  .option('--port <port>', 'Host port (used if container doesn\'t exist)', parseInt)
  .option('--rebuild', 'Rebuild image before restarting')
  .option('--no-cache', 'Force rebuild all layers (use with --rebuild)')
  .action(handleRestart);

// Parse arguments
program.parse();
