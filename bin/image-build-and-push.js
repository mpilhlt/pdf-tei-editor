#!/usr/bin/env node

/**
 * Docker Hub Build and Push Script for PDF TEI Editor
 * Cross-platform Node.js version with ESM syntax
 *
 * Usage: node bin/image-build-and-push.js [OPTIONS] [TAG]
 * Options:
 *   --no-build      Skip build step and push only existing image
 *   --build-only    Build image locally without pushing to registry
 *   --no-cache      Force rebuild all layers (ignore Docker cache)
 * Example: node bin/image-build-and-push.js v1.0.0
 * Example: node bin/image-build-and-push.js --no-build v1.0.0
 * Example: node bin/image-build-and-push.js --build-only v1.0.0
 * Example: node bin/image-build-and-push.js --no-cache v1.0.0
 */

import { execSync, spawn } from 'child_process';
import fs from 'fs';
import readline from 'readline';

/** @type {string|null} */
let containerCmd = null;

/** @type {{username?: string, token?: string, versionTag?: string, noBuild?: boolean, buildOnly?: boolean, noCache?: boolean}} */
let config = {};

// Detect container tool (podman or docker)
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

// Load environment variables from .env file
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
                    // Remove quotes if present and only set if not already in environment
                    const cleanValue = value.replace(/^["']|["']$/g, '');
                    process.env[key] = process.env[key] || cleanValue;
                }
            }
        });
        console.log('[SUCCESS] Environment variables loaded');
    } else {
        console.log('[WARNING] No .env file found - you\'ll need to set environment variables manually');
    }
}

// Validate required environment variables
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
    config.username = process.env.DOCKER_HUB_USERNAME;
    config.token = process.env.DOCKER_HUB_TOKEN;
}

// Get version tag
/** @param {string|undefined} providedTag */
function getVersion(providedTag) {
    if (providedTag) {
        config.versionTag = providedTag;
        console.log(`[INFO] Using provided version tag: ${config.versionTag}`);
        return;
    }

    // Try to get version from git
    try {
        execSync('git rev-parse --git-dir', { stdio: 'ignore' });

        const gitHash = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
        const gitBranch = execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf8' }).trim();

        if (gitBranch === 'main' || gitBranch === 'master') {
            config.versionTag = 'latest';
        } else {
            config.versionTag = `${gitBranch}-${gitHash}`;
        }
        console.log(`[INFO] Auto-generated version tag: ${config.versionTag}`);
    } catch {
        config.versionTag = 'latest';
        console.log('[WARNING] Not in a git repository, using \'latest\' tag');
    }
}

// Execute command with live output
/**
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

// Build container image
async function buildImage() {
    // For build-only mode, use local image name without registry prefix
    const imageName = config.buildOnly ? 'pdf-tei-editor' : `${config.username}/pdf-tei-editor`;
    const fullTag = `${imageName}:${config.versionTag}`;
    const latestTag = `${imageName}:latest`;

    console.log(`[INFO] Building container image: ${fullTag}`);

    try {
        // Build with both version tag and latest (using production target)
        const buildArgs = [
            'build',
            '--target', 'production'  // Use production target
        ];

        // Add no-cache flag if requested
        if (config.noCache) {
            buildArgs.push('--no-cache');
        }

        buildArgs.push('-t', fullTag);

        // Add latest tag if not already latest
        if (config.versionTag !== 'latest') {
            buildArgs.push('-t', latestTag);
        }

        buildArgs.push('.');

        if (!containerCmd) {
            throw new Error('Container command not available');
        }
        await executeCommand(containerCmd, buildArgs);
        console.log('[SUCCESS] Container image built successfully');

        // Show image details
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

// Login to Docker Hub
async function registryLogin() {
    console.log(`[INFO] Logging in to Docker Hub as ${config.username}...`);

    // Debug credential availability
    console.log(`[DEBUG] Username available: ${!!config.username}`);
    console.log(`[DEBUG] Token available: ${!!config.token}`);
    console.log(`[DEBUG] Token length: ${config.token ? config.token.length : 0}`);

    try {
        if (!containerCmd) {
            throw new Error('Container command not available');
        }

        const childProcess = spawn(containerCmd, ['login', '--username', config.username || '', '--password-stdin', 'docker.io'], {
            stdio: ['pipe', 'inherit', 'inherit']
        });

        if (childProcess.stdin) {
            childProcess.stdin.write(config.token || '');
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

// Push image to Docker Hub
async function pushImage() {
    const imageName = `${config.username}/pdf-tei-editor`;
    const fullTag = `${imageName}:${config.versionTag}`;
    const latestTag = `${imageName}:latest`;

    console.log('[INFO] Pushing image to Docker Hub...');

    try {
        if (!containerCmd) {
            throw new Error('Container command not available');
        }

        // Push version-specific tag
        console.log(`[INFO] Pushing ${fullTag}...`);
        await executeCommand(containerCmd, ['push', fullTag]);
        console.log(`[SUCCESS] Successfully pushed ${fullTag}`);

        // Push latest tag (only if not already latest)
        if (config.versionTag !== 'latest') {
            console.log(`[INFO] Pushing ${latestTag}...`);
            try {
                await executeCommand(containerCmd, ['push', latestTag]);
                console.log(`[SUCCESS] Successfully pushed ${latestTag}`);
            } catch (err) {
                console.log('[WARNING] Failed to push latest tag (version tag push succeeded)');
            }
        }

        console.log('[SUCCESS] All images pushed successfully!');

        // Show final repository info
        console.log();
        console.log('[INFO] 🐳 Your image is now available at:');
        console.log(`[INFO]   ${containerCmd} pull ${fullTag}`);
        if (config.versionTag !== 'latest') {
            console.log(`[INFO]   ${containerCmd} pull ${latestTag}`);
        }
        console.log(`[INFO]   https://hub.docker.com/r/${config.username}/pdf-tei-editor`);

        return true;
    } catch (err) {
        console.log('[ERROR] Failed to push images');
        console.log('[ERROR]', err instanceof Error ? err.message : String(err));
        return false;
    }
}

// Cleanup function
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

// Prompt user for confirmation
/** @param {string} question */
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

// Main function
async function main() {
    console.log('PDF TEI Editor - Docker Hub Build & Push');
    console.log('=======================================');
    console.log();

    try {
        // Detect container tool first
        detectContainerTool();

        // Set up cleanup on exit
        process.on('exit', cleanup);
        process.on('SIGINT', () => {
            cleanup();
            process.exit(0);
        });

        // Load environment variables and validate if needed
        loadEnv();

        // Skip credential validation for build-only mode
        if (!config.buildOnly) {
            validateEnv();
        } else {
            console.log('[INFO] Skipping Docker Hub credential validation (build-only mode)');
        }

        // Parse command line arguments
        const args = process.argv.slice(2);
        let providedTag;

        // Check for options
        if (args.includes('--no-build')) {
            config.noBuild = true;
            console.log('[INFO] --no-build option detected, skipping build step');
        }

        if (args.includes('--build-only')) {
            config.buildOnly = true;
            console.log('[INFO] --build-only option detected, skipping push step');
        }

        if (args.includes('--no-cache')) {
            config.noCache = true;
            console.log('[INFO] --no-cache option detected, will rebuild all layers');
        }

        // Validate mutually exclusive options
        if (config.noBuild && config.buildOnly) {
            console.log('[ERROR] --no-build and --build-only options are mutually exclusive');
            process.exit(1);
        }

        if (config.noBuild && config.noCache) {
            console.log('[ERROR] --no-build and --no-cache options are mutually exclusive (no build means no cache usage)');
            process.exit(1);
        }

        // Get remaining tag argument (filter out all option flags)
        const filteredArgs = args.filter(arg => !arg.startsWith('--'));
        providedTag = filteredArgs[0];

        // Get version tag
        getVersion(providedTag);

        // Confirm before proceeding
        console.log();
        console.log('[INFO] Configuration:');
        if (!config.buildOnly) {
            console.log(`[INFO]   Docker Hub User: ${config.username}`);
        }
        console.log(`[INFO]   Version Tag: ${config.versionTag}`);
        const imageName = config.buildOnly ? 'pdf-tei-editor' : `${config.username}/pdf-tei-editor`;
        console.log(`[INFO]   Image Name: ${imageName}:${config.versionTag}`);

        if (config.buildOnly) {
            console.log(`[INFO]   Mode: Build only (--build-only)`);
            console.log(`[INFO]   Build Target: production`);
        } else if (!config.noBuild) {
            console.log(`[INFO]   Build Target: production`);
        } else {
            console.log(`[INFO]   Mode: Push only (--no-build)`);
        }

        if (config.noCache) {
            console.log(`[INFO]   Cache: Disabled (--no-cache - will rebuild all layers)`);
        } else if (!config.noBuild) {
            console.log(`[INFO]   Cache: Enabled (use --no-cache to force rebuild)`);
        }
        console.log();

        let action;
        if (config.buildOnly) {
            action = 'build';
        } else if (config.noBuild) {
            action = 'push';
        } else {
            action = 'build and push';
        }

        const confirmed = await askForConfirmation(`Continue with ${action}? (y/N): `);
        if (!confirmed) {
            console.log(`[INFO] ${action.charAt(0).toUpperCase() + action.slice(1)} cancelled by user`);
            process.exit(0);
        }

        console.log();
        console.log(`[INFO] Starting ${action} process...`);

        // Build the image (unless --no-build is specified)
        if (!config.noBuild) {
            if (!(await buildImage())) {
                process.exit(1);
            }
        } else {
            console.log('[INFO] Skipping build step (--no-build option)');

            // Verify that the image exists when skipping build
            const imageName = `${config.username}/pdf-tei-editor:${config.versionTag}`;
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

        // Skip registry operations for build-only mode
        if (!config.buildOnly) {
            console.log();
            // Login to Docker Hub
            if (!(await registryLogin())) {
                process.exit(1);
            }

            console.log();
            // Push to Docker Hub
            if (!(await pushImage())) {
                process.exit(1);
            }

            console.log();
            if (config.noBuild) {
                console.log('[SUCCESS] 🎉 Push completed successfully!');
            } else {
                console.log('[SUCCESS] 🎉 Build and push completed successfully!');
            }
        } else {
            console.log();
            console.log('[SUCCESS] 🎉 Build completed successfully!');
            console.log('[INFO] Image available locally for testing:');
            console.log(`[INFO]   ${containerCmd} run -p 8000:8000 pdf-tei-editor:${config.versionTag}`);
            console.log(`[INFO] When ready to push, run without --build-only flag.`);
        }

    } catch (err) {
        console.log('[ERROR] Unexpected error occurred:');
        console.log('[ERROR]', err instanceof Error ? err.message : String(err));
        process.exit(1);
    }
}

// Run main function if this script is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
    main();
}

export { main };