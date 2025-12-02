/**
 * Integration tests for Smart Test Runner
 * Tests dependency detection, file change analysis, and test selection logic
 * @testCovers tests/smart-test-runner.js
 * @testCovers tests/e2e-runner.js
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import { execSync } from 'child_process';
import { writeFileSync, readFileSync, existsSync, unlinkSync } from 'fs';
import { join, basename } from 'path';
import SmartTestRunner from '../../smart-test-runner.js';

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
    const testFiles = await runner.discoverTestFiles();

    assert(testFiles.js.length > 0, 'Should discover JavaScript test files');
    assert(testFiles.py.length > 0, 'Should discover Python test files');

    // Check expected test files exist
    assert(testFiles.js.includes('tests/unit/js/application.test.js'), 'Should find application.test.js');
    assert(testFiles.js.includes('tests/unit/js/plugin-manager.test.js'), 'Should find plugin-manager.test.js');
    assert(testFiles.py.some(f => f.startsWith('tests/unit/flask/test_') || f.startsWith('tests/unit/fastapi/test_')), 'Should find Python test files');

    console.log(`Discovered ${testFiles.js.length} JS unit tests, ${testFiles.py.length} Python unit tests, ${testFiles.api.length} API tests, ${testFiles.e2e.length} E2E tests`);
  });

  test('should parse @testCovers annotations correctly', async () => {
    // Create test file with annotations
    const testFile = join(projectRoot, 'tests', 'unit', 'js', 'temp-annotation-test.test.js');
    testFiles.push(testFile);

    const testContent = `/*` + `*
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
    const result = runner.parseTestAnnotations(testFile);

    assert(result.alwaysRun === true, 'Should detect @testCovers * as always run');
    assert(result.dependencies.includes('app/src/modules/application.js'), 'Should parse explicit dependency');
    assert(result.dependencies.includes('server/api/files.py'), 'Should parse Python dependency');

    console.log('Parsed annotations:', result);
  });

  test('should parse @env annotations and categorize env vars vs env files', async () => {
    // Create test file with @env annotations including both env vars and file paths
    const testFile = join(projectRoot, 'tests', 'e2e', 'temp-env-test.spec.js');
    testFiles.push(testFile);

    // Create a temp .env file to test file path detection
    const envFilePath = join(projectRoot, '.env.test-temp');
    writeFileSync(envFilePath, 'TEST_VAR=value\n');
    testFiles.push(envFilePath);

    const testContent = `/**
 * Test file for environment variable parsing
 * @testCovers app/src/plugins/extraction.js
 * @env GROBID_SERVER_URL
 * @env GEMINI_API_KEY
 * @env TEST_MODE="e2e"
 * @env .env.test-temp
 */
import { test } from '@playwright/test';
test('dummy test', () => {});
`;

    writeFileSync(testFile, testContent);

    const runner = new SmartTestRunner();
    const result = runner.parseTestAnnotations(testFile);

    // Test annotation parsing
    assert(result.envVars.length === 4, 'Should parse all @env annotations');
    assert(result.envVars.includes('GROBID_SERVER_URL'), 'Should parse environment variable name');
    assert(result.envVars.includes('GEMINI_API_KEY'), 'Should parse second environment variable');
    assert(result.envVars.includes('TEST_MODE="e2e"'), 'Should parse environment variable assignment');
    assert(result.envVars.includes('.env.test-temp'), 'Should parse env file path');
    assert(result.dependencies.includes('app/src/plugins/extraction.js'), 'Should still parse @testCovers');

    // Test E2E command generation with --dry-run
    // Mock to return only our test file
    const originalGetTestsToRun = runner.getTestsToRun;
    runner.getTestsToRun = async (options) => {
      const analysisResult = await runner.analyzeDependencies(options);
      return {
        tests: { js: [], py: [], api: [], e2e: [`tests/e2e/${basename(testFile)}`] },
        analysisResult
      };
    };

    try {
      // Capture the dry-run output
      let capturedOutput = '';
      const originalLog = console.log;
      console.log = (...args) => {
        capturedOutput += args.join(' ') + '\n';
        originalLog(...args);
      };

      try {
        await runner.run({ dryRun: true });

        // Verify the E2E command contains environment variables as --env
        assert(capturedOutput.includes('--env "GROBID_SERVER_URL"'), 'Should include GROBID_SERVER_URL as --env in E2E command');
        assert(capturedOutput.includes('--env "GEMINI_API_KEY"'), 'Should include GEMINI_API_KEY as --env in E2E command');
        assert(capturedOutput.includes('--env "TEST_MODE="e2e""'), 'Should include TEST_MODE assignment as --env in E2E command');

        // Verify the E2E command contains file path as --env-file
        assert(capturedOutput.includes('--env-file ".env.test-temp"'), 'Should include .env.test-temp as --env-file in E2E command');

        assert(capturedOutput.includes('node tests/e2e-runner.js --local'), 'Should use e2e-runner');

        console.log('Environment variable command generation test passed');
        console.log('Generated command correctly categorizes env vars and env files');

      } finally {
        console.log = originalLog;
      }
    } finally {
      runner.getTestsToRun = originalGetTestsToRun;
    }
  });

  test('should throw error when multiple .env files are specified in same suite', async () => {
    // Create two test files with different .env files
    const testFile1 = join(projectRoot, 'tests', 'e2e', 'temp-env-conflict1.spec.js');
    const testFile2 = join(projectRoot, 'tests', 'e2e', 'temp-env-conflict2.spec.js');
    testFiles.push(testFile1, testFile2);

    // Create two different .env files
    const envFilePath1 = join(projectRoot, '.env.test-temp1');
    const envFilePath2 = join(projectRoot, '.env.test-temp2');
    writeFileSync(envFilePath1, 'TEST_VAR1=value1\n');
    writeFileSync(envFilePath2, 'TEST_VAR2=value2\n');
    testFiles.push(envFilePath1, envFilePath2);

    const testContent1 = `/**
 * @testCovers app/src/plugins/extraction.js
 * @env .env.test-temp1
 */
import { test } from '@playwright/test';
test('dummy test 1', () => {});
`;

    const testContent2 = `/**
 * @testCovers app/src/plugins/extraction.js
 * @env .env.test-temp2
 */
import { test } from '@playwright/test';
test('dummy test 2', () => {});
`;

    writeFileSync(testFile1, testContent1);
    writeFileSync(testFile2, testContent2);

    const runner = new SmartTestRunner();

    // Mock to return both test files in E2E suite
    const originalGetTestsToRun = runner.getTestsToRun;
    runner.getTestsToRun = async (options) => {
      const analysisResult = await runner.analyzeDependencies(options);
      return {
        tests: { js: [], py: [], api: [], e2e: [`tests/e2e/${basename(testFile1)}`, `tests/e2e/${basename(testFile2)}`] },
        analysisResult
      };
    };

    try {
      let errorThrown = false;
      let errorMessage = '';

      try {
        await runner.run({ dryRun: true });
      } catch (error) {
        errorThrown = true;
        errorMessage = error.message;
      }

      assert(errorThrown, 'Should throw an error when multiple .env files are specified');
      assert(errorMessage.includes('E2E test suite has conflicting .env files'), 'Error message should mention conflicting .env files');
      assert(errorMessage.includes('.env.test-temp1'), 'Error message should list first .env file');
      assert(errorMessage.includes('.env.test-temp2'), 'Error message should list second .env file');

      console.log('Conflicting .env files validation test passed');
      console.log('Error message:', errorMessage);

    } finally {
      runner.getTestsToRun = originalGetTestsToRun;
    }
  });

  test('should detect dependencies via madge analysis', async () => {
    // Create test file that imports from app/src
    const testFile = join(projectRoot, 'tests', 'unit', 'js', 'temp-import-test.test.js');
    testFiles.push(testFile);

    const testContent = `/**
 * Test file for import analysis
 */
import { Application } from '../../../app/src/modules/application.js';
import PluginManager from '../../../app/src/modules/plugin-manager.js';
import { test } from 'node:test';

test('dummy test', () => {
  // Test content
});
`;

    writeFileSync(testFile, testContent);

    const runner = new SmartTestRunner();
    const testFileName = basename(testFile);
    const result = await runner.analyzeJSDependencies([`tests/unit/js/${testFileName}`]);

    const testKey = `tests/unit/js/${testFileName}`;
    assert(result.dependencies[testKey], 'Should analyze test file dependencies');

    const deps = result.dependencies[testKey].dependencies;
    assert(deps.some(dep => dep.includes('application')), 'Should detect application.js import');
    assert(deps.some(dep => dep.includes('plugin-manager')), 'Should detect plugin-manager.js import');

    console.log(`tests/unit/js/temp-import-test.test.js: ${deps.length} dependencies`);
    console.log('Detected dependencies:', deps);
  });

  test('should select relevant tests based on file changes', async () => {
    // Create a test file with specific dependencies
    const testFile = join(projectRoot, 'tests', 'unit', 'js', 'temp-selection-test.test.js');
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
      const { tests: testsToRun } = await runner.getTestsToRun();

      const testFileName = `tests/unit/js/${basename(testFile)}`;
      assert(testsToRun.js.includes(testFileName), 'Should include test that covers changed file');

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
      const { tests: testsToRun } = await runner.getTestsToRun();

      // When no files have changed, only always-run tests should be selected
      // Filter out temporary test files created by other tests in this suite
      const realJSTests = testsToRun.js.filter(test => !test.includes('temp-'));
      const realPyTests = testsToRun.py.filter(test => !test.includes('temp_'));
      const realAPITests = (testsToRun.api || []).filter(test => !test.includes('temp-'));
      const realE2ETests = (testsToRun.e2e || []).filter(test => !test.includes('temp-'));

      // Real test files should not run since we removed @testCovers * from them
      assert(realJSTests.length === 0, `Should not run real JavaScript tests when no changes, but got: ${realJSTests.join(', ')}`);
      assert(realPyTests.length === 0, `Should not run real Python tests when no changes, but got: ${realPyTests.join(', ')}`);
      assert(realAPITests.length === 0, `Should not run real API tests when no changes, but got: ${realAPITests.join(', ')}`);
      assert(realE2ETests.length === 0, `Should not run real E2E tests when no changes, but got: ${realE2ETests.join(', ')}`);

      console.log('Tests for no changes scenario:', testsToRun);
      const totalTests = testsToRun.js.length + testsToRun.py.length + (testsToRun.api?.length || 0) + (testsToRun.e2e?.length || 0);
      console.log(`Total tests selected: ${totalTests}`);
    } finally {
      runner.getChangedFiles = originalGetChangedFiles;
    }
  });


  test('should handle Python test file parsing', async () => {
    // Create temporary Python test file
    const testFile = join(projectRoot, 'tests', 'unit', 'fastapi', 'temp_python_test.py');
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
    const testFileName = basename(testFile);
    const result = await runner.analyzePyDependencies([`tests/unit/fastapi/${testFileName}`]);

    const testKey = `tests/unit/fastapi/${testFileName}`;
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

      const { tests: testsToRun } = await runner.getTestsToRun();

      // Should run application tests since application.js was changed
      assert(testsToRun.js.includes('tests/unit/js/application.test.js'), 'Should run application tests for application.js changes');

      console.log('Git detected changes:', changedFiles);
      console.log('Selected tests for changes:', testsToRun);

    } finally {
      // Restore original content
      writeFileSync(sourceFile, originalContent);
    }
  });

  test('should accept positional arguments as changed files', async () => {
    const runner = new SmartTestRunner();

    // Test with positional arguments instead of --changed-files
    const customChangedFiles = ['app/src/modules/state-manager.js', 'app/src/ui.js'];

    const { tests: testsToRun } = await runner.getTestsToRun({ changedFiles: customChangedFiles });

    // Should find tests that cover state-manager.js or ui.js
    // At minimum, we know that tests covering state-manager.js should be selected
    const hasRelevantTest = testsToRun.js.some(test =>
      test.includes('state-manager') || test.includes('ui')
    );

    assert(hasRelevantTest || testsToRun.js.length === 0, 'Should select tests based on positional arguments or none if no matches');

    console.log('Tests selected for custom changed files:', testsToRun);
    console.log('Custom changed files:', customChangedFiles);
  });

  test('should match tests via transitive dependencies', async () => {
    // Create runner without ignoring api-client-v1.js for this test
    const runner = new SmartTestRunner({ ignoreChanges: [] });

    // Build reverse dependency graph
    const reverseDeps = await runner.buildReverseDependencyGraph();

    // Check that api-client-v1.js has reverse dependencies
    const apiClientFile = 'app/src/modules/api-client-v1.js';
    assert(reverseDeps.has(apiClientFile), 'Reverse deps should include api-client-v1.js');

    // Get files that transitively depend on api-client-v1.js
    const affected = runner.getTransitivelyAffectedFiles(apiClientFile, reverseDeps);

    // Should include files that import it
    assert(affected.has('app/src/plugins/client.js'), 'Should include direct importer client.js');

    // Should include files that transitively depend on it
    assert(affected.has('app/src/app.js'), 'Should include transitive dependency app.js');

    console.log(`Files transitively affected by ${apiClientFile}:`, Array.from(affected).sort());

    // Now test that changing api-client-v1.js triggers tests that cover app.js
    const customChangedFiles = [apiClientFile];
    const { tests: testsToRun } = await runner.getTestsToRun({ changedFiles: customChangedFiles });

    // E2E test has @testCovers app/src/*, which should match all affected files
    const hasE2ETest = testsToRun.e2e.some(test => test.includes('app-loading'));
    assert(hasE2ETest, 'Should select E2E test that covers app/src/* via transitive dependencies');

    console.log('Tests selected for api-client-v1.js change:', testsToRun);
  });

  test('should ignore auto-generated files from change detection', async () => {
    // Default runner has api-client-v1.js in ignore list
    const runner = new SmartTestRunner();

    // Test that api-client-v1.js is ignored
    const changedFiles = runner.getChangedFiles(['app/src/modules/api-client-v1.js', 'app/src/app.js']);

    assert(!changedFiles.includes('app/src/modules/api-client-v1.js'), 'Should ignore api-client-v1.js');
    assert(changedFiles.includes('app/src/app.js'), 'Should include app.js');

    console.log('Filtered changed files:', changedFiles);

    // Test with regex pattern
    const runnerWithPattern = new SmartTestRunner({
      ignoreChanges: [/.*-generated\.js$/, 'app/src/modules/api-client-v1.js']
    });

    const changedFiles2 = runnerWithPattern.getChangedFiles([
      'app/src/modules/api-client-v1.js',
      'app/src/foo-generated.js',
      'app/src/app.js'
    ]);

    assert(!changedFiles2.includes('app/src/modules/api-client-v1.js'), 'Should ignore api-client-v1.js');
    assert(!changedFiles2.includes('app/src/foo-generated.js'), 'Should ignore foo-generated.js via pattern');
    assert(changedFiles2.includes('app/src/app.js'), 'Should include app.js');

    console.log('Filtered changed files with pattern:', changedFiles2);
  });

});
