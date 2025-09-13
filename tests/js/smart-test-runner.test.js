/**
 * Integration tests for Smart Test Runner
 * Tests dependency detection, file change analysis, and test selection logic
 * @testCovers tests/smart-test-runner.js
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import { execSync } from 'child_process';
import { writeFileSync, readFileSync, existsSync, unlinkSync } from 'fs';
import { join } from 'path';
import SmartTestRunner from '../smart-test-runner.js';

const testBranch = 'test-smart-runner-' + Date.now();
const projectRoot = process.cwd();

describe('Smart Test Runner Integration', () => {

  let originalBranch = '';
  let testFiles = [];
  let testBranchCreated = false;

  // Cleanup function that can be called from anywhere
  const cleanup = async () => {
    // Clean up test files
    for (const file of testFiles) {
      try {
        if (existsSync(file)) {
          unlinkSync(file);
        }
      } catch (error) {
        console.warn(`Could not clean up ${file}:`, error.message);
      }
    }

    // Clean up cache file
    const cacheFile = join(projectRoot, 'tests', 'test-dependencies.json');
    try {
      if (existsSync(cacheFile)) {
        unlinkSync(cacheFile);
      }
    } catch (error) {
      console.warn('Could not clean up cache file:', error.message);
    }

    // Return to original branch and delete test branch
    if (originalBranch && testBranchCreated) {
      try {
        execSync(`git checkout ${originalBranch}`, { stdio: 'pipe' });
        execSync(`git branch -D ${testBranch}`, { stdio: 'pipe' });
        console.log(`Cleaned up test branch: ${testBranch}`);
      } catch (error) {
        console.warn('Could not clean up test branch:', error.message);
      }
    }
  };

  before(async () => {
    // Save current branch
    try {
      originalBranch = execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf8' }).trim();
    } catch (error) {
      console.warn('Could not get current branch, skipping branch management');
    }

    // Create test branch
    if (originalBranch) {
      try {
        execSync(`git checkout -b ${testBranch}`, { stdio: 'pipe' });
        testBranchCreated = true;
        console.log(`Created test branch: ${testBranch}`);
      } catch (error) {
        console.warn('Could not create test branch:', error.message);
      }
    }

    // Set up cleanup on uncaught exceptions
    const originalUncaughtHandler = process.listeners('uncaughtException');
    process.on('uncaughtException', async (error) => {
      console.error('Uncaught exception during test, cleaning up...', error);
      await cleanup();
      // Call original handlers
      originalUncaughtHandler.forEach(handler => handler(error));
    });

    const originalUnhandledHandler = process.listeners('unhandledRejection');
    process.on('unhandledRejection', async (error) => {
      console.error('Unhandled rejection during test, cleaning up...', error);
      await cleanup();
      // Call original handlers
      originalUnhandledHandler.forEach(handler => handler(error));
    });
  });

  after(cleanup);

  test('should discover test files dynamically', async () => {
    const runner = new SmartTestRunner();
    const testFiles = runner.discoverTestFiles();
    
    assert(testFiles.js.length > 0, 'Should discover JavaScript test files');
    assert(testFiles.py.length > 0, 'Should discover Python test files');
    
    // Check expected test files exist
    assert(testFiles.js.includes('tests/js/application.test.js'), 'Should find application.test.js');
    assert(testFiles.js.includes('tests/js/plugin-manager.test.js'), 'Should find plugin-manager.test.js');
    assert(testFiles.py.some(f => f.startsWith('tests/py/test_')), 'Should find Python test files');
    
    console.log(`Discovered ${testFiles.js.length} JS tests, ${testFiles.py.length} Python tests, ${testFiles.e2e.length} E2E tests`);
  });

  test('should parse @testCovers annotations correctly', async () => {
    // Create test file with annotations
    const testFile = join(projectRoot, 'tests', 'js', 'temp-annotation-test.test.js');
    testFiles.push(testFile);
    
    const testContent = `/**
 * Test file for annotation parsing
 * @testCovers app/src/modules/application.js
 * @testCovers server/api/files.py
 * @testCovers *
 */
import { test } from 'node:test';
test('dummy test', () => {});
`;
    
    writeFileSync(testFile, testContent);
    
    const runner = new SmartTestRunner();
    const result = runner.parseTestCoversAnnotations(testFile);
    
    assert(result.alwaysRun === true, 'Should detect @testCovers * as always run');
    assert(result.dependencies.includes('app/src/modules/application.js'), 'Should parse explicit dependency');
    assert(result.dependencies.includes('server/api/files.py'), 'Should parse Python dependency');
    
    console.log('Parsed annotations:', result);
  });

  test('should detect dependencies via madge analysis', async () => {
    // Create test file that imports from app/src
    const testFile = join(projectRoot, 'tests', 'js', 'temp-import-test.test.js');
    testFiles.push(testFile);
    
    const testContent = `/**
 * Test file for import analysis
 */
import { Application } from '../../app/src/modules/application.js';
import PluginManager from '../../app/src/modules/plugin-manager.js';
import { test } from 'node:test';

test('dummy test', () => {
  // Test content
});
`;
    
    writeFileSync(testFile, testContent);
    
    const runner = new SmartTestRunner();
    const result = await runner.analyzeJSDependencies([`tests/js/${testFile.split('/').pop()}`]);
    
    const testKey = `tests/js/${testFile.split('/').pop()}`;
    assert(result.dependencies[testKey], 'Should analyze test file dependencies');
    
    const deps = result.dependencies[testKey].dependencies;
    assert(deps.some(dep => dep.includes('application')), 'Should detect application.js import');
    assert(deps.some(dep => dep.includes('plugin-manager')), 'Should detect plugin-manager.js import');
    
    console.log(`tests/js/temp-import-test.test.js: ${deps.length} dependencies`);
    console.log('Detected dependencies:', deps);
  });

  test('should select relevant tests based on file changes', async () => {
    // Create a test file with specific dependencies
    const testFile = join(projectRoot, 'tests', 'js', 'temp-selection-test.test.js');
    testFiles.push(testFile);
    
    const testContent = `/**
 * Test file for selection logic
 * @testCovers app/src/modules/state-manager.js
 */
import { test } from 'node:test';
test('dummy test', () => {});
`;
    
    writeFileSync(testFile, testContent);
    
    const runner = new SmartTestRunner();
    
    // Force fresh analysis by clearing cache
    runner.cache = { dependencies: {}, lastAnalysis: 0 };
    
    // Mock changed files to include state-manager.js
    const originalGetChangedFiles = runner.getChangedFiles;
    runner.getChangedFiles = () => ['app/src/modules/state-manager.js', 'other-unrelated-file.txt'];
    
    try {
      const testsToRun = await runner.getTestsToRun();
      
      const testFileName = `tests/js/${testFile.split('/').pop()}`;
      assert(testsToRun.js.includes(testFileName), 'Should include test that covers changed file');
      
      // Should also include always-run tests
      assert(testsToRun.js.includes('tests/js/application.test.js'), 'Should include always-run tests');
      assert(testsToRun.js.includes('tests/js/plugin-manager.test.js'), 'Should include always-run tests');
      
      console.log('Selected tests:', testsToRun);
    } finally {
      // Restore original method
      runner.getChangedFiles = originalGetChangedFiles;
    }
  });

  test('should handle no changed files scenario', async () => {
    const runner = new SmartTestRunner();
    
    // Mock no changed files
    const originalGetChangedFiles = runner.getChangedFiles;
    runner.getChangedFiles = () => [];
    
    try {
      const testsToRun = await runner.getTestsToRun();
      
      // Should only run always-run tests when no changes
      assert(testsToRun.js.includes('tests/js/application.test.js'), 'Should run critical tests when no changes');
      assert(testsToRun.js.includes('tests/js/plugin-manager.test.js'), 'Should run critical tests when no changes');
      
      // Should not run regular tests
      const nonCriticalTests = testsToRun.js.filter(test => 
        !['tests/js/application.test.js', 'tests/js/plugin-manager.test.js'].includes(test)
      );
      
      console.log('Tests for no changes scenario:', testsToRun);
      console.log('Non-critical tests selected:', nonCriticalTests);
    } finally {
      runner.getChangedFiles = originalGetChangedFiles;
    }
  });

  test('should cache and reuse dependency analysis', async () => {
    const cacheFile = join(projectRoot, 'tests', 'test-dependencies.json');
    
    // Ensure cache doesn't exist
    if (existsSync(cacheFile)) {
      unlinkSync(cacheFile);
    }
    
    const runner1 = new SmartTestRunner();
    
    // First run should perform analysis
    const start1 = Date.now();
    await runner1.analyzeDependencies();
    const duration1 = Date.now() - start1;
    
    assert(existsSync(cacheFile), 'Should create cache file');
    
    const runner2 = new SmartTestRunner();
    
    // Second run should use cache
    const start2 = Date.now();
    await runner2.analyzeDependencies();
    const duration2 = Date.now() - start2;
    
    assert(duration2 < duration1, `Second run should be faster (${duration2}ms vs ${duration1}ms)`);
    
    console.log(`First run: ${duration1}ms, cached run: ${duration2}ms`);
  });

  test('should handle Python test file parsing', async () => {
    // Create temporary Python test file
    const testFile = join(projectRoot, 'tests', 'py', 'temp_python_test.py');
    testFiles.push(testFile);
    
    const testContent = `"""
Test file for Python dependency analysis
@testCovers server/api/extract.py  
@testCovers bin/manage.py
"""
import unittest
from server.lib.utils import helper_function
from bin.extractors.llamore import LlamoreExtractor

class TestExample(unittest.TestCase):
    def test_example(self):
        pass
`;
    
    writeFileSync(testFile, testContent);
    
    const runner = new SmartTestRunner();
    const result = await runner.analyzePyDependencies([`tests/py/${testFile.split('/').pop()}`]);
    
    const testKey = `tests/py/${testFile.split('/').pop()}`;
    const testData = result.dependencies[testKey];
    
    assert(testData, 'Should analyze Python test file');
    assert(testData.dependencies.includes('server/api/extract.py'), 'Should parse @testCovers annotation');
    assert(testData.dependencies.includes('bin/manage.py'), 'Should parse multiple annotations');
    assert(testData.dependencies.includes('server/lib/utils.py'), 'Should detect import dependencies');
    
    console.log('Python dependencies detected:', testData.dependencies);
  });

  test('should integrate with git workflow', async () => {
    if (!originalBranch) {
      console.log('Skipping git integration test (no git available)');
      return;
    }

    // Make a small change to a source file
    const sourceFile = join(projectRoot, 'app', 'src', 'modules', 'application.js');
    const originalContent = readFileSync(sourceFile, 'utf8');
    const modifiedContent = originalContent + '\n// Test comment for smart runner integration test\n';
    
    try {
      // Modify the file
      writeFileSync(sourceFile, modifiedContent);
      
      const runner = new SmartTestRunner();
      const changedFiles = runner.getChangedFiles();
      
      assert(changedFiles.includes('app/src/modules/application.js'), 'Should detect changed file via git');
      
      const testsToRun = await runner.getTestsToRun();
      
      // Should run application tests since application.js was changed
      assert(testsToRun.js.includes('tests/js/application.test.js'), 'Should run application tests for application.js changes');
      
      console.log('Git detected changes:', changedFiles);
      console.log('Selected tests for changes:', testsToRun);
      
    } finally {
      // Restore original content
      writeFileSync(sourceFile, originalContent);
    }
  });

});
