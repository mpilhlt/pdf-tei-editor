#!/usr/bin/env node

/**
 * Container Start Script
 *
 * Starts a container with the PDF-TEI Editor application.
 * Automatically detects Docker or Podman and uses the appropriate command.
 *
 * Usage:
 *   npm run container:start
 *   npm run container:start -- --tag v1.0.0
 *   npm run container:start -- --tag latest --name my-container
 *   npm run container:start -- --port 8080
 *
 * Options:
 *   --tag <tag>       Image tag to use (default: latest)
 *   --name <name>     Container name (default: pdf-tei-editor-<tag>)
 *   --port <port>     Host port to bind (default: 8000)
 *   --detach          Run in detached mode (default: true)
 *   --no-detach       Run in foreground
 *   --help            Show this help message
 */

import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { detectContainerTool } from '../tests/lib/detect-container-tool.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, '..');

/**
 * Parse command line arguments
 */
function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    tag: 'latest',
    name: null,
    port: 8000,
    detach: true,
    help: false,
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--tag':
        options.tag = args[++i];
        break;
      case '--name':
        options.name = args[++i];
        break;
      case '--port':
        options.port = parseInt(args[++i], 10);
        break;
      case '--detach':
        options.detach = true;
        break;
      case '--no-detach':
        options.detach = false;
        break;
      case '--help':
        options.help = true;
        break;
      default:
        console.error(`Unknown option: ${args[i]}`);
        process.exit(1);
    }
  }

  // Default name based on tag
  if (!options.name) {
    options.name = `pdf-tei-editor-${options.tag}`;
  }

  return options;
}

/**
 * Show help message
 */
function showHelp() {
  console.log(`
Container Start Script

Starts a container with the PDF-TEI Editor application.
Automatically detects Docker or Podman.

Usage:
  npm run container:start
  npm run container:start -- --tag v1.0.0
  npm run container:start -- --tag latest --name my-container
  npm run container:start -- --port 8080

Options:
  --tag <tag>       Image tag to use (default: latest)
  --name <name>     Container name (default: pdf-tei-editor-<tag>)
  --port <port>     Host port to bind (default: 8000)
  --detach          Run in detached mode (default: true)
  --no-detach       Run in foreground
  --help            Show this help message

Examples:
  # Start container with latest tag on port 8000
  npm run container:start

  # Start specific version on custom port
  npm run container:start -- --tag v1.0.0 --port 9000

  # Start with custom name
  npm run container:start -- --name my-editor

  # Run in foreground (see logs)
  npm run container:start -- --no-detach
`);
}

/**
 * Start container
 */
async function startContainer() {
  const options = parseArgs();

  if (options.help) {
    showHelp();
    return;
  }

  console.log('🐳 Starting PDF-TEI Editor container...');
  console.log(`   Tag: ${options.tag}`);
  console.log(`   Name: ${options.name}`);
  console.log(`   Port: ${options.port}`);
  console.log(`   Mode: ${options.detach ? 'detached' : 'foreground'}`);

  // Detect container tool
  let containerCmd;
  try {
    const detected = detectContainerTool();
    containerCmd = detected.containerCmd;
    console.log(`   Engine: ${containerCmd}`);
  } catch (error) {
    console.error(`\n❌ ${error.message}`);
    process.exit(1);
  }

  // Check if container with this name already exists
  try {
    const existingContainer = execSync(
      `${containerCmd} ps -a --filter "name=^${options.name}$" --format "{{.ID}}"`,
      { encoding: 'utf8', stdio: 'pipe' }
    ).trim();

    if (existingContainer) {
      console.log(`\n⚠️  Container '${options.name}' already exists (ID: ${existingContainer})`);
      console.log('   Stopping and removing...');
      execSync(`${containerCmd} stop ${options.name}`, { stdio: 'inherit' });
      execSync(`${containerCmd} rm ${options.name}`, { stdio: 'inherit' });
    }
  } catch (error) {
    // No existing container, continue
  }

  // Check for local image first, then registry image
  console.log(`\n📦 Checking for image...`);

  let imageName = null;
  const localImageName = `pdf-tei-editor:${options.tag}`;
  const registryImageName = `cboulanger/pdf-tei-editor:${options.tag}`;

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
        console.error(`\n❌ Failed to pull image: ${error.message}`);
        console.error(`\nTried:`);
        console.error(`   1. Local image: ${localImageName}`);
        console.error(`   2. Registry image: ${registryImageName}`);
        console.error(`\nBuild locally with: npm run container:build -- ${options.tag}`);
        process.exit(1);
      }
    }
  }

  // Build run command
  const runArgs = [
    'run',
    options.detach ? '-d' : '',
    '--name', options.name,
    '-p', `${options.port}:8000`,
    imageName,
  ].filter(Boolean);

  const runCmd = `${containerCmd} ${runArgs.join(' ')}`;

  console.log(`\n🚀 Starting container...`);
  console.log(`   Command: ${runCmd}`);

  try {
    const output = execSync(runCmd, { encoding: 'utf8', stdio: options.detach ? 'pipe' : 'inherit' });

    if (options.detach) {
      const containerId = output.trim();
      console.log(`\n✅ Container started successfully!`);
      console.log(`   Container ID: ${containerId.substring(0, 12)}`);
      console.log(`   Name: ${options.name}`);
      console.log(`   URL: http://localhost:${options.port}`);
      console.log(`\nTo view logs:`);
      console.log(`   ${containerCmd} logs -f ${options.name}`);
      console.log(`\nTo stop:`);
      console.log(`   npm run container:stop -- --name ${options.name}`);
    }
  } catch (error) {
    console.error(`\n❌ Failed to start container: ${error.message}`);
    process.exit(1);
  }
}

// Run
startContainer().catch((error) => {
  console.error('Unexpected error:', error.message);
  process.exit(1);
});
