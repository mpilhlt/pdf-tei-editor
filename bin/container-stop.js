#!/usr/bin/env node

/**
 * Container Stop Script
 *
 * Stops and optionally removes a container.
 * Automatically detects Docker or Podman and uses the appropriate command.
 *
 * Usage:
 *   npm run container:stop
 *   npm run container:stop -- --name my-container
 *   npm run container:stop -- --name my-container --remove
 *   npm run container:stop -- --all
 *
 * Options:
 *   --name <name>     Container name (default: pdf-tei-editor-latest)
 *   --all             Stop all pdf-tei-editor containers
 *   --remove          Remove container after stopping
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
    name: 'pdf-tei-editor-latest',
    all: false,
    remove: false,
    help: false,
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--name':
        options.name = args[++i];
        break;
      case '--all':
        options.all = true;
        break;
      case '--remove':
        options.remove = true;
        break;
      case '--help':
        options.help = true;
        break;
      default:
        console.error(`Unknown option: ${args[i]}`);
        process.exit(1);
    }
  }

  return options;
}

/**
 * Show help message
 */
function showHelp() {
  console.log(`
Container Stop Script

Stops and optionally removes a container.
Automatically detects Docker or Podman.

Usage:
  npm run container:stop
  npm run container:stop -- --name my-container
  npm run container:stop -- --name my-container --remove
  npm run container:stop -- --all

Options:
  --name <name>     Container name (default: pdf-tei-editor-latest)
  --all             Stop all pdf-tei-editor containers
  --remove          Remove container after stopping
  --help            Show this help message

Examples:
  # Stop default container
  npm run container:stop

  # Stop specific container
  npm run container:stop -- --name pdf-tei-editor-v1.0.0

  # Stop and remove container
  npm run container:stop -- --name my-container --remove

  # Stop all pdf-tei-editor containers
  npm run container:stop -- --all
`);
}

/**
 * Stop container(s)
 */
async function stopContainer() {
  const options = parseArgs();

  if (options.help) {
    showHelp();
    return;
  }

  // Detect container tool
  let containerCmd;
  try {
    const detected = detectContainerTool();
    containerCmd = detected.containerCmd;
    console.log(`🐳 Using ${containerCmd}`);
  } catch (error) {
    console.error(`\n❌ ${error.message}`);
    process.exit(1);
  }

  if (options.all) {
    console.log('\n🛑 Stopping all pdf-tei-editor containers...');

    // Find all pdf-tei-editor containers
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

      console.log('\n✅ Done');
    } catch (error) {
      console.error(`\n❌ Failed to list containers: ${error.message}`);
      process.exit(1);
    }
  } else {
    console.log(`\n🛑 Stopping container: ${options.name}`);

    // Check if container exists
    try {
      const containerId = execSync(
        `${containerCmd} ps -a --filter "name=^${options.name}$" --format "{{.ID}}"`,
        { encoding: 'utf8', stdio: 'pipe' }
      ).trim();

      if (!containerId) {
        console.error(`\n❌ Container '${options.name}' not found`);
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

      // Stop container
      console.log(`   Container ID: ${containerId.substring(0, 12)}`);
      try {
        execSync(`${containerCmd} stop ${options.name}`, { stdio: 'inherit' });
        console.log('   Stopped successfully');

        if (options.remove) {
          console.log(`   Removing container...`);
          execSync(`${containerCmd} rm ${options.name}`, { stdio: 'inherit' });
          console.log('   Removed successfully');
        }

        console.log('\n✅ Done');
      } catch (error) {
        console.error(`\n❌ Failed to stop container: ${error.message}`);
        process.exit(1);
      }
    } catch (error) {
      console.error(`\n❌ Error: ${error.message}`);
      process.exit(1);
    }
  }
}

// Run
stopContainer().catch((error) => {
  console.error('Unexpected error:', error.message);
  process.exit(1);
});
