#!/usr/bin/env node

/**
 * Unified Cross-platform E2E Test Runner
 *
 * Provides containerized test environment for both Playwright browser tests
 * and backend integration tests. Replaces bin/test-e2e with cross-platform Node.js implementation.
 *
 * Environment Variables:
 *   E2E_HOST - Host to bind container (default: localhost)
 *   E2E_PORT - Port to expose container on host (default: 8000)
 *   E2E_CONTAINER_PORT - Port inside container (default: 8000)
 *
 * Usage:
 *   # Playwright browser tests 
 *   node tests/e2e-runner.js --playwright [options]
 *   node tests/e2e-runner.js --playwright --browser firefox --headed
 *
 *   # Backend integration tests
 *   node tests/e2e-runner.js tests/e2e/test-extractors.js
 *
 *   # Environment variable examples
 *   E2E_PORT=8001 node tests/e2e-runner.js --playwright --debug
 */

import { spawn, execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = dirname(__dirname);

/**
 * Unified cross-platform E2E test infrastructure
 */
class E2ERunner {
  constructor() {
    /** @type {string | null} */
    this.containerCmd = null;
    /** @type {string | null} */
    this.composeCmd = null;
    this.usePodman = false;
    this.testRunId = `test-${Date.now()}-${process.pid}`;
    this.containerName = `pdf-tei-editor-test-${this.testRunId}`;
    this.isContainerStarted = false;

    // Configuration from environment variables
    this.config = {
      host: process.env.E2E_HOST || 'localhost',
      port: parseInt(process.env.E2E_PORT || '8000'),
      containerPort: parseInt(process.env.E2E_CONTAINER_PORT || '8000')
    };

    // Load environment variables from .env file (will be updated by setDotenvPath if needed)
    this.dotenvPath = path.join(projectRoot, '.env');
    this.loadDotenv();

    // Detect container tool
    this.detectContainerTool();

    // Setup cleanup handlers
    process.on('SIGINT', () => this.cleanup());
    process.on('SIGTERM', () => this.cleanup());
    process.on('exit', () => this.cleanup());
  }

  /**
   * Load environment variables from the configured dotenv path
   */
  loadDotenv() {
    if (fs.existsSync(this.dotenvPath)) {
      console.log(`📋 Loading environment variables from ${path.relative(projectRoot, this.dotenvPath)}...`);
      dotenv.config({ path: this.dotenvPath });
    } else {
      console.log(`⚠️ Dotenv file not found at ${path.relative(projectRoot, this.dotenvPath)} - AI extraction tests may be skipped`);
    }
  }

  /**
   * Set a custom dotenv file path and reload environment variables
   * @param {string} customPath - Path to the .env file to use
   */
  setDotenvPath(customPath) {
    this.dotenvPath = path.isAbsolute(customPath) ? customPath : path.join(projectRoot, customPath);
    this.loadDotenv();
  }

  /**
   * Process environment variable specifications from @env annotations
   * @param {string[]} envSpecs - Array of environment variable specifications
   * @returns {string[]} Array of processed environment variables for container
   */
  processEnvironmentVariables(envSpecs) {
    const envVars = [];

    for (const spec of envSpecs) {
      if (spec.includes('=')) {
        // Assignment format: VAR_NAME="value"
        const [varName, ...valueParts] = spec.split('=');
        const value = valueParts.join('=').replace(/^["']|["']$/g, ''); // Remove quotes
        envVars.push(`${varName}=${value}`);
        console.log(`📋 Setting environment variable: ${varName}=${value}`);
      } else {
        // Variable name only - pass through from environment
        const varName = spec.trim();
        if (process.env[varName]) {
          envVars.push(`${varName}=${process.env[varName]}`);
          console.log(`📋 Passing environment variable: ${varName}`);
        } else {
          console.log(`⚠️ Environment variable ${varName} not found - test may be skipped`);
        }
      }
    }

    return envVars;
  }

  /**
   * Detect available container tool (podman or docker) with compose support
   */
  detectContainerTool() {
    try {
      execSync('command -v podman', { stdio: 'ignore' });
      this.containerCmd = 'podman';
      this.usePodman = true;
      console.log('🐙 Using podman as container tool');
      console.log('📦 Preferring native podman commands over compose tools');

      // Prefer native podman - only use compose tools if explicitly needed
      // Check for compose tools with podman but keep usePodman = true
      try {
        execSync('command -v podman-compose', { stdio: 'ignore' });
        this.composeCmd = 'podman-compose';
        console.log('📦 Found podman-compose (available but using native podman)');
      } catch {
        try {
          execSync('command -v docker-compose', { stdio: 'ignore' });
          this.composeCmd = 'docker-compose';
          console.log('📦 Found docker-compose (available but using native podman)');
        } catch {
          console.log('📦 No compose tool found, using direct podman commands');
        }
      }
    } catch {
      try {
        execSync('command -v docker', { stdio: 'ignore' });
        this.containerCmd = 'docker';
        this.usePodman = false;
        console.log('🐳 Using docker as container tool');

        // Check for docker compose
        try {
          execSync('docker compose version', { stdio: 'ignore' });
          this.composeCmd = 'docker compose';
          console.log('📦 Found docker compose');
        } catch {
          try {
            execSync('command -v docker-compose', { stdio: 'ignore' });
            this.composeCmd = 'docker-compose';
            console.log('📦 Found docker-compose');
          } catch {
            throw new Error('Docker Compose is required but not installed');
          }
        }
      } catch {
        throw new Error('Neither podman nor docker found. Please install one of them.');
      }
    }
  }

  /**
   * Start the containerized test environment
   * @param {boolean} noRebuild - Skip rebuilding the container image
   * @param {string[]} envVars - Environment variables to pass to container
   */
  async startContainer(noRebuild = false, envVars = []) {
    console.log('🚀 Starting containerized test environment...');
    console.log(`🆔 Test Run ID: ${this.testRunId}`);

    try {
      if (this.usePodman) {
        await this.startDirectContainer(noRebuild, envVars);
      } else {
        await this.startComposeContainer(noRebuild, envVars);
      }

      this.isContainerStarted = true;
      console.log('✅ Container started successfully');

      // Wait for application to be ready
      await this.waitForApplicationReady();

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error('❌ Failed to start container:', errorMessage);
      throw error;
    }
  }

  /**
   * Start container using direct container commands
   * @param {boolean} noRebuild - Skip rebuilding the container image
   * @param {string[]} envVars - Environment variables to pass to container
   */
  async startDirectContainer(noRebuild = false, envVars = []) {
    // Clean up any existing containers using the configured port
    console.log('🧹 Cleaning up existing containers...');
    try {
      const existingContainers = execSync(
        `${this.containerCmd} ps -a --format "table {{.ID}}\\t{{.Ports}}" | grep ":${this.config.port}->" | awk '{print $1}'`,
        { encoding: 'utf8', stdio: 'pipe' }
      ).trim();

      if (existingContainers) {
        console.log(`🛑 Stopping existing containers using port ${this.config.port}...`);
        execSync(`echo "${existingContainers}" | xargs -r ${this.containerCmd} stop`, { stdio: 'ignore' });
        execSync(`echo "${existingContainers}" | xargs -r ${this.containerCmd} rm`, { stdio: 'ignore' });
      }
    } catch (error) {
      // Ignore cleanup errors
    }

    // Clean up existing container with our name
    try {
      execSync(`${this.containerCmd} rm -f ${this.containerName}`, { stdio: 'ignore' });
    } catch (error) {
      // Ignore if container doesn't exist
    }

    // Build test image with consistent name for layer caching (unless skipping rebuild)
    if (noRebuild) {
      console.log('⏭️ Skipping image build (using existing image)...');
      // Check if the image exists
      try {
        execSync(`${this.containerCmd} image exists pdf-tei-editor-test:latest`, { stdio: 'ignore' });
        console.log('✅ Found existing pdf-tei-editor-test:latest image');
      } catch {
        throw new Error('No existing pdf-tei-editor-test:latest image found. Run without --no-rebuild first.');
      }
    } else {
      console.log('🏗️ Building test image...');
      execSync(`${this.containerCmd} build -t pdf-tei-editor-test:latest --target test .`, {
        stdio: 'inherit',
        cwd: projectRoot
      });

      // Clean up dangling images to prevent accumulation while preserving cache
      await this.cleanupStaleImages();
    }

    // Start container with test environment
    console.log('🚀 Starting test container...');
    const portMapping = `${this.config.port}:${this.config.containerPort}`;

    // Build environment arguments from @env annotations
    // Always set TEST_IN_PROGRESS to suppress server logs to console
    const testEnvVars = ['TEST_IN_PROGRESS=1', ...envVars];
    const envArgs = testEnvVars.length > 0 ? testEnvVars.map(env => `--env ${env}`).join(' ') : '';

    const runCmd = `${this.containerCmd} run -d --name ${this.containerName} -p ${portMapping} ${envArgs} pdf-tei-editor-test:latest`;
    const containerId = execSync(runCmd, {
      encoding: 'utf8',
      cwd: projectRoot
    }).trim();
    console.log(containerId);
  }

  /**
   * Start container using compose commands
   * @param {boolean} noRebuild - Skip rebuilding the container image
   * @param {string[]} envVars - Environment variables to pass to container
   */
  async startComposeContainer(noRebuild = false, envVars = []) {
    console.log('🏗️ Using compose commands...');

    // Clean up any existing containers
    try {
      execSync(`${this.composeCmd} -f docker-compose.test.yml down --remove-orphans --volumes`, {
        stdio: 'ignore',
        cwd: projectRoot
      });
    } catch (error) {
      // Ignore cleanup errors
    }

    // Prepare environment variables for compose
    // Always set TEST_IN_PROGRESS to suppress server logs to console
    const testEnvVars = ['TEST_IN_PROGRESS=1', ...envVars];
    const env = { ...process.env };

    // Set environment variables that will be passed to the container
    for (const envVar of testEnvVars) {
      const [key, value] = envVar.split('=', 2);
      if (key && value !== undefined) {
        env[key] = value;
      }
    }

    // Start the test environment
    if (noRebuild) {
      console.log('🚀 Starting test environment with compose (no rebuild)...');
      execSync(`${this.composeCmd} -f docker-compose.test.yml up --no-build -d`, {
        stdio: 'pipe',
        cwd: projectRoot,
        env
      });
    } else {
      console.log('🚀 Starting test environment with compose...');
      execSync(`${this.composeCmd} -f docker-compose.test.yml up --build -d`, {
        stdio: 'pipe',
        cwd: projectRoot,
        env
      });

      // Clean up dangling images to prevent accumulation while preserving cache
      await this.cleanupStaleImages();
    }
  }

  /**
   * Wait for the application to be ready to accept connections
   */
  async waitForApplicationReady() {
    console.log('⏳ Waiting for application to be ready...');

    const timeout = 120; // 2 minutes
    let counter = 0;

    while (counter < timeout) {
      try {
        if (this.usePodman) {
          // Check if container is running and application is responding
          const healthCheckUrl = `http://${this.config.host}:${this.config.containerPort}/`;
          execSync(`${this.containerCmd} exec ${this.containerName} curl -f ${healthCheckUrl} >/dev/null 2>&1`, {
            stdio: 'pipe'
          });
        } else {
          // Use compose health check or direct curl
          try {
            const composeStatus = execSync(`${this.composeCmd} -f docker-compose.test.yml ps`, {
              encoding: 'utf8',
              stdio: 'pipe',
              cwd: projectRoot
            });
            if (composeStatus.includes('healthy') || composeStatus.includes('Up')) {
              // Double-check with curl
              execSync(`curl -f http://${this.config.host}:${this.config.port}/ >/dev/null 2>&1`, {
                stdio: 'pipe'
              });
            } else {
              throw new Error('Compose services not ready');
            }
          } catch {
            // Fallback to direct curl
            execSync(`curl -f http://${this.config.host}:${this.config.port}/ >/dev/null 2>&1`, {
              stdio: 'pipe'
            });
          }
        }

        console.log('✅ Application is ready');
        return;
      } catch (error) {
        // Not ready yet, continue waiting
      }

      if (counter === 60) {
        console.log('⏳ Application is taking longer than expected to start...');
      }

      await new Promise(resolve => setTimeout(resolve, 1000));
      counter++;
    }

    // If we get here, the application didn't start in time
    console.error(`❌ Application failed to start within ${timeout} seconds`);
    await this.showContainerLogs();
    throw new Error('Application startup timeout');
  }

  /**
   * Save container logs to test results for debugging
   */
  async showContainerLogs() {
    const logDir = path.join(projectRoot, 'tests', 'e2e', 'test-results');
    const containerLogFile = path.join(logDir, `container-logs-${this.testRunId}.txt`);
    const serverLogFile = path.join(logDir, `server-logs-${this.testRunId}.txt`);

    console.log(`📋 Container logs saved to: ${path.relative(projectRoot, containerLogFile)}`);
    console.log(`📋 Server logs saved to: ${path.relative(projectRoot, serverLogFile)}`);

    try {
      // Ensure test results directory exists
      fs.mkdirSync(logDir, { recursive: true });

      // Get container logs (startup script output)
      let containerLogs;
      if (this.usePodman) {
        containerLogs = execSync(`${this.containerCmd} logs ${this.containerName}`, {
          encoding: 'utf8',
          cwd: projectRoot
        });
      } else {
        containerLogs = execSync(`${this.composeCmd} -f docker-compose.test.yml logs`, {
          encoding: 'utf8',
          cwd: projectRoot
        });
      }

      // Get server logs (Flask application logs from inside container)
      let serverLogs = '';
      try {
        if (this.usePodman) {
          serverLogs = execSync(`${this.containerCmd} exec ${this.containerName} cat /app/log/server.log`, {
            encoding: 'utf8',
            cwd: projectRoot
          });
        } else {
          // For compose, we need to get the service name
          serverLogs = execSync(`${this.composeCmd} -f docker-compose.test.yml exec -T pdf-tei-editor-test cat /app/log/server.log`, {
            encoding: 'utf8',
            cwd: projectRoot
          });
        }
      } catch (serverLogError) {
        const errorMessage = serverLogError instanceof Error ? serverLogError.message : String(serverLogError);
        serverLogs = `Could not retrieve server logs: ${errorMessage}`;
      }

      fs.writeFileSync(containerLogFile, containerLogs);
      fs.writeFileSync(serverLogFile, serverLogs);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error('Could not save container logs:', errorMessage);
    }
  }

  /**
   * Clean up stale Docker/Podman images while preserving cached layers
   *
   * This prevents accumulation of '<none>' tagged images that are created during
   * multi-stage Docker builds. The cleanup strategy:
   * 1. Removes dangling images (untagged intermediate build artifacts)
   * 2. Preserves recent images (last 24 hours) that may contain useful cached layers
   * 3. Removes older stale images that are no longer needed
   *
   * This balances cleanup with build performance by keeping useful cache layers.
   */
  async cleanupStaleImages() {
    try {
      console.log('🧹 Cleaning up stale images...');

      // Remove dangling images (untagged <none> images) that are not part of build cache
      // This removes intermediate build images that are no longer needed
      const cleanupCmd = `${this.containerCmd} image prune -f --filter "dangling=true"`;
      const result = execSync(cleanupCmd, {
        encoding: 'utf8',
        stdio: 'pipe'
      });

      if (result.trim()) {
        console.log('🗑️ Removed dangling images:', result.trim());
      }

      // Additionally, remove old untagged project-specific images
      // Get all <none> images and filter for ones that likely came from our builds
      try {
        const listCmd = `${this.containerCmd} images --filter "dangling=true" --format "{{.ID}} {{.CreatedAt}}"`;
        const danglingImages = execSync(listCmd, {
          encoding: 'utf8',
          stdio: 'pipe'
        }).trim();

        if (danglingImages) {
          const lines = danglingImages.split('\n');
          let removedCount = 0;

          // Keep only recent dangling images (last 24 hours) as they might be useful cache
          const oneDayAgo = Date.now() - (24 * 60 * 60 * 1000);

          for (const line of lines) {
            const [imageId, createdAt] = line.split(' ', 2);
            if (imageId && createdAt) {
              // Parse the creation date - container tools use different formats
              const createdDate = new Date(createdAt);

              // Remove if older than 24 hours (keeping recent ones as cache)
              if (createdDate.getTime() < oneDayAgo) {
                try {
                  execSync(`${this.containerCmd} rmi ${imageId}`, {
                    stdio: 'ignore'
                  });
                  removedCount++;
                } catch (error) {
                  // Image might be in use, skip silently
                }
              }
            }
          }

          if (removedCount > 0) {
            console.log(`🗑️ Removed ${removedCount} stale image(s) older than 24 hours`);
          }
        }
      } catch (error) {
        // Ignore errors in additional cleanup - the main prune should have worked
      }

    } catch (error) {
      // Don't fail the build if cleanup fails
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.log('⚠️ Image cleanup failed (continuing anyway):', errorMessage);
    }
  }

  /**
   * Build container image only (no tests)
   */
  async buildImage() {
    console.log('🏗️ Building container image only...');
    console.log(`🆔 Build ID: ${this.testRunId}`);

    try {
      if (this.usePodman) {
        console.log('🏗️ Building test image with podman...');
        execSync(`${this.containerCmd} build -t pdf-tei-editor-test:latest --target test .`, {
          stdio: 'inherit',
          cwd: projectRoot
        });
      } else {
        console.log('🏗️ Building test image with docker...');
        execSync(`${this.containerCmd} build -t pdf-tei-editor-test:latest --target test .`, {
          stdio: 'inherit',
          cwd: projectRoot
        });
      }

      // Clean up dangling images to prevent accumulation while preserving cache
      await this.cleanupStaleImages();

      console.log('✅ Image built successfully: pdf-tei-editor-test:latest');
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error('❌ Failed to build image:', errorMessage);
      throw error;
    }
  }

  /**
   * Stop and clean up the test container
   */
  async cleanup() {
    if (!this.isContainerStarted) return;

    console.log('🛑 Cleaning up test environment...');

    try {
      if (this.usePodman) {
        // Direct container cleanup
        if (this.containerCmd && this.containerName) {
          // Clean up any containers using the configured port
          try {
            const existingContainers = execSync(
              `${this.containerCmd} ps -a --format "table {{.ID}}\\t{{.Ports}}" | grep ":${this.config.port}->" | awk '{print $1}'`,
              { encoding: 'utf8', stdio: 'pipe' }
            ).trim();

            if (existingContainers) {
              console.log(`🛑 Stopping all containers using port ${this.config.port}...`);
              execSync(`echo "${existingContainers}" | xargs -r ${this.containerCmd} stop`, { stdio: 'ignore' });
              execSync(`echo "${existingContainers}" | xargs -r ${this.containerCmd} rm`, { stdio: 'ignore' });
            }
          } catch (error) {
            // Ignore cleanup errors
          }

          // Clean up specific test container
          execSync(`${this.containerCmd} stop ${this.containerName}`, { stdio: 'ignore' });
          execSync(`${this.containerCmd} rm -f ${this.containerName}`, { stdio: 'ignore' });
          console.log('🛑 Container stopped and removed');
        }
      } else {
        // Compose cleanup
        if (this.composeCmd) {
          execSync(`${this.composeCmd} -f docker-compose.test.yml down --remove-orphans --volumes`, {
            stdio: 'ignore',
            cwd: projectRoot
          });
          console.log('🛑 Compose environment stopped');
        }
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.log('⚠️ Error during cleanup (may be expected):', errorMessage);
    }

    console.log('✅ Cleanup completed');
    this.isContainerStarted = false;
  }

  /**
   * Run Playwright browser tests
   * @param {Object} options - Playwright options
   * @param {string} [options.browser] - Browser to use
   * @param {boolean} [options.headed] - Run in headed mode
   * @param {boolean} [options.debug] - Run in debug mode
   * @param {string} [options.mode] - Test mode
   * @param {boolean} [options.noRebuild] - Skip rebuild
   * @param {string} [options.grep] - Grep pattern
   * @param {string} [options.grepInvert] - Grep invert pattern
   * @param {string[]} [options.envVars] - Environment variables for container
   * @param {Number} [options.workers] - Number of workers for parallel execution
   * @param {boolean} [options.failFast] - Abort on first test failure
   */
  async runPlaywrightTests(options = {}) {
    console.log('🧪 Unified E2E Runner - Playwright Browser Tests');
    console.log('=================================================\n');
    console.log(`🆔 Test Run ID: ${this.testRunId}`);
    console.log(`🌐 Browser: ${options.browser || 'chromium'}`);
    console.log(`👁️ Mode: ${options.headed ? 'headed' : 'headless'}`);
    console.log(`🏗️ Environment: ${options.mode || 'production'}`);

    try {
      // Check if npx is available
      try {
        execSync('command -v npx', { stdio: 'ignore' });
      } catch {
        throw new Error('Node.js/npm is required but not installed');
      }

      // Check if Playwright is installed before building container
      console.log('🔍 Checking Playwright installation...');
      try {
        execSync('npx playwright --version', { stdio: 'pipe' });
        console.log('✅ Playwright is available');
      } catch (error) {
        throw new Error(
          'Playwright is not installed. Please install it first:\n' +
          '  npm install @playwright/test\n' +
          '  npx playwright install\n' +
          'Or run: npm install'
        );
      }

      // Process environment variables and start containerized environment
      const processedEnvVars = this.processEnvironmentVariables(options.envVars || []);
      await this.startContainer(options.noRebuild, processedEnvVars);

      // Build Playwright command
      let cmd = ['playwright', 'test'];

      if (options.browser) {
        cmd.push(`--project=${options.browser}`);
      }
      if (options.headed) {
        cmd.push('--headed');
      }
      if (options.debug) {
        cmd.push('--debug');
      }
      if (options.workers) {
        cmd.push('--workers', String(options.workers));
      }
      // Add user's grep pattern if specified
      if (options.grep) {
        cmd.push('--grep', options.grep);
      }

      // Add user's grep-invert pattern if specified
      if (options.grepInvert) {
        cmd.push('--grep-invert', options.grepInvert);
      }

      // Add fail-fast option if specified
      if (options.failFast) {
        cmd.push('--max-failures=1');
      }

      console.log(`🚀 Executing: npx ${cmd.join(' ')}`);

      // Run Playwright tests
      const testProcess = spawn('npx', cmd, {
        stdio: 'inherit',
        cwd: projectRoot,
        env: {
          ...process.env,
          ...this.getEnvironmentVars()
        }
      });

      return new Promise((resolve, reject) => {
        testProcess.on('exit', async (/** @type {number | null} */ code) => {
          if (code === 0) {
            console.log('🎉 All tests passed!');
            await this.cleanup();
            resolve(code);
          } else {
            console.log('💥 Some tests failed!');
            await this.showContainerLogs();
            await this.cleanup();
            reject(new Error(`Tests failed with exit code ${code}`));
          }
        });

        testProcess.on('error', async (/** @type {Error} */ error) => {
          const errorMessage = error instanceof Error ? error.message : String(error);
          console.error('💥 Playwright process error:', errorMessage);
          await this.cleanup();
          reject(error);
        });
      });

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error('💥 Playwright runner failed:', errorMessage);
      await this.cleanup();
      throw error;
    }
  }

  /**
   * Run a backend test file with the containerized environment
   * @param {string} testFile - Path to the test file to run
   */
  /**
   * Collect all backend API test files recursively from tests/e2e
   * @param {string} [grep] - Grep pattern to filter test names
   * @param {string} [grepInvert] - Grep invert pattern to exclude test names
   * @returns {Promise<string[]>} Array of test file paths
   */
  async collectBackendTests(grep, grepInvert) {
    const { glob } = await import('glob');
    const testPattern = path.join(__dirname, 'e2e', '**/*.test.js');

    let testFiles = await glob(testPattern);

    // Apply grep filtering if specified
    if (grep) {
      const grepRegex = new RegExp(grep, 'i');
      testFiles = testFiles.filter(file => grepRegex.test(path.basename(file)));
    }

    // Apply grep-invert filtering if specified
    if (grepInvert) {
      const grepInvertRegex = new RegExp(grepInvert, 'i');
      testFiles = testFiles.filter(file => !grepInvertRegex.test(path.basename(file)));
    }

    return testFiles;
  }

  /**
   * Run all backend API tests in a single container session
   * @param {Object} options - Backend test options
   * @param {string} [options.grep] - Grep pattern to filter tests
   * @param {string} [options.grepInvert] - Grep invert pattern to exclude tests
   * @param {string[]} [options.envVars] - Environment variables for container
   * @param {boolean} [options.noRebuild] - Skip container rebuild
   * @param {boolean} [options.failFast] - Abort on first test failure
   */
  async runBackendTests(options = {}) {
    console.log('🧪 Unified E2E Runner - Backend API Tests');
    console.log('==========================================\n');
    console.log(`🆔 Test Run ID: ${this.testRunId}`);

    try {
      // Collect all backend test files
      const testFiles = await this.collectBackendTests(options.grep, options.grepInvert);

      if (testFiles.length === 0) {
        console.log('⚠️ No backend test files found matching the criteria');
        return;
      }

      console.log(`📋 Found ${testFiles.length} backend test file(s):`);
      testFiles.forEach(file => {
        console.log(`  - ${path.relative(projectRoot, file)}`);
      });

      if (options.grep) {
        console.log(`🔍 Grep filter: ${options.grep}`);
      }
      if (options.grepInvert) {
        console.log(`🚫 Grep invert filter: ${options.grepInvert}`);
      }

      // Start containerized environment once
      await this.startContainer(options.noRebuild, options.envVars || []);

      let passedTests = 0;
      let failedTests = 0;
      const failedTestDetails = [];
      let skippedTests = 0;
      const skippedTestFiles = [];

      // Run each test file sequentially
      for (let i = 0; i < testFiles.length; i++) {
        const testFile = testFiles[i];
        const relativePath = path.relative(projectRoot, testFile);

        // If fail-fast is enabled and we've already had a failure, skip remaining tests
        if (options.failFast && failedTests > 0) {
          skippedTests++;
          skippedTestFiles.push(relativePath);
          console.log(`⏭️ ${relativePath} - SKIPPED (fail-fast enabled)`);
          continue;
        }

        console.log(`\n🧪 Running: ${relativePath}`);

        try {
          const testProcess = spawn('node', [testFile], {
            stdio: 'pipe', // Capture output instead of inherit
            cwd: projectRoot,
            env: {
              ...process.env,
              ...this.getEnvironmentVars()
            }
          });

          const testResult = await new Promise((resolve) => {
            let stdout = '';
            let stderr = '';

            testProcess.stdout.on('data', (data) => {
              stdout += data.toString();
            });

            testProcess.stderr.on('data', (data) => {
              stderr += data.toString();
            });

            testProcess.on('exit', (code) => {
              resolve({ code, stdout, stderr });
            });

            testProcess.on('error', (error) => {
              resolve({ code: 1, stdout, stderr: error.message });
            });
          });

          // Always show test output
          if (testResult.stdout) {
            console.log(testResult.stdout);
          }
          if (testResult.stderr) {
            console.error(testResult.stderr);
          }

          if (testResult.code === 0) {
            passedTests++;
            console.log(`✅ ${relativePath} - PASSED`);
          } else {
            failedTests++;
            console.log(`❌ ${relativePath} - FAILED`);
            failedTestDetails.push({
              file: relativePath,
              exitCode: testResult.code,
              stderr: testResult.stderr
            });

            // If fail-fast is enabled, stop running remaining tests
            if (options.failFast) {
              // Mark remaining tests as skipped
              for (let j = i + 1; j < testFiles.length; j++) {
                const skippedFile = testFiles[j];
                const skippedPath = path.relative(projectRoot, skippedFile);
                skippedTests++;
                skippedTestFiles.push(skippedPath);
                console.log(`⏭️ ${skippedPath} - SKIPPED (fail-fast enabled)`);
              }
              break;
            }
          }

        } catch (error) {
          failedTests++;
          const errorMessage = error instanceof Error ? error.message : String(error);
          console.log(`❌ ${relativePath} - ERROR: ${errorMessage}`);
          failedTestDetails.push({
            file: relativePath,
            exitCode: 1,
            stderr: errorMessage
          });

          // If fail-fast is enabled, stop running remaining tests
          if (options.failFast) {
            // Mark remaining tests as skipped
            for (let j = i + 1; j < testFiles.length; j++) {
              const skippedFile = testFiles[j];
              const skippedPath = path.relative(projectRoot, skippedFile);
              skippedTests++;
              skippedTestFiles.push(skippedPath);
              console.log(`⏭️ ${skippedPath} - SKIPPED (fail-fast enabled)`);
            }
            break;
          }
        }
      }

      // Report final results
      console.log('\n📊 Backend Test Results Summary');
      console.log('==============================');
      console.log(`✅ Passed: ${passedTests}`);
      console.log(`❌ Failed: ${failedTests}`);
      if (skippedTests > 0) {
        console.log(`⏭️ Skipped: ${skippedTests}`);
      }
      console.log(`📊 Total:  ${passedTests + failedTests + skippedTests}`);

      if (failedTests > 0) {
        console.log('\n💥 Failed Tests:');
        failedTestDetails.forEach(failure => {
          console.log(`  - ${failure.file} (exit code: ${failure.exitCode})`);
          if (failure.stderr) {
            console.log(`    Error: ${failure.stderr.trim()}`);
          }
        });

        if (skippedTests > 0 && options.failFast) {
          console.log('\n⏭️ Skipped Tests (due to fail-fast):');
          skippedTestFiles.forEach(file => {
            console.log(`  - ${file}`);
          });
        }

        // Save container and server logs for debugging
        await this.showContainerLogs();

        // Cleanup container after saving logs
        await this.cleanup();

        const errorMessage = options.failFast && skippedTests > 0
          ? `${failedTests} backend test(s) failed, ${skippedTests} skipped (fail-fast enabled)`
          : `${failedTests} backend test(s) failed`;
        throw new Error(errorMessage);
      } else {
        console.log('\n🎉 All backend tests passed!');

        // Cleanup container for successful tests
        await this.cleanup();
      }

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error('💥 Backend test runner failed:', errorMessage);
      await this.cleanup();
      throw error;
    }
  }

  /**
   * Get environment variables for test processes
   */
  getEnvironmentVars() {
    return {
      E2E_CONTAINER_URL: `http://${this.config.host}:${this.config.port}`,
      E2E_HOST: this.config.host,
      E2E_PORT: this.config.port.toString(),
      E2E_CONTAINER_NAME: this.containerName,
      E2E_CONTAINER_CMD: this.containerCmd || undefined
    };
  }

  /**
   * Provide container environment info to test processes
   */
  static getContainerInfo() {
    const host = process.env.E2E_HOST || 'localhost';
    const port = process.env.E2E_PORT || '8000';
    return {
      host,
      port: parseInt(port),
      url: process.env.E2E_CONTAINER_URL || `http://${host}:${port}`,
      containerName: process.env.E2E_CONTAINER_NAME,
      containerCmd: process.env.E2E_CONTAINER_CMD
    };
  }
}

/**
 * Parse command line arguments
 */
/**
 * @param {string[]} args
 */
function parseArgs(args) {
  const parsed = {
    playwright: false,
    backend: false,
    browser: 'chromium',
    headed: false,
    debug: false,
    grep: /** @type {string | null} */ (null),
    grepInvert: /** @type {string | null} */ (null),
    testFile: /** @type {string | null} */ (null),
    help: false,
    noRebuild: false,
    buildOnly: false,
    mode: 'production',  // default to production mode
    /** @type {string[]} */
    envVars: [],
    /** @type {string | null} */
    dotenvPath: null,
    /** @type {Number} */
    workers: 1,
    failFast: false
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    switch (arg) {
      case '--playwright':
        parsed.playwright = true;
        break;
      case '--backend':
        parsed.backend = true;
        break;
      case '--browser':
        parsed.browser = args[++i];
        break;
      case '--headed':
        parsed.headed = true;
        break;
      case '--debug':
        parsed.debug = true;
        break;
      case '--grep':
        parsed.grep = args[++i] || '';
        break;
      case '--grep-invert':
        parsed.grepInvert = args[++i] || '';
        break;
      case '--no-rebuild':
        parsed.noRebuild = true;
        break;
      case '--build-only':
        parsed.buildOnly = true;
        break;
      case '--mode':
        parsed.mode = args[++i];
        break;
      case '--development':
        parsed.mode = 'development';
        break;
      case '--production':
        parsed.mode = 'production';
        break;
      case '--workers':
        parsed.workers = Number(args[++i]);
        if (isNaN(parsed.workers)) {
          throw new Error("--workers option must be a number")
        }
        break;
      case '--env':
        const envVar = args[++i];
        if (envVar) {
          parsed.envVars.push(envVar);
        }
        break;
      case '--dotenv-path':
        parsed.dotenvPath = args[++i];
        break;
      case '--fail-fast':
        parsed.failFast = true;
        break;
      case '--help':
      case '-h':
        parsed.help = true;
        break;
      default:
        if (!arg.startsWith('--') && !parsed.testFile) {
          parsed.testFile = arg;
        }
        break;
    }
  }

  return parsed;
}

/**
 * Show help message
 */
function showHelp() {
  console.log('Unified Cross-platform E2E Test Runner');
  console.log('======================================');
  console.log('');
  console.log('Usage:');
  console.log('  # Playwright browser tests');
  console.log('  node tests/e2e-runner.js --playwright [options]');
  console.log('');
  console.log('  # Backend API tests (all *.test.js files in tests/e2e)');
  console.log('  node tests/e2e-runner.js --backend [options]');
  console.log('');
  console.log('');
  console.log('Common Options:');
  console.log('  --grep <pattern>     Run tests matching pattern');
  console.log('  --grep-invert <pattern> Exclude tests matching pattern');
  console.log('  --fail-fast          Abort on first test failure and skip remaining tests');
  console.log('  --no-rebuild         Use existing container image without rebuilding');
  console.log('  --build-only         Build container image only, do not run tests');
  console.log('  --env <var>          Environment variable to pass to container (can be used multiple times)');
  console.log('  --dotenv-path <path> Path to .env file to load (default: .env)');
  console.log('');
  console.log('Playwright Options:');
  console.log('  --browser <name>     Browser to use (chromium|firefox|webkit) [default: chromium]');
  console.log('  --headed             Run tests in headed mode (show browser)');
  console.log('  --debug              Enable debug mode');
  console.log('  --mode <mode>        Environment mode (production|development) [default: production]');
  console.log('  --production         Use production mode');
  console.log('  --development        Use development mode');
  console.log('  --workers <number>   Number of workers (default:1, which runs the tests in sequence)');
  console.log('');
  console.log('Environment Variables:');
  console.log('  E2E_HOST           Host to bind container (default: localhost)');
  console.log('  E2E_PORT           Port to expose container on host (default: 8000)');
  console.log('  E2E_CONTAINER_PORT Port inside container (default: 8000)');
  console.log('');
  console.log('Examples:');
  console.log('  # Run Playwright tests');
  console.log('  node tests/e2e-runner.js --playwright');
  console.log('  node tests/e2e-runner.js --playwright --browser firefox --headed');
  console.log('  node tests/e2e-runner.js --playwright --grep-invert @dev-only');
  console.log('');
  console.log('  # Run backend API tests');
  console.log('  node tests/e2e-runner.js --backend');
  console.log('  node tests/e2e-runner.js --backend --grep "file-locks"');
  console.log('  node tests/e2e-runner.js --backend --grep-invert "extractor"');
  console.log('');
  console.log('  # Run with existing image (faster)');
  console.log('  node tests/e2e-runner.js --playwright --no-rebuild');
  console.log('  node tests/e2e-runner.js --backend --no-rebuild');
  console.log('');
  console.log('  # Fail-fast mode (stop on first failure)');
  console.log('  node tests/e2e-runner.js --playwright --fail-fast');
  console.log('  node tests/e2e-runner.js --backend --fail-fast');
  console.log('');
  console.log('  # Build image only (no tests)');
  console.log('  node tests/e2e-runner.js --build-only');
  console.log('');
  console.log('  # Custom port');
  console.log('  E2E_PORT=8001 node tests/e2e-runner.js --playwright --debug');
  console.log('');
  console.log('  # Custom environment file');
  console.log('  node tests/e2e-runner.js --backend --dotenv-path .env.testing');
  console.log('');
}

// Main execution
async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help || (process.argv.length === 2)) {
    showHelp();
    process.exit(0);
  }

  const runner = new E2ERunner();

  // Set custom dotenv path if provided
  if (args.dotenvPath) {
    runner.setDotenvPath(args.dotenvPath);
  }

  try {

    if (args.buildOnly) {
      // Build image only
      await runner.buildImage();
      process.exit(0);
    }

    if (args.playwright || args.backend) {
      if (args.playwright) {
        // Run Playwright browser tests
        await runner.runPlaywrightTests({
          browser: args.browser,
          headed: args.headed,
          debug: args.debug,
          grep: args.grep || undefined,
          grepInvert: args.grepInvert || undefined,
          noRebuild: args.noRebuild,
          mode: args.mode,
          envVars: args.envVars,
          workers: args.workers,
          failFast: args.failFast
        });
      }

      if (args.backend) {
        // Run all backend API tests
        await runner.runBackendTests({
          grep: args.grep || undefined,
          grepInvert: args.grepInvert || undefined,
          noRebuild: args.noRebuild,
          envVars: args.envVars,
          failFast: args.failFast
        });
      }

      // tests have all passed, return success code
      process.exit(0);

    }

    console.error('❌ Either --build-only, --playwright or --backend must be specified');
    console.log('');
    showHelp();
    process.exit(1);

  } catch (error) {
    console.error('💥 Runner failed:', String(error));
    process.exit(1);
  }
}

// Export for use as module
export { E2ERunner };

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(error => {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error('Unexpected error:', errorMessage);
    process.exit(1);
  });
}