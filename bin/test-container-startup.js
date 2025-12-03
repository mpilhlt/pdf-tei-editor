#!/usr/bin/env node

/**
 * Test container startup and health check
 * This builds and starts the test container, waits for it to be healthy, then stops it
 */

import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { ContainerServerManager } from '../tests/lib/container-server-manager.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = dirname(__dirname);

async function testContainerStartup() {
  console.log('🧪 Testing container startup...\n');

  const manager = new ContainerServerManager({
    projectRoot,
    rebuild: true,
    verbose: true,
  });

  try {
    console.log('📦 Building and starting container...');
    await manager.start();

    const url = manager.getBaseUrl();
    console.log('\n✅ Container started successfully!');
    console.log('\n📊 Container details:');
    console.log(`   Name: ${manager.containerName}`);
    console.log(`   URL: ${url}`);
    console.log(`   Health: ${url}/health`);
    console.log(`   Host port: ${manager.config.port}`);
    console.log(`   Container port: ${manager.config.containerPort}`);

    console.log('\n🧹 Cleaning up...');
    await manager.stop();

    console.log('\n✅ Test completed successfully!');
    process.exit(0);
  } catch (error) {
    console.error('\n❌ Container startup test failed:', error.message);

    try {
      await manager.stop();
    } catch (cleanupError) {
      console.error('⚠️  Cleanup also failed:', cleanupError.message);
    }

    process.exit(1);
  }
}

testContainerStartup();
