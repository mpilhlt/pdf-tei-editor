#!/usr/bin/env node

/**
 * Backend Integration Test for extractor discovery and listing
 *
 * This test assumes a containerized test environment is already running
 * and focuses on testing the backend API.
 *
 * Usage: npm run test:e2e:backend tests/e2e/test-extractors.js
 *
 * @testCovers server/api/extract.py
 * @testCovers server/lib/extractors/
 */

import http from 'http';

class ExtractorTest {
    constructor() {
        this.testResults = {
            apiResponding: false,
            llamoreFound: false,
            kisskiFound: false,
            totalExtractors: 0
        };

        // Get configuration from environment variables
        this.host = process.env.E2E_HOST || 'localhost';
        this.port = parseInt(process.env.E2E_PORT || '8000');
        this.containerUrl = process.env.E2E_CONTAINER_URL || `http://${this.host}:${this.port}`;

        console.log(`📡 Using container URL: ${this.containerUrl}`);
    }


    /**
     * Test the /api/extract/list endpoint
     */
    async testExtractorList() {
        console.log('🔍 Testing extractor list endpoint...');
        
        return new Promise((resolve, reject) => {
            const options = {
                hostname: this.host,
                port: this.port,
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
                        // @ts-ignore
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
    // @ts-ignore
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
     * Print test results summary
     */
    printResults() {
        console.log('\n📊 TEST RESULTS SUMMARY');
        console.log('========================');
        console.log(`API Responding: ${this.testResults.apiResponding ? '✅ PASS' : '❌ FAIL'}`);
        console.log(`LLamore Extractor Found: ${this.testResults.llamoreFound ? '✅ PASS' : '❌ FAIL'}`);
        console.log(`KISSKI Extractor Found: ${this.testResults.kisskiFound ? '✅ PASS' : '❌ FAIL'}`);
        console.log(`Total Extractors: ${this.testResults.totalExtractors}`);

        const totalTests = 3;
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
        console.log('🧪 Backend Integration Test - Extractor Discovery');
        console.log('=================================================\n');

        try {
            // Test extractor list endpoint
            await this.testExtractorList();

            // Print results and exit
            const allPassed = this.printResults();
            process.exit(allPassed ? 0 : 1);

        } catch (error) {
            // @ts-ignore
            console.error('💥 Test failed with error:', error.message);
            this.printResults();
            process.exit(1);
        }
    }
}

// Run the tests
const test = new ExtractorTest();
test.runTests().catch((error) => {
    console.error('💥 Unexpected error:', error.message);
    process.exit(1);
});