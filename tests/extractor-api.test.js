/**
 * Tests for the extraction API endpoints
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'child_process';

const TEST_PORT = 3003;
const API_BASE = `http://localhost:${TEST_PORT}/api`;

let serverProcess = null;

describe('Extractor API Tests', () => {
  
  before(async () => {
    console.log('🚀 Starting test server...');
    
    // Start the development server with test environment
    const env = {
      ...process.env,
      TEST_IN_PROGRESS: '1',
      KISSKI_API_KEY: 'dummy-key-for-testing'
    };

    serverProcess = spawn('bash', ['-c', `source .venv/bin/activate && ./bin/server localhost ${TEST_PORT}`], {
      cwd: process.cwd(),
      env: env,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    // Wait for server to start
    await new Promise((resolve, reject) => {
      let startupComplete = false;
      
      const checkStartup = (data) => {
        const output = data.toString();
        if (output.includes(`Running on http://localhost:${TEST_PORT}`) && !startupComplete) {
          startupComplete = true;
          console.log('✅ Test server started');
          setTimeout(resolve, 2000); // Wait a bit more for full initialization
        }
      };

      serverProcess.stdout.on('data', checkStartup);
      serverProcess.stderr.on('data', checkStartup);

      serverProcess.on('error', reject);
      
      // Timeout
      setTimeout(() => {
        if (!startupComplete) {
          reject(new Error('Server startup timeout'));
        }
      }, 15000);
    });
  });

  after(async () => {
    if (serverProcess) {
      console.log('🛑 Stopping test server...');
      serverProcess.kill('SIGTERM');
      
      // Wait for graceful shutdown
      await new Promise((resolve) => {
        serverProcess.on('exit', resolve);
        setTimeout(() => {
          if (serverProcess && !serverProcess.killed) {
            serverProcess.kill('SIGKILL');
          }
          resolve(true);
        }, 3000);
      });
    }
  });
  
  test('GET /extract/list should return available extractors', async () => {
    const response = await fetch(`${API_BASE}/extract/list`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json'
        // No session ID needed - TEST_IN_PROGRESS bypasses authentication
      }
    });
    
    assert.strictEqual(response.status, 200, 'Should return 200 with TEST_IN_PROGRESS');
    
    const extractors = await response.json();
    assert(Array.isArray(extractors), 'Should return an array of extractors');
    assert(extractors.length >= 1, 'Should have at least one extractor');
    
    // Check that each extractor has the required fields
    for (const extractor of extractors) {
      assert(typeof extractor.id === 'string', 'Extractor should have string id');
      assert(typeof extractor.name === 'string', 'Extractor should have string name');
      assert(Array.isArray(extractor.input), 'Extractor should have input array');
      assert(Array.isArray(extractor.output), 'Extractor should have output array');
    }
    
    // Check for expected extractors
    const llamoreExtractor = extractors.find(e => e.id === 'llamore-gemini');
    const kisskiExtractor = extractors.find(e => e.id === 'kisski-neural-chat');
    
    if (llamoreExtractor) {
      assert(llamoreExtractor.input.includes('pdf'), 'LLamore should support PDF input');
      assert(llamoreExtractor.output.includes('tei-document'), 'LLamore should output TEI documents');
      assert(typeof llamoreExtractor.description === 'string', 'Should have description');
    }
    
    if (kisskiExtractor) {
      assert(kisskiExtractor.input.includes('text'), 'KISSKI should support text input');
      assert(kisskiExtractor.output.includes('text'), 'KISSKI should output text');
      assert(kisskiExtractor.requires_api_key === true, 'KISSKI should require API key');
      assert(kisskiExtractor.api_key_env === 'KISSKI_API_KEY', 'KISSKI should specify correct env var');
    }
    
    console.log(`✓ Found ${extractors.length} available extractors`);
    extractors.forEach(e => console.log(`  - ${e.id}: ${e.name}`));
  });
  
  test('Extractor discovery system should work', async () => {
    // Verify the endpoint responds and discovers both expected extractors
    const response = await fetch(`${API_BASE}/extract/list`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json'
      }
    });
    
    assert.strictEqual(response.status, 200, 'Discovery endpoint should be accessible');
    
    const extractors = await response.json();
    const extractorIds = extractors.map(e => e.id);
    
    // Verify both expected extractors are discovered
    assert(extractorIds.includes('llamore-gemini'), 'Should discover llamore-gemini extractor');
    assert(extractorIds.includes('kisski-neural-chat'), 'Should discover kisski-neural-chat extractor');
    
    console.log('✓ Extractor discovery system working');
    console.log(`✓ Discovered extractors: ${extractorIds.join(', ')}`);
  });
  
});