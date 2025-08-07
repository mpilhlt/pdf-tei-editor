#!/usr/bin/env node

/**
 * Test script for extractor discovery and listing
 * 
 * This script:
 * 1. Starts the development server with TEST_IN_PROGRESS flag
 * 2. Tests the /api/extract/list endpoint
 * 3. Verifies that extractors are properly discovered and listed
 * 4. Cleans up by stopping the server
 */

const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');

// Configuration
const SERVER_PORT = 3002; // Use different port for testing
const SERVER_HOST = 'localhost';
const TEST_TIMEOUT = 30000; // 30 seconds

class ExtractorTest {
    constructor() {
        this.serverProcess = null;
        this.testResults = {
            serverStarted: false,
            apiResponding: false,
            llamoreFound: false,
            kisskiFound: false,
            totalExtractors: 0
        };
    }

    /**
     * Start the development server with test environment variables
     */
    async startServer() {
        console.log('🚀 Starting development server...');
        
        return new Promise((resolve, reject) => {
            const env = {
                ...process.env,
                TEST_IN_PROGRESS: '1',
                KISSKI_API_KEY: 'dummy-key-for-testing'
            };

            // Use bash to source the virtual environment and run the server on test port
            this.serverProcess = spawn('bash', ['-c', `source .venv/bin/activate && ./bin/server ${SERVER_HOST} ${SERVER_PORT}`], {
                cwd: process.cwd(),
                env: env,
                stdio: ['pipe', 'pipe', 'pipe']
            });

            let serverOutput = '';
            let startupComplete = false;

            this.serverProcess.stdout.on('data', (data) => {
                const output = data.toString();
                serverOutput += output;
                console.log(`[SERVER] ${output.trim()}`);
                
                // Check if server has started
                if (output.includes(`Running on http://${SERVER_HOST}:${SERVER_PORT}`) && !startupComplete) {
                    startupComplete = true;
                    this.testResults.serverStarted = true;
                    console.log('✅ Server started successfully');
                    
                    // Wait a bit more for full initialization
                    setTimeout(() => resolve(), 3000);
                }
            });

            this.serverProcess.stderr.on('data', (data) => {
                const output = data.toString();
                console.log(`[SERVER ERROR] ${output.trim()}`);
                
                // Flask outputs the "Running on" message to stderr
                if (output.includes(`Running on http://${SERVER_HOST}:${SERVER_PORT}`) && !startupComplete) {
                    startupComplete = true;
                    this.testResults.serverStarted = true;
                    console.log('✅ Server started successfully');
                    
                    // Wait a bit more for full initialization
                    setTimeout(() => resolve(), 3000);
                }
            });

            this.serverProcess.on('error', (error) => {
                console.error('❌ Failed to start server:', error.message);
                reject(error);
            });

            this.serverProcess.on('exit', (code) => {
                if (!startupComplete) {
                    console.error(`❌ Server exited with code ${code} before startup completed`);
                    reject(new Error(`Server startup failed with exit code ${code}`));
                }
            });

            // Timeout for server startup
            setTimeout(() => {
                if (!startupComplete) {
                    console.error('❌ Server startup timeout');
                    reject(new Error('Server startup timeout'));
                }
            }, 15000);
        });
    }

    /**
     * Test the /api/extract/list endpoint
     */
    async testExtractorList() {
        console.log('🔍 Testing extractor list endpoint...');
        
        return new Promise((resolve, reject) => {
            const options = {
                hostname: SERVER_HOST,
                port: SERVER_PORT,
                path: '/api/extract/list',
                method: 'GET',
                headers: {
                    'Content-Type': 'application/json'
                }
            };

            const req = http.request(options, (res) => {
                let data = '';

                res.on('data', (chunk) => {
                    data += chunk;
                });

                res.on('end', () => {
                    try {
                        if (res.statusCode !== 200) {
                            console.error(`❌ API returned status ${res.statusCode}`);
                            console.error('Response:', data);
                            reject(new Error(`API error: ${res.statusCode}`));
                            return;
                        }

                        this.testResults.apiResponding = true;
                        console.log('✅ API responding successfully');

                        const extractors = JSON.parse(data);
                        console.log('📋 Received extractors:', JSON.stringify(extractors, null, 2));
                        
                        this.analyzeExtractors(extractors);
                        resolve(extractors);
                        
                    } catch (error) {
                        console.error('❌ Failed to parse API response:', error.message);
                        console.error('Raw response:', data);
                        reject(error);
                    }
                });
            });

            req.on('error', (error) => {
                console.error('❌ HTTP request failed:', error.message);
                reject(error);
            });

            req.setTimeout(5000, () => {
                console.error('❌ Request timeout');
                req.destroy();
                reject(new Error('Request timeout'));
            });

            req.end();
        });
    }

    /**
     * Analyze the extractors returned by the API
     */
    analyzeExtractors(extractors) {
        console.log('🔬 Analyzing extractors...');
        
        this.testResults.totalExtractors = extractors.length;
        console.log(`📊 Total extractors found: ${extractors.length}`);

        for (const extractor of extractors) {
            console.log(`🔧 Extractor: ${extractor.id}`);
            console.log(`   Name: ${extractor.name}`);
            console.log(`   Description: ${extractor.description}`);
            console.log(`   Input: ${extractor.input.join(', ')}`);
            console.log(`   Output: ${extractor.output.join(', ')}`);
            
            if (extractor.id === 'llamore-gemini') {
                this.testResults.llamoreFound = true;
                console.log('✅ LLamore+Gemini extractor found');
                
                // Verify expected properties
                if (extractor.input.includes('pdf') && extractor.output.includes('tei-document')) {
                    console.log('✅ LLamore extractor has correct input/output types');
                } else {
                    console.log('⚠️  LLamore extractor has unexpected input/output types');
                }
            }
            
            if (extractor.id === 'kisski-neural-chat') {
                this.testResults.kisskiFound = true;
                console.log('✅ KISSKI Neural Chat extractor found');
                
                // Verify expected properties
                if (extractor.input.includes('text') && extractor.output.includes('text')) {
                    console.log('✅ KISSKI extractor has correct input/output types');
                } else {
                    console.log('⚠️  KISSKI extractor has unexpected input/output types');
                }
                
                if (extractor.requires_api_key && extractor.api_key_env === 'KISSKI_API_KEY') {
                    console.log('✅ KISSKI extractor has correct API key configuration');
                } else {
                    console.log('⚠️  KISSKI extractor has unexpected API key configuration');
                }
            }
        }
    }

    /**
     * Stop the development server
     */
    async stopServer() {
        console.log('🛑 Stopping development server...');
        
        if (this.serverProcess) {
            return new Promise((resolve) => {
                this.serverProcess.on('exit', () => {
                    console.log('✅ Server stopped');
                    resolve();
                });
                
                this.serverProcess.kill('SIGTERM');
                
                // Force kill if it doesn't stop gracefully
                setTimeout(() => {
                    if (this.serverProcess && !this.serverProcess.killed) {
                        console.log('🔨 Force killing server...');
                        this.serverProcess.kill('SIGKILL');
                        resolve();
                    }
                }, 5000);
            });
        }
    }

    /**
     * Print test results summary
     */
    printResults() {
        console.log('\n📊 TEST RESULTS SUMMARY');
        console.log('========================');
        console.log(`Server Started: ${this.testResults.serverStarted ? '✅ PASS' : '❌ FAIL'}`);
        console.log(`API Responding: ${this.testResults.apiResponding ? '✅ PASS' : '❌ FAIL'}`);
        console.log(`LLamore Extractor Found: ${this.testResults.llamoreFound ? '✅ PASS' : '❌ FAIL'}`);
        console.log(`KISSKI Extractor Found: ${this.testResults.kisskiFound ? '✅ PASS' : '❌ FAIL'}`);
        console.log(`Total Extractors: ${this.testResults.totalExtractors}`);
        
        const totalTests = 4;
        const passedTests = Object.values(this.testResults).filter(result => result === true).length;
        
        console.log(`\n🎯 OVERALL: ${passedTests}/${totalTests} tests passed`);
        
        if (passedTests === totalTests) {
            console.log('🎉 ALL TESTS PASSED!');
            return true;
        } else {
            console.log('💥 SOME TESTS FAILED!');
            return false;
        }
    }

    /**
     * Run all tests
     */
    async runTests() {
        console.log('🧪 Starting Extractor Discovery Tests');
        console.log('=====================================\n');
        
        try {
            // Start server
            await this.startServer();
            
            // Test extractor list
            await this.testExtractorList();
            
            // Print results
            const allPassed = this.printResults();
            
            // Stop server
            await this.stopServer();
            
            // Exit with appropriate code
            process.exit(allPassed ? 0 : 1);
            
        } catch (error) {
            console.error('💥 Test failed with error:', error.message);
            
            // Try to stop server if it's running
            if (this.serverProcess) {
                await this.stopServer();
            }
            
            this.printResults();
            process.exit(1);
        }
    }
}

// Handle process termination
let testInstance = null;

process.on('SIGINT', async () => {
    console.log('\n🛑 Test interrupted by user');
    if (testInstance && testInstance.serverProcess) {
        await testInstance.stopServer();
    }
    process.exit(1);
});

process.on('SIGTERM', async () => {
    console.log('\n🛑 Test terminated');
    if (testInstance && testInstance.serverProcess) {
        await testInstance.stopServer();
    }
    process.exit(1);
});

// Run the tests
const test = new ExtractorTest();
testInstance = test; // Store reference for cleanup
test.runTests().catch((error) => {
    console.error('💥 Unexpected error:', error.message);
    process.exit(1);
});