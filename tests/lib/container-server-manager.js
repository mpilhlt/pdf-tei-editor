import { ServerManager } from './server-manager.js';
import { getPortWithFallback } from './port-allocator.js';
import { execSync } from 'child_process';
import { promises as fs } from 'fs';
import { join, relative } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Container-based server manager for CI and isolated testing.
 *
 * Manages FastAPI server lifecycle in Docker/Podman containers:
 * - Detects Docker or Podman
 * - Builds or reuses container images
 * - Starts containerized server
 * - Waits for /health endpoint
 * - Cleanup on exit
 * - Log extraction for debugging
 *
 * @extends ServerManager
 */
export class ContainerServerManager extends ServerManager {
  constructor(options = {}) {
    super();
    this.projectRoot = join(__dirname, '..', '..');
    this.containerCmd = null;
    this.composeCmd = null;
    this.usePodman = false;
    this.testRunId = `test-${Date.now()}-${process.pid}`;
    this.containerName = `pdf-tei-editor-test-${this.testRunId}`;
    this.isContainerStarted = false;

    // Configuration: options take precedence over environment variables
    // Port will be auto-selected during start() if not explicitly specified
    this.config = {
      host: options.host || process.env.E2E_HOST || 'localhost',
      explicitPort: options.port, // Explicit port from options (undefined if not set)
      port: null, // Actual port, set during start()
      containerPort: options.containerPort || parseInt(process.env.E2E_CONTAINER_PORT || '8011'),
    };

    // Detect container tool
    this.detectContainerTool();
  }

  /**
   * @inheritdoc
   */
  getType() {
    return 'container';
  }

  /**
   * @inheritdoc
   */
  getBaseUrl() {
    if (!this.isContainerStarted) {
      throw new Error('Container is not running');
    }
    return `http://${this.config.host}:${this.config.port}`;
  }

  /**
   * Detect available container tool (podman or docker) with compose support
   *
   * @private
   */
  detectContainerTool() {
    try {
      execSync('command -v podman', { stdio: 'ignore' });
      this.containerCmd = 'podman';
      this.usePodman = true;
      console.log('🐙 Using podman as container tool');
      console.log('📦 Preferring native podman commands over compose tools');

      // Check for compose tools (for compatibility)
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
   * Build container image
   *
   * @private
   * @param {boolean} noRebuild - Skip rebuilding the container image
   */
  async buildImage(noRebuild = false) {
    if (noRebuild) {
      console.log('⏭️ Skipping image build (using existing image)...');
      // Check if the image exists
      try {
        execSync(`${this.containerCmd} image exists pdf-tei-editor-test:latest`, {
          stdio: 'ignore',
        });
        console.log('✅ Found existing pdf-tei-editor-test:latest image');
      } catch {
        throw new Error(
          'No existing pdf-tei-editor-test:latest image found. Run without noRebuild first.'
        );
      }
    } else {
      console.log('🏗️ Building test image...');
      execSync(
        `${this.containerCmd} build -t pdf-tei-editor-test:latest --target test .`,
        {
          stdio: 'inherit',
          cwd: this.projectRoot,
        }
      );

      // Clean up dangling images to prevent accumulation while preserving cache
      await this.cleanupStaleImages();
    }
  }

  /**
   * Clean up stale Docker/Podman images while preserving cached layers
   *
   * @private
   */
  async cleanupStaleImages() {
    try {
      console.log('🧹 Cleaning up stale images...');

      // Remove dangling images (untagged <none> images)
      const cleanupCmd = `${this.containerCmd} image prune -f --filter "dangling=true"`;
      const result = execSync(cleanupCmd, {
        encoding: 'utf8',
        stdio: 'pipe',
      });

      if (result.trim()) {
        console.log('🗑️ Removed dangling images:', result.trim());
      }

      // Remove old untagged images (older than 24 hours)
      try {
        const listCmd = `${this.containerCmd} images --filter "dangling=true" --format "{{.ID}} {{.CreatedAt}}"`;
        const danglingImages = execSync(listCmd, {
          encoding: 'utf8',
          stdio: 'pipe',
        }).trim();

        if (danglingImages) {
          const lines = danglingImages.split('\n');
          let removedCount = 0;
          const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;

          for (const line of lines) {
            const [imageId, createdAt] = line.split(' ', 2);
            if (imageId && createdAt) {
              const createdDate = new Date(createdAt);
              if (createdDate.getTime() < oneDayAgo) {
                try {
                  execSync(`${this.containerCmd} rmi ${imageId}`, { stdio: 'ignore' });
                  removedCount++;
                } catch (err) {
                  // Image might be in use, skip
                }
              }
            }
          }

          if (removedCount > 0) {
            console.log(`🗑️ Removed ${removedCount} stale image(s) older than 24 hours`);
          }
        }
      } catch (err) {
        // Ignore errors in additional cleanup
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      console.log('⚠️ Image cleanup failed (continuing anyway):', errorMessage);
    }
  }

  /**
   * Start container using direct container commands (Podman preferred)
   *
   * @private
   * @param {boolean} noRebuild - Skip rebuilding the container image
   * @param {Object.<string, string>} env - Environment variables
   */
  async startDirectContainer(noRebuild = false, env = {}) {
    // Clean up any existing containers using the configured port
    console.log('🧹 Cleaning up existing containers...');
    try {
      const existingContainers = execSync(
        `${this.containerCmd} ps -a --format "table {{.ID}}\\t{{.Ports}}" | grep ":${this.config.port}->" | awk '{print $1}'`,
        { encoding: 'utf8', stdio: 'pipe' }
      ).trim();

      if (existingContainers) {
        console.log(`🛑 Stopping existing containers using port ${this.config.port}...`);
        execSync(`echo "${existingContainers}" | xargs -r ${this.containerCmd} stop`, {
          stdio: 'ignore',
        });
        execSync(`echo "${existingContainers}" | xargs -r ${this.containerCmd} rm`, {
          stdio: 'ignore',
        });
      }
    } catch (err) {
      // Ignore cleanup errors
    }

    // Clean up existing container with our name
    try {
      execSync(`${this.containerCmd} rm -f ${this.containerName}`, { stdio: 'ignore' });
    } catch (err) {
      // Ignore if container doesn't exist
    }

    // Build image
    await this.buildImage(noRebuild);

    // Start container with test environment
    console.log('🚀 Starting test container...');
    const portMapping = `${this.config.port}:${this.config.containerPort}`;

    // Build environment arguments
    const testEnvVars = ['TEST_IN_PROGRESS=1'];
    for (const [key, value] of Object.entries(env)) {
      testEnvVars.push(`${key}=${value}`);
    }

    const envArgs =
      testEnvVars.length > 0 ? testEnvVars.map((e) => `--env ${e}`).join(' ') : '';

    const runCmd = `${this.containerCmd} run -d --name ${this.containerName} -p ${portMapping} ${envArgs} pdf-tei-editor-test:latest`;
    const containerId = execSync(runCmd, {
      encoding: 'utf8',
      cwd: this.projectRoot,
    }).trim();
    console.log(`🆔 Container ID: ${containerId}`);
  }

  /**
   * Start container using compose commands (Docker preferred)
   *
   * @private
   * @param {boolean} noRebuild - Skip rebuilding the container image
   * @param {Object.<string, string>} env - Environment variables
   */
  async startComposeContainer(noRebuild = false, env = {}) {
    console.log('🏗️ Using compose commands...');

    // Clean up any existing containers
    try {
      execSync(`${this.composeCmd} -f docker-compose.test.yml down --remove-orphans --volumes`, {
        stdio: 'ignore',
        cwd: this.projectRoot,
      });
    } catch (err) {
      // Ignore cleanup errors
    }

    // Prepare environment variables
    const testEnv = { ...process.env, TEST_IN_PROGRESS: '1', ...env };

    // Start the test environment
    if (noRebuild) {
      console.log('🚀 Starting test environment with compose (no rebuild)...');
      execSync(`${this.composeCmd} -f docker-compose.test.yml up --no-build -d`, {
        stdio: 'pipe',
        cwd: this.projectRoot,
        env: testEnv,
      });
    } else {
      console.log('🚀 Starting test environment with compose...');
      execSync(`${this.composeCmd} -f docker-compose.test.yml up --build -d`, {
        stdio: 'pipe',
        cwd: this.projectRoot,
        env: testEnv,
      });

      // Clean up dangling images
      await this.cleanupStaleImages();
    }
  }

  /**
   * Wait for the application to be ready
   *
   * @private
   * @param {number} timeoutSec - Timeout in seconds
   */
  async waitForApplicationReady(timeoutSec = 120) {
    console.log('⏳ Waiting for application to be ready...');

    let counter = 0;

    while (counter < timeoutSec) {
      try {
        if (this.usePodman) {
          // Check if container is running and application is responding
          const healthCheckUrl = `http://${this.config.host}:${this.config.containerPort}/health`;
          execSync(
            `${this.containerCmd} exec ${this.containerName} curl -f ${healthCheckUrl} >/dev/null 2>&1`,
            { stdio: 'pipe' }
          );
        } else {
          // Use curl from host
          execSync(`curl -f http://${this.config.host}:${this.config.port}/health >/dev/null 2>&1`, {
            stdio: 'pipe',
          });
        }

        console.log('✅ Application is ready');
        return;
      } catch (err) {
        // Not ready yet, continue waiting
      }

      if (counter === 60) {
        console.log('⏳ Application is taking longer than expected to start...');
      }

      await new Promise((resolve) => setTimeout(resolve, 1000));
      counter++;
    }

    // If we get here, the application didn't start in time
    console.error(`❌ Application failed to start within ${timeoutSec} seconds`);
    await this.showContainerLogs();
    throw new Error('Application startup timeout');
  }

  /**
   * Show and save container logs for debugging
   *
   * @private
   */
  async showContainerLogs() {
    const logDir = join(this.projectRoot, 'tests', 'e2e', 'test-results');
    const containerLogFile = join(logDir, `container-logs-${this.testRunId}.txt`);
    const serverLogFile = join(logDir, `server-logs-${this.testRunId}.txt`);

    console.log(
      `📋 Container logs saved to: ${relative(this.projectRoot, containerLogFile)}`
    );
    console.log(`📋 Server logs saved to: ${relative(this.projectRoot, serverLogFile)}`);

    try {
      // Ensure test results directory exists
      await fs.mkdir(logDir, { recursive: true });

      // Get container logs (startup script output)
      let containerLogs;
      if (this.usePodman) {
        containerLogs = execSync(`${this.containerCmd} logs ${this.containerName}`, {
          encoding: 'utf8',
          cwd: this.projectRoot,
        });
      } else {
        containerLogs = execSync(`${this.composeCmd} -f docker-compose.test.yml logs`, {
          encoding: 'utf8',
          cwd: this.projectRoot,
        });
      }

      // Get server logs (application logs from inside container)
      let serverLogs = '';
      try {
        if (this.usePodman) {
          serverLogs = execSync(
            `${this.containerCmd} exec ${this.containerName} cat /app/log/server.log`,
            {
              encoding: 'utf8',
              cwd: this.projectRoot,
            }
          );
        } else {
          serverLogs = execSync(
            `${this.composeCmd} -f docker-compose.test.yml exec -T pdf-tei-editor-test cat /app/log/server.log`,
            {
              encoding: 'utf8',
              cwd: this.projectRoot,
            }
          );
        }
      } catch (serverLogError) {
        const errorMessage =
          serverLogError instanceof Error ? serverLogError.message : String(serverLogError);
        serverLogs = `Could not retrieve server logs: ${errorMessage}`;
      }

      await fs.writeFile(containerLogFile, containerLogs, 'utf-8');
      await fs.writeFile(serverLogFile, serverLogs, 'utf-8');
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      console.error('Could not save container logs:', errorMessage);
    }
  }

  /**
   * @inheritdoc
   */
  async isHealthy(timeoutMs = 5000) {
    try {
      const response = await fetch(this.getBaseUrl() + '/health', {
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (response.ok) {
        const data = await response.json();
        if (data.status === 'ok') {
          console.log(`[SUCCESS] Health check passed: ${JSON.stringify(data)}`);
          return true;
        }
        console.error(`[ERROR] Health check failed: ${JSON.stringify(data)}`);
        return false;
      }
      return false;
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      console.error(`[ERROR] Health check failed: ${errorMessage}`);
      return false;
    }
  }

  /**
   * @inheritdoc
   */
  async start(options = {}) {
    const { noRebuild = false, env = {}, verbose = false } = options;

    // Resolve port - use explicit port if specified, otherwise find available port
    if (this.config.explicitPort) {
      // Explicit port specified - use it directly
      this.config.port = this.config.explicitPort;
      console.log(`[INFO] Using explicitly specified port ${this.config.port} for container`);
    } else {
      // No explicit port - auto-select available port in 8010+ range
      this.config.port = await getPortWithFallback(8011, 8011, 8999);
      console.log(`[INFO] Auto-selected available port ${this.config.port} for container`);
    }

    console.log('🚀 Starting containerized test environment...');
    console.log(`🆔 Test Run ID: ${this.testRunId}`);

    try {
      if (this.usePodman) {
        await this.startDirectContainer(noRebuild, env);
      } else {
        await this.startComposeContainer(noRebuild, env);
      }

      this.isContainerStarted = true;
      console.log('✅ Container started successfully');

      // Wait for application to be ready
      await this.waitForApplicationReady();

      return this.getBaseUrl();
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      console.error('❌ Failed to start container:', errorMessage);
      throw err;
    }
  }

  /**
   * @inheritdoc
   */
  async stop(options = {}) {
    const { keepRunning = false } = options;

    if (keepRunning) {
      console.warn('\n[WARNING] Skipping cleanup (keepRunning=true)');
      console.log(`[INFO] Container still running: ${this.containerName}`);
      console.log(`[INFO] Base URL: ${this.getBaseUrl()}`);
      return;
    }

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
              execSync(`echo "${existingContainers}" | xargs -r ${this.containerCmd} stop`, {
                stdio: 'ignore',
              });
              execSync(`echo "${existingContainers}" | xargs -r ${this.containerCmd} rm`, {
                stdio: 'ignore',
              });
            }
          } catch (err) {
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
          execSync(
            `${this.composeCmd} -f docker-compose.test.yml down --remove-orphans --volumes`,
            {
              stdio: 'ignore',
              cwd: this.projectRoot,
            }
          );
          console.log('🛑 Compose environment stopped');
        }
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      console.log('⚠️ Error during cleanup (may be expected):', errorMessage);
    }

    this.isContainerStarted = false;
  }
}
