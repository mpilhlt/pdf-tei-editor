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

import { createTestSession, authenticatedApiCall } from './helpers/test-auth.js';

class ExtractorTest {
    constructor() {
        this.testResults = {
            apiResponding: false,
            llamoreFound: false,
            totalExtractors: 0
        };
        this.session = null;
    }


    /**
     * Test the /api/extract/list endpoint
     */
    async testExtractorList() {
        console.log('🔍 Testing extractor list endpoint...');

        try {
            if (!this.session) {
                throw new Error('No authenticated session available');
            }

            const extractors = await authenticatedApiCall(this.session.sessionId, '/extract/list', 'GET');

            this.testResults.apiResponding = true;
            console.log('✅ API responding successfully');
            console.log('📋 Received extractors:', JSON.stringify(extractors, null, 2));

            this.analyzeExtractors(extractors);
            return extractors;

        } catch (error) {
            console.error('❌ Failed to test extractor list:', error.message);
            throw error;
        }
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
        console.log(`Total Extractors: ${this.testResults.totalExtractors}`);

        const totalTests = 2;
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
            // Create authenticated session
            console.log('🔐 Creating authenticated session...');
            this.session = await createTestSession();
            console.log('✅ Session created successfully');

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