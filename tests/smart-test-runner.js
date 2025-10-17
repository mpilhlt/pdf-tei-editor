#!/usr/bin/env node
import { execSync } from 'child_process';
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { Command } from 'commander';
import madge from 'madge';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = dirname(__dirname); // Go up from tests to project root

let DEBUG = false;
/**
 * @param {...any} args
 */
const debugLog = (...args) => {
  if (DEBUG) {
    console.log('[DEBUG]', ...args);
  }
};

/**
 * Smart test runner that analyzes dependencies to run only relevant tests
 * 
 * Test files can use JSDoc annotations to control behavior:
 * - @testCovers path/to/file.js - Explicitly declare dependencies
 * - @testCovers * - Mark as critical test that always runs
 */
class SmartTestRunner {
  constructor() {
    // Removed caching system for simplicity and reliability
  }

  async discoverTestFiles() {
    const testsDir = join(projectRoot, 'tests');
    if (!existsSync(testsDir)) return { js: [], py: [], api: [], e2e: [] };

    const { glob } = await import('glob');

    // Discover JS unit tests in tests/unit/ (recursively)
    const unitDir = join(testsDir, 'unit');
    const jsTests = [];
    if (existsSync(unitDir)) {
      const jsPattern = join(unitDir, '**/*.test.js');
      const jsFiles = await glob(jsPattern);
      jsTests.push(...jsFiles.map(file => file.replace(projectRoot + '/', '')));
    }

    // Discover Python unit tests in tests/unit/ (recursively)
    const pyTests = [];
    if (existsSync(unitDir)) {
      const pyPattern = join(unitDir, '**/test_*.py');
      const pyFiles = await glob(pyPattern);
      pyTests.push(...pyFiles.map(file => file.replace(projectRoot + '/', '')));
    }

    // Discover API tests in tests/api/ (backend API integration tests)
    const apiTests = [];
    const apiDir = join(testsDir, 'api');
    if (existsSync(apiDir)) {
      const apiPattern = join(apiDir, '**/*.test.js');
      const apiFiles = await glob(apiPattern);
      apiTests.push(...apiFiles.map(file => file.replace(projectRoot + '/', '')));
    }

    // Discover E2E tests in tests/e2e/ (Playwright frontend E2E tests)
    const e2eTests = [];
    const e2eDir = join(testsDir, 'e2e');
    if (existsSync(e2eDir)) {
      const e2ePattern = join(e2eDir, '**/*.spec.js');
      const e2eFiles = await glob(e2ePattern);
      e2eTests.push(...e2eFiles.map(file => file.replace(projectRoot + '/', '')));
    }

    if (!process.argv.includes('--tap')) {
      console.log(`📋 Discovered ${jsTests.length} JS unit tests, ${pyTests.length} Python unit tests, ${apiTests.length} API tests, ${e2eTests.length} E2E tests`);
    }
    return { js: jsTests, py: pyTests, api: apiTests, e2e: e2eTests };
  }

  /**
   * @param {string} filePath
   */
  parseTestAnnotations(filePath) {
    debugLog(`ENTERING parseTestAnnotations for ${filePath}`);
    try {
      const content = readFileSync(filePath, 'utf8');

      // For JS files, parse JSDoc comments
      if (filePath.endsWith('.js')) {
        const coversTags = [];
        const envVars = [];
        let isAlwaysRun = false;

        const jsdocRegex = /\/\*\*([\s\S]*?)\*\//g;
        let commentMatch;
        while ((commentMatch = jsdocRegex.exec(content)) !== null) {
            const commentBlock = commentMatch[1];
            const coversRegex = /@testCovers\s+([^\s\n]+)/g;
            let match;
            while ((match = coversRegex.exec(commentBlock)) !== null) {
                const target = match[1].trim();
                if (target === '*') {
                    isAlwaysRun = true;
                } else if (target) {
                    coversTags.push(target);
                }
            }

            // Parse @env annotations (only VAR_NAME or VAR=VALUE, not file paths)
            const envRegex = /@env\s+([^\n]+)/g;
            while ((match = envRegex.exec(commentBlock)) !== null) {
                const envSpec = match[1].trim();
                // Only support VAR_NAME or VAR=VALUE format
                if (envSpec && !envSpec.includes('/') && !envSpec.startsWith('.')) {
                    envVars.push(envSpec);
                }
            }
        }
        debugLog(`Parsing ${filePath}`, { covers: coversTags, env: envVars, alwaysRun: isAlwaysRun });
        return { dependencies: coversTags, alwaysRun: isAlwaysRun, envVars };
      }

      // For Python files, parse docstring comments
      if (filePath.endsWith('.py')) {
        const coversTags = [];
        const envVars = [];
        let isAlwaysRun = false;

        // First extract docstring content
        const docstringRegex = /"""([\s\S]*?)"""/;
        const docstringMatch = content.match(docstringRegex);

        if (docstringMatch) {
          const docstring = docstringMatch[1];
          // Find all @testCovers annotations within the docstring
          const coversRegex = /@testCovers\s+([^\s\n]+)/g;
          let match;
          while ((match = coversRegex.exec(docstring)) !== null) {
            const target = match[1].trim();
            if (target === '*') {
              isAlwaysRun = true;
            } else if (target) {
              coversTags.push(target);
            }
          }

          // Parse @env annotations (only VAR_NAME or VAR=VALUE, not file paths)
          const envRegex = /@env\s+([^\n]+)/g;
          while ((match = envRegex.exec(docstring)) !== null) {
            const envSpec = match[1].trim();
            // Only support VAR_NAME or VAR=VALUE format
            if (envSpec && !envSpec.includes('/') && !envSpec.startsWith('.')) {
              envVars.push(envSpec);
            }
          }
        }
        debugLog(`Parsing ${filePath}`, { covers: coversTags, env: envVars, alwaysRun: isAlwaysRun });
        return { dependencies: coversTags, alwaysRun: isAlwaysRun, envVars };
      }

      return { dependencies: [], alwaysRun: false, envVars: [] };
    } catch (error) {
      return { dependencies: [], alwaysRun: false, envVars: [] };
    }
  }

  /**
   * @param {string[]} testFiles
   */
  async analyzeJSDependencies(testFiles) {
    if (!process.argv.includes('--tap')) console.log('🔍 Analyzing JavaScript dependencies...');
    /** @type {Record<string, {dependencies: string[], alwaysRun: boolean, envVars: string[]}>} */
    const jsDeps = {};
    /** @type {string[]} */
    const alwaysRunTests = [];

    for (const testFile of testFiles) {
      const fullPath = join(projectRoot, testFile);
      if (!existsSync(fullPath)) continue;

      try {
        // Parse @testCovers and @env annotations
        const { dependencies: explicitDeps, alwaysRun, envVars } = this.parseTestAnnotations(fullPath);
        
        if (alwaysRun) {
          alwaysRunTests.push(testFile);
        }
        
        // Use madge to analyze imports with correct API
        const result = await madge(testFile, {
          baseDir: projectRoot,
          fileExtensions: ['js'],
          excludeRegExp: [/node_modules/, /\.husky/]
        });
        
        // Get the dependency tree using the correct method
        const dependencyTree = result.obj();
        
        const dependencies = dependencyTree[testFile] || [];
        
        
        const filteredDeps = dependencies
          .map(dep => {
            // paths are now relative to project root, so no need for complex mapping
            return dep;
          })
          .filter(dep => dep.startsWith('app/') || dep.startsWith('server/'))
          .map(dep => dep.replace(/^\.\//, ''));

        // Combine explicit and discovered dependencies
        jsDeps[testFile] = {
          dependencies: [...new Set([...explicitDeps, ...filteredDeps])],
          alwaysRun,
          envVars
        };
        
        const depCount = jsDeps[testFile].dependencies.length;
        const alwaysRunFlag = alwaysRun ? ' (always run)' : '';
        debugLog(`  ${testFile}: ${depCount} dependencies${alwaysRunFlag}`);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.warn(`  Could not analyze ${testFile}:`, errorMessage);
        jsDeps[testFile] = { dependencies: [], alwaysRun: false, envVars: [] };
      }
    }

    return { dependencies: jsDeps, alwaysRunTests };
  }

  /**
   * @param {string[]} testFiles
   */
  async analyzePyDependencies(testFiles) {
    if (!process.argv.includes('--tap')) console.log('🔍 Analyzing Python dependencies...');
    /** @type {Record<string, {dependencies: string[], alwaysRun: boolean, envVars: string[]}>} */
    const pyDeps = {};
    /** @type {string[]} */
    const alwaysRunTests = [];

    for (const testFile of testFiles) {
      const fullPath = join(projectRoot, testFile);
      if (!existsSync(fullPath)) continue;

      try {
        const content = readFileSync(fullPath, 'utf8');
        const dependencies = [];

        // Parse @testCovers and @env annotations
        const { dependencies: explicitDeps, alwaysRun, envVars } = this.parseTestAnnotations(fullPath);
        
        if (alwaysRun) {
          alwaysRunTests.push(testFile);
        }

        // Extract import statements
        const importRegex = /^(?:from|import)\s+([a-zA-Z_][a-zA-Z0-9_.]*)/gm;
        let match;
        while ((match = importRegex.exec(content)) !== null) {
          const module = match[1];
          // Convert module paths to file paths
          if (module.startsWith('server.') || module.startsWith('bin.')) {
            const filePath = module.replace(/\./g, '/') + '.py';
            dependencies.push(filePath);
          }
        }

        pyDeps[testFile] = {
          dependencies: [...new Set([...explicitDeps, ...dependencies])],
          alwaysRun,
          envVars
        };
        
        const depCount = pyDeps[testFile].dependencies.length;
        const alwaysRunFlag = alwaysRun ? ' (always run)' : '';
        debugLog(`  ${testFile}: ${depCount} dependencies${alwaysRunFlag}`);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.warn(`  Could not analyze ${testFile}:`, errorMessage);
        pyDeps[testFile] = { dependencies: [], alwaysRun: false, envVars: [] };
      }
    }

    return { dependencies: pyDeps, alwaysRunTests };
  }

  /**
   * @param {string[]} testFiles
   */
  async analyzeE2EDependencies(testFiles) {
    if (!process.argv.includes('--tap')) console.log('📱 Analyzing E2E test dependencies...');
    /** @type {Record<string, {dependencies: string[], alwaysRun: boolean, envVars: string[]}>} */
    const e2eDeps = {};
    /** @type {string[]} */
    const alwaysRunTests = [];

    for (const testFile of testFiles) {
      try {
        const testPath = join(projectRoot, testFile);
        const parseResult = this.parseTestAnnotations(testPath);

        const { dependencies: explicitDeps, alwaysRun, envVars } = parseResult;

        if (alwaysRun) {
          alwaysRunTests.push(testFile);
        }

        // E2E tests typically cover frontend files by default
        const dependencies = [...explicitDeps];

        e2eDeps[testFile] = {
          dependencies: [...new Set(dependencies)],
          alwaysRun,
          envVars
        };

        const depCount = e2eDeps[testFile].dependencies.length;
        const alwaysRunFlag = alwaysRun ? ' (always run)' : '';
        debugLog(`  ${testFile}: ${depCount} dependencies${alwaysRunFlag}`);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.warn(`  Could not analyze ${testFile}:`, errorMessage);
        e2eDeps[testFile] = { dependencies: [], alwaysRun: false, envVars: [] };
      }
    }

    return { dependencies: e2eDeps, alwaysRunTests };
  }

  /**
   * @param {{tap?: boolean, all?: boolean, changedFiles?: string[] | null}} options
   */
  async analyzeDependencies(options = {}) {
    if (options.tap) {
        // No analysis needed for TAP mode, but we need to discover tests
        return { dependencies: {}, alwaysRunTests: [] };
    }

    if (!process.argv.includes('--tap')) console.log('🔬 Running dependency analysis...');

    const testFiles = await this.discoverTestFiles();
    const [jsResult, pyResult, apiResult, e2eResult] = await Promise.all([
      this.analyzeJSDependencies(testFiles.js),
      this.analyzePyDependencies(testFiles.py),
      this.analyzeE2EDependencies(testFiles.api),
      this.analyzeE2EDependencies(testFiles.e2e)
    ]);

    const allDeps = { ...jsResult.dependencies, ...pyResult.dependencies, ...apiResult.dependencies, ...e2eResult.dependencies };
    const allAlwaysRun = [...jsResult.alwaysRunTests, ...pyResult.alwaysRunTests, ...apiResult.alwaysRunTests, ...e2eResult.alwaysRunTests];

    return {
      dependencies: allDeps,
      alwaysRunTests: allAlwaysRun
    };
  }

  /**
   * @param {string[] | null} customFiles
   * @returns {string[]}
   */
  getChangedFiles(customFiles = null) {
    if (customFiles) {
      debugLog('Using custom changed files:', customFiles);
      return customFiles;
    }

    try {
      // Get staged files
      const staged = execSync('git diff --cached --name-only', { encoding: 'utf8' });
      // Get modified files
      const modified = execSync('git diff --name-only', { encoding: 'utf8' });

      const allChanged = [...new Set([
        ...staged.split('\n').filter(f => f.trim()),
        ...modified.split('\n').filter(f => f.trim())
      ])];
      debugLog('Found changed files from git:', allChanged);
      return allChanged;
    } catch (error) {
      console.warn('Could not get changed files, running all tests');
      return [];
    }
  }

  /**
   * @param {string} testFile
   * @param {string[]} changedFiles
   * @param {{dependencies: Record<string, {dependencies: string[], alwaysRun: boolean}>}} analysisResult
   */
  shouldRunTest(testFile, changedFiles, analysisResult) {
    const testData = analysisResult.dependencies[testFile];
    if (!testData) {
      debugLog(`No analysis data for ${testFile}, skipping.`);
      return false;
    }

    // Always run if marked with @testCovers *
    if (testData.alwaysRun) {
      debugLog(`${testFile} is marked as always run.`);
      return true;
    }

    const testDeps = testData.dependencies || [];
    
    return changedFiles.some((/** @type {string} */ changedFile) => {
      return testDeps.some((/** @type {string} */ dep) => {
        let match = false;
        // Support directory matches (ending with /)
        if (dep.endsWith('/')) {
          match = changedFile.startsWith(dep);
        }
        // Support partial matches (ending with -)
        else if (dep.endsWith('-')) {
          match = changedFile.startsWith(dep);
        }
        // Support wildcard matches (containing *)
        else if (dep.includes('*')) {
          const pattern = dep.replace(/\*/g, '.*');
          const regex = new RegExp(`^${pattern}`);
          match = regex.test(changedFile);
        }
        // Exact file match
        else {
            match = changedFile === dep || changedFile.startsWith(dep.replace(/\.js$/, ''));
        }
        if(match) {
            debugLog(`Match found for ${testFile}: changed file '${changedFile}' matches dependency '${dep}'`);
        }
        return match;
      });
    });
  }

  /**
   * @param {{all?: boolean, tap?: boolean, changedFiles?: string[] | null}} options
   */
  async getTestsToRun(options = {}) {
    const testFiles = await this.discoverTestFiles();

    if (options.all) {
      if (!options.tap) console.log('🏃 Running all tests...');
      // For --all mode, we still need analysis to get environment variables
      const analysisResult = await this.analyzeDependencies(options);
      return { tests: testFiles, analysisResult };
    }

    const changedFiles = this.getChangedFiles(options.changedFiles);
    if (!options.tap) console.log('📁 Changed files:', changedFiles.length > 0 ? changedFiles.join(', ') : 'none');

    const analysisResult = await this.analyzeDependencies(options);
    debugLog('Analysis result:', JSON.stringify(analysisResult, null, 2));

    if (changedFiles.length === 0) {
      // No changes, run only always-run tests
      const alwaysRunJs = testFiles.js.filter(test =>
        analysisResult.alwaysRunTests.includes(test)
      );
      const alwaysRunPy = testFiles.py.filter(test =>
        analysisResult.alwaysRunTests.includes(test)
      );
      const alwaysRunApi = testFiles.api.filter(test =>
        analysisResult.alwaysRunTests.includes(test)
      );
      const alwaysRunE2e = testFiles.e2e.filter(test =>
        analysisResult.alwaysRunTests.includes(test)
      );
      const tests = { js: alwaysRunJs, py: alwaysRunPy, api: alwaysRunApi, e2e: alwaysRunE2e };
      debugLog('No changed files, running only always-run tests:', tests);
      return { tests, analysisResult };
    }

    const jsTests = testFiles.js.filter(test =>
      this.shouldRunTest(test, changedFiles, analysisResult)
    );

    const pyTests = testFiles.py.filter(test =>
      this.shouldRunTest(test, changedFiles, analysisResult)
    );

    const apiTests = testFiles.api.filter(test =>
      this.shouldRunTest(test, changedFiles, analysisResult)
    );

    const e2eTests = testFiles.e2e.filter(test =>
      this.shouldRunTest(test, changedFiles, analysisResult)
    );

    const tests = { js: jsTests, py: pyTests, api: apiTests, e2e: e2eTests };
    debugLog('Selected tests to run based on changes:', tests);
    return { tests, analysisResult };
  }

  /**
   * @typedef {Object} RunOptions
   * @property {boolean} [tap] - Output in TAP format
   * @property {boolean} [dryRun] - Show which tests would run without executing
   * @property {boolean} [all] - Run all tests regardless of changes
   * @property {string[] | null} [changedFiles] - Custom list of changed files to analyze
   */

  /**
   * @param {RunOptions} options
   */
  async run(options = {}) {
    const isTap = options.tap;
    const dryRun = options.dryRun;

    if (isTap) {
        // In TAP mode, we don't show the smart runner's own logs, only the TAP output from the runners
    } else {
        console.log('🧠 Smart Test Runner - Analyzing dependencies and changes...');
    }

    const { tests: testsToRun, analysisResult } = await this.getTestsToRun(options);

    const jsCommand = testsToRun.js.length > 0 ? `node tests/unit-test-runner.js ${isTap ? '--tap' : ''} ${testsToRun.js.join(' ')}` : null;
    const pyCommand = testsToRun.py.length > 0 ? `uv run python tests/unit-test-runner.py ${isTap ? '--tap' : ''} ${testsToRun.py.join(' ')}` : null;

    // Collect environment variables from API tests
    const apiEnvVars = new Set();
    if (testsToRun.api && testsToRun.api.length > 0) {
      for (const testFile of testsToRun.api) {
        const testData = analysisResult.dependencies[testFile];
        if (testData && testData.envVars) {
          testData.envVars.forEach(envVar => apiEnvVars.add(envVar));
        }
      }
    }

    // Collect environment variables from E2E tests
    const e2eEnvVars = new Set();
    if (testsToRun.e2e && testsToRun.e2e.length > 0) {
      for (const testFile of testsToRun.e2e) {
        const testData = analysisResult.dependencies[testFile];
        if (testData && testData.envVars) {
          testData.envVars.forEach(envVar => e2eEnvVars.add(envVar));
        }
      }
    }

    // Build API test command (backend API integration tests)
    let apiCommand = null;
    if (testsToRun.api && testsToRun.api.length > 0) {
      const testFiles = testsToRun.api.join(' ');
      const envArgsStr = Array.from(apiEnvVars).map(v => `--env "${v}"`).join(' ');
      const extraArgs = envArgsStr ? `${envArgsStr} ` : '';
      // Route API tests to backend-test-runner (.env auto-detected from test directory)
      apiCommand = `node tests/backend-test-runner.js ${extraArgs}${testFiles}`.trim();
    }

    // Build E2E command (Playwright frontend tests)
    let e2eCommand = null;
    if (testsToRun.e2e && testsToRun.e2e.length > 0) {
      const testFiles = testsToRun.e2e.map(f => f.replace('tests/e2e/', '').replace('.spec.js', '')).join('|');
      const grepArg = `--grep "${testFiles}"`;
      const envArgsStr = Array.from(e2eEnvVars).map(v => `--env "${v}"`).join(' ');
      const extraArgs = [grepArg, envArgsStr].filter(Boolean).join(' ');
      // Use e2e-runner.js for Playwright tests in local mode (.env auto-detected)
      e2eCommand = `node tests/e2e-runner.js --local ${extraArgs}`;
    }

    const testSuites = [
        {name: 'JavaScript unit tests', command: jsCommand, tap: isTap},
        {name: 'Python unit tests', command: pyCommand, tap: isTap},
        {name: 'API tests', command: apiCommand, tap: false},
        {name: 'E2E tests', command: e2eCommand, tap: false}
    ].filter(s => s.command);

    if (dryRun) {
        console.log('🔍 Dry run - showing tests that would run:');
        if (testsToRun.js.length > 0) {
          console.log('\n  📄 JavaScript unit tests:');
          testsToRun.js.forEach(test => console.log(`    - ${test}`));
        }
        if (testsToRun.py.length > 0) {
          console.log('\n  🐍 Python unit tests:');
          testsToRun.py.forEach(test => console.log(`    - ${test}`));
        }
        if (testsToRun.api && testsToRun.api.length > 0) {
          console.log('\n  🔌 API tests:');
          testsToRun.api.forEach(test => console.log(`    - ${test}`));
        }
        if (testsToRun.e2e && testsToRun.e2e.length > 0) {
            console.log('\n  🌐 E2E tests:');
            testsToRun.e2e.forEach(test => console.log(`    - ${test}`));
        }

        if (testSuites.length === 0) {
            console.log('\n✅ No relevant tests would run');
        } else {
            const totalTests = testsToRun.js.length + testsToRun.py.length + (testsToRun.api?.length || 0) + (testsToRun.e2e?.length || 0);
            console.log(`\n📊 Total: ${totalTests} tests would run across ${testSuites.length} suite(s)`);
            console.log('\n📋 Commands that would be executed:');
            testSuites.forEach(suite => {
              if (suite.command) {
                console.log(`  ${suite.name}: ${suite.command}`);
              }
            });
        }
        return;
    }

    if (isTap) {
        console.log('TAP version 13');
        console.log(`1..${testSuites.length}`);
    }

    if (testSuites.length === 0) {
      if (!isTap) console.log('✅ No relevant tests to run');
      return;
    }

    if (!isTap) {
        console.log(`🧪 Running ${testSuites.length} test suite(s):`);
        if (testsToRun.js.length > 0) {
          console.log('  JavaScript unit tests:');
          testsToRun.js.forEach(test => console.log(`    - ${test}`));
        }
        if (testsToRun.py.length > 0) {
          console.log('  Python unit tests:');
          testsToRun.py.forEach(test => console.log(`    - ${test}`));
        }
        if (testsToRun.api && testsToRun.api.length > 0) {
          console.log('  API tests:');
          testsToRun.api.forEach(test => console.log(`    - ${test}`));
        }
        if (testsToRun.e2e && testsToRun.e2e.length > 0) {
            console.log('  E2E tests:');
            testsToRun.e2e.forEach(test => console.log(`    - ${test}`));
        }
    }

    let testCounter = 1;
    let allTestsPassed = true;

    for (const suite of testSuites) {
        try {
            if (!isTap) console.log(`\nRunning ${suite.name}...`);
            if (suite.command) {
              execSync(suite.command, {
                stdio: 'inherit',
                cwd: projectRoot
              });
            }
            if (isTap && !suite.tap) {
                console.log(`ok ${testCounter++} - ${suite.name}`);
            }
        } catch (error) {
            if (isTap && !suite.tap) {
                console.log(`not ok ${testCounter++} - ${suite.name}`);
            }
            allTestsPassed = false;
        }
    }

    if (!allTestsPassed) {
        if (!isTap) console.error('\n❌ Tests failed');
        process.exit(1);
    }

    if (!isTap) console.log('\n✅ All tests passed');
  }
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
    // Create Commander program
    const program = new Command();

    program
        .name('smart-test-runner')
        .description('Intelligent test execution based on file dependencies')
        .version('1.0.0')
        .option('--all', 'run all tests regardless of changes')
        .option('--dry-run', 'show which tests would run without executing them')
        .option('--tap', 'output results in TAP format')
        .option('--debug', 'enable debug logging')
        .argument('[files...]', 'list of files for which tests should be run')
        .addHelpText('after', `
Examples:
  node tests/smart-test-runner.js
  node tests/smart-test-runner.js --all
  node tests/smart-test-runner.js app/src/ui.js server/api/auth.py
  node tests/smart-test-runner.js app/src/ui.js --dry-run --debug
  node tests/smart-test-runner.js --tap

How it works:
  • Analyzes test files for @testCovers and @env annotations
  • Detects JavaScript import dependencies automatically
  • Runs only tests affected by changed files
  • Always runs tests marked with @testCovers *
  • @env annotations support VAR_NAME or VAR=VALUE format
  • .env files are auto-detected from test directories`);

    program.parse(process.argv);

    const options = program.opts();
    const files = program.args;

    // Set DEBUG flag for debugLog
    DEBUG = options.debug || false;

    const runner = new SmartTestRunner();

    const runOptions = {
        all: options.all || false,
        tap: options.tap || false,
        dryRun: options.dryRun || false,
        changedFiles: files.length > 0 ? files : null
    };

    runner.run(runOptions).catch(error => {
        console.error('Smart test runner failed:', error);
        process.exit(1);
    });
}

export default SmartTestRunner;
