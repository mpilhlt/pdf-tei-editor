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
 *   # Playwright browser tests (replaces bin/test-e2e)
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

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = dirname(__dirname);

/**
 * Unified cross-platform E2E test infrastructure
 */
class E2ERunner {
    constructor() {
        this.containerCmd = null;
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

        // Detect container tool
        this.detectContainerTool();

        // Setup cleanup handlers
        process.on('SIGINT', () => this.cleanup());
        process.on('SIGTERM', () => this.cleanup());
        process.on('exit', () => this.cleanup());
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

            // Check for compose tools with podman
            try {
                execSync('command -v podman-compose', { stdio: 'ignore' });
                this.composeCmd = 'podman-compose';
                this.usePodman = false;
                console.log('📦 Found podman-compose');
            } catch {
                try {
                    execSync('command -v docker-compose', { stdio: 'ignore' });
                    this.composeCmd = 'docker-compose';
                    this.usePodman = false;
                    console.log('📦 Found docker-compose (with podman)');
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
     */
    async startContainer() {
        console.log('🚀 Starting containerized test environment...');
        console.log(`🆔 Test Run ID: ${this.testRunId}`);

        try {
            if (this.usePodman) {
                await this.startDirectContainer();
            } else {
                await this.startComposeContainer();
            }

            this.isContainerStarted = true;
            console.log('✅ Container started successfully');

            // Wait for application to be ready
            await this.waitForApplicationReady();

        } catch (error) {
            console.error('❌ Failed to start container:', error.message);
            throw error;
        }
    }

    /**
     * Start container using direct container commands
     */
    async startDirectContainer() {
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

        // Build test image with consistent name for layer caching
        console.log('🏗️ Building test image...');
        execSync(`${this.containerCmd} build -t pdf-tei-editor-test:latest --target test .`, {
            stdio: 'inherit',
            cwd: projectRoot
        });

        // Start container with test environment
        console.log('🚀 Starting test container...');
        const portMapping = `${this.config.port}:${this.config.containerPort}`;
        execSync(`${this.containerCmd} run -d --name ${this.containerName} -p ${portMapping} --env FLASK_ENV=testing --env PYTHONPATH=/app --env TEST_IN_PROGRESS=1 --env KISSKI_API_KEY=dummy-key-for-testing pdf-tei-editor-test:latest`, {
            stdio: 'inherit',
            cwd: projectRoot
        });
    }

    /**
     * Start container using compose commands
     */
    async startComposeContainer() {
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

        // Start the test environment
        console.log('🚀 Starting test environment with compose...');
        execSync(`${this.composeCmd} -f docker-compose.test.yml up --build -d`, {
            stdio: 'inherit',
            cwd: projectRoot
        });
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
     * Show container logs for debugging
     */
    async showContainerLogs() {
        console.log('📋 Container logs:');
        try {
            if (this.usePodman) {
                execSync(`${this.containerCmd} logs ${this.containerName}`, { stdio: 'inherit' });
            } else {
                execSync(`${this.composeCmd} -f docker-compose.test.yml logs`, {
                    stdio: 'inherit',
                    cwd: projectRoot
                });
            }
        } catch (error) {
            console.error('Could not retrieve container logs:', error.message);
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
            console.log('⚠️ Error during cleanup (may be expected):', error.message);
        }

        console.log('✅ Cleanup completed');
        this.isContainerStarted = false;
    }

    /**
     * Run Playwright browser tests
     * @param {Object} options - Playwright options
     */
    async runPlaywrightTests(options = {}) {
        console.log('🧪 Unified E2E Runner - Playwright Browser Tests');
        console.log('=================================================\n');
        console.log(`🆔 Test Run ID: ${this.testRunId}`);
        console.log(`🌐 Browser: ${options.browser || 'chromium'}`);
        console.log(`👁️ Mode: ${options.headed ? 'headed' : 'headless'}`);

        try {
            // Check if npx is available
            try {
                execSync('command -v npx', { stdio: 'ignore' });
            } catch {
                throw new Error('Node.js/npm is required but not installed');
            }

            // Start containerized environment
            await this.startContainer();

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
            if (options.grep) {
                cmd.push('--grep', options.grep);
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
                testProcess.on('exit', async (code) => {
                    if (code === 0) {
                        console.log('🎉 All tests passed!');
                        await this.cleanup();
                        resolve(code);
                    } else {
                        console.log('💥 Some tests failed!');
                        console.log('📋 Application logs for debugging:');
                        await this.showContainerLogs();
                        await this.cleanup();
                        reject(new Error(`Tests failed with exit code ${code}`));
                    }
                });

                testProcess.on('error', async (error) => {
                    console.error('💥 Playwright process error:', error.message);
                    await this.cleanup();
                    reject(error);
                });
            });

        } catch (error) {
            console.error('💥 Playwright runner failed:', error.message);
            await this.cleanup();
            throw error;
        }
    }

    /**
     * Run a backend test file with the containerized environment
     * @param {string} testFile - Path to the test file to run
     */
    async runBackendTest(testFile) {
        console.log('🧪 Unified E2E Runner - Backend Integration Test');
        console.log('=================================================\n');
        console.log(`🆔 Test Run ID: ${this.testRunId}`);

        try {
            // Start containerized environment
            await this.startContainer();

            // Run the test file
            console.log(`🧪 Running test: ${testFile}`);
            const testProcess = spawn('node', [testFile], {
                stdio: 'inherit',
                cwd: projectRoot,
                env: {
                    ...process.env,
                    ...this.getEnvironmentVars()
                }
            });

            return new Promise((resolve, reject) => {
                testProcess.on('exit', async (code) => {
                    // Cleanup container
                    await this.cleanup();

                    if (code === 0) {
                        console.log('🎉 Test passed!');
                        resolve(code);
                    } else {
                        console.log('💥 Test failed!');
                        reject(new Error(`Test failed with exit code ${code}`));
                    }
                });

                testProcess.on('error', async (error) => {
                    console.error('💥 Test process error:', error.message);
                    await this.cleanup();
                    reject(error);
                });
            });

        } catch (error) {
            console.error('💥 Backend test runner failed:', error.message);
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
            E2E_CONTAINER_CMD: this.containerCmd
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
function parseArgs(args) {
    const parsed = {
        playwright: false,
        browser: 'chromium',
        headed: false,
        debug: false,
        grep: null,
        testFile: null,
        help: false
    };

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];

        switch (arg) {
            case '--playwright':
                parsed.playwright = true;
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
                parsed.grep = args[++i];
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
    console.log('  # Playwright browser tests (replaces bin/test-e2e)');
    console.log('  node tests/e2e-runner.js --playwright [options]');
    console.log('');
    console.log('  # Backend integration tests');
    console.log('  node tests/e2e-runner.js <test-file>');
    console.log('');
    console.log('Playwright Options:');
    console.log('  --browser <name>   Browser to use (chromium|firefox|webkit) [default: chromium]');
    console.log('  --headed           Run tests in headed mode (show browser)');
    console.log('  --debug            Enable debug mode');
    console.log('  --grep <pattern>   Run tests matching pattern');
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
    console.log('');
    console.log('  # Run backend integration test');
    console.log('  node tests/e2e-runner.js tests/e2e/test-extractors.js');
    console.log('');
    console.log('  # Custom port');
    console.log('  E2E_PORT=8001 node tests/e2e-runner.js --playwright --debug');
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

    try {
        if (args.playwright) {
            // Run Playwright browser tests
            await runner.runPlaywrightTests({
                browser: args.browser,
                headed: args.headed,
                debug: args.debug,
                grep: args.grep
            });
        } else if (args.testFile) {
            // Run backend integration test
            await runner.runBackendTest(args.testFile);
        } else {
            console.error('❌ Either --playwright or a test file must be specified');
            console.log('');
            showHelp();
            process.exit(1);
        }

        process.exit(0);
    } catch (error) {
        console.error('💥 Runner failed:', error.message);
        process.exit(1);
    }
}

// Export for use as module
export { E2ERunner };

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
    main().catch(error => {
        console.error('Unexpected error:', error.message);
        process.exit(1);
    });
}