#!/usr/bin/env node
import { execSync } from 'child_process';
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import madge from 'madge';
import { parse as parseComments } from 'comment-parser';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = dirname(__dirname); // Go up from tests to project root

const DEBUG = process.argv.includes('--debug');
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
    if (!existsSync(testsDir)) return { js: [], py: [], e2e: { playwright: [], backend: [] } };

    const jsTests = [];
    const pyTests = [];

    // Discover JS tests in tests/js/ only
    const jsDir = join(testsDir, 'js');
    if (existsSync(jsDir)) {
      const jsFiles = readdirSync(jsDir);
      jsTests.push(...jsFiles
        .filter(file => file.endsWith('.test.js') || file.endsWith('.cjs'))
        .map(file => `tests/js/${file}`)
      );
    }

    // Discover Python tests in tests/py/
    const pyDir = join(testsDir, 'py');
    if (existsSync(pyDir)) {
      const pyFiles = readdirSync(pyDir);
      pyTests.push(...pyFiles
        .filter(file => file.startsWith('test_') && file.endsWith('.py'))
        .map(file => `tests/py/${file}`)
      );
    }

    // Discover e2e tests recursively (both Playwright .spec.js and backend .test.js)
    const e2eDir = join(testsDir, 'e2e');
    const playwrightTests = [];
    const backendTests = [];

    if (existsSync(e2eDir)) {
      const { glob } = await import('glob');

      // Use recursive glob patterns to find files in subdirectories
      const playwrightPattern = join(e2eDir, '**/*.spec.js');
      const backendPattern = join(e2eDir, '**/*.test.js');

      const playwrightFiles = await glob(playwrightPattern);
      const backendFiles = await glob(backendPattern);

      playwrightTests.push(...playwrightFiles.map(file => {
        return file.replace(projectRoot + '/', ''); // Make relative to project root
      }));
      backendTests.push(...backendFiles.map(file => {
        return file.replace(projectRoot + '/', ''); // Make relative to project root
      }));
    }

    if (!process.argv.includes('--tap')) {
      console.log(`📋 Discovered ${jsTests.length} JS tests, ${pyTests.length} Python tests, ${playwrightTests.length} Playwright E2E tests, and ${backendTests.length} Backend E2E tests`);
    }
    return { js: jsTests, py: pyTests, e2e: { playwright: playwrightTests, backend: backendTests } };
  }

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

            const envRegex = /@env\s+([^\n]+)/g;
            while ((match = envRegex.exec(commentBlock)) !== null) {
                const envSpec = match[1].trim();
                if (envSpec) {
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

          // Find all @env annotations
          const envRegex = /@env\s+([^\n]+)/g;
          while ((match = envRegex.exec(docstring)) !== null) {
            const envSpec = match[1].trim();
            if (envSpec) {
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
   * @param {{tap?: boolean, all?: boolean, changedFiles?: string[] | null}}
   */
  async analyzeDependencies(options = {}) {
    if (options.tap) {
        // No analysis needed for TAP mode, but we need to discover tests
        return { dependencies: {}, alwaysRunTests: [] };
    }

    if (!process.argv.includes('--tap')) console.log('🔬 Running dependency analysis...');

    const testFiles = await this.discoverTestFiles();
    const allE2ETests = [...testFiles.e2e.playwright, ...testFiles.e2e.backend];
    const [jsResult, pyResult, e2eResult] = await Promise.all([
      this.analyzeJSDependencies(testFiles.js),
      this.analyzePyDependencies(testFiles.py),
      this.analyzeE2EDependencies(allE2ETests)
    ]);

    const allDeps = { ...jsResult.dependencies, ...pyResult.dependencies, ...e2eResult.dependencies };
    const allAlwaysRun = [...jsResult.alwaysRunTests, ...pyResult.alwaysRunTests, ...e2eResult.alwaysRunTests];
    
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
   * @param {string}
   * @param {string[]}
   * @param {{dependencies: Record<string, {dependencies: string[], alwaysRun: boolean}>}}
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
   * @param {{all?: boolean, tap?: boolean, changedFiles?: string[] | null}}
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
      const alwaysRunPlaywright = testFiles.e2e.playwright.filter(test =>
        analysisResult.alwaysRunTests.includes(test)
      );
      const alwaysRunBackend = testFiles.e2e.backend.filter(test =>
        analysisResult.alwaysRunTests.includes(test)
      );
      const tests = { js: alwaysRunJs, py: alwaysRunPy, e2e: { playwright: alwaysRunPlaywright, backend: alwaysRunBackend } };
      debugLog('No changed files, running only always-run tests:', tests);
      return { tests, analysisResult };
    }

    const jsTests = testFiles.js.filter(test =>
      this.shouldRunTest(test, changedFiles, analysisResult)
    );

    const pyTests = testFiles.py.filter(test =>
      this.shouldRunTest(test, changedFiles, analysisResult)
    );

    const playwrightTests = testFiles.e2e.playwright.filter(test =>
      this.shouldRunTest(test, changedFiles, analysisResult)
    );
    const backendTests = testFiles.e2e.backend.filter(test =>
      this.shouldRunTest(test, changedFiles, analysisResult)
    );

    const tests = { js: jsTests, py: pyTests, e2e: { playwright: playwrightTests, backend: backendTests } };
    debugLog('Selected tests to run based on changes:', tests);
    return { tests, analysisResult };
  }

  /**
   * @param {{tap?: boolean, dryRun?: boolean, all?: boolean, changedFiles?: string[] | null, dotenvPath?: string | null}}
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

    const jsCommand = testsToRun.js.length > 0 ? `node --test ${isTap ? '--test-reporter=tap' : ''} ${testsToRun.js.join(' ')}` : null;
    const pyCommand = testsToRun.py.length > 0 ? `uv run pytest ${isTap ? '--tap-stream' : ''} ${testsToRun.py.join(' ')} -v` : null;
    
    // Collect environment variables from selected E2E tests
    const playwrightEnvVars = new Set();
    if (testsToRun.e2e && testsToRun.e2e.playwright) {
      for (const testFile of testsToRun.e2e.playwright) {
        const testData = analysisResult.dependencies[testFile];
        if (testData && testData.envVars) {
          testData.envVars.forEach(envVar => playwrightEnvVars.add(envVar));
        }
      }
    }
    const backendEnvVars = new Set();
    if (testsToRun.e2e && testsToRun.e2e.backend) {
      for (const testFile of testsToRun.e2e.backend) {
          const testData = analysisResult.dependencies[testFile];
          if (testData && testData.envVars) {
              testData.envVars.forEach(envVar => backendEnvVars.add(envVar));
          }
      }
    }

    // Build E2E commands with environment variables and dotenv path
    let playwrightCommand = null;
    if (testsToRun.e2e && testsToRun.e2e.playwright && testsToRun.e2e.playwright.length > 0) {
      const testFiles = testsToRun.e2e.playwright.map(f => f.replace('tests/e2e/', '').replace('.spec.js', '')).join('|');
      const grepArg = `--grep "${testFiles}"`;
      const envArgs = Array.from(playwrightEnvVars).map(envVar => `--env "${envVar}"`).join(' ');
      const dotenvArg = options.dotenvPath ? `--dotenv-path "${options.dotenvPath}"` : '';
      const extraArgs = [grepArg, envArgs, dotenvArg].filter(Boolean).join(' ');
      playwrightCommand = `node tests/e2e-runner.js --playwright ${extraArgs}`;
    }

    let backendCommand = null;
    if (testsToRun.e2e && testsToRun.e2e.backend && testsToRun.e2e.backend.length > 0) {
        const testFiles = testsToRun.e2e.backend.map(f => f.replace('tests/e2e/', '').replace('.test.js', '')).join('|');
        const grepArg = `--grep "${testFiles}"`;
        const envArgs = Array.from(backendEnvVars).map(envVar => `--env "${envVar}"`).join(' ');
        const dotenvArg = options.dotenvPath ? `--dotenv-path "${options.dotenvPath}"` : '';
        const extraArgs = [grepArg, envArgs, dotenvArg].filter(Boolean).join(' ');
        backendCommand = `node tests/e2e-runner.js --backend ${extraArgs}`;
    }

    const testSuites = [
        {name: 'JavaScript tests', command: jsCommand, tap: isTap},
        {name: 'Python tests', command: pyCommand, tap: isTap},
        {name: 'E2E Playwright tests', command: playwrightCommand, tap: false},
        {name: 'E2E Backend tests', command: backendCommand, tap: false}
    ].filter(s => s.command);

    if (dryRun) {
        console.log('🔍 Dry run - showing tests that would run:');
        if (testsToRun.js.length > 0) {
          console.log('\n  📄 JavaScript tests:');
          testsToRun.js.forEach(test => console.log(`    - ${test}`));
        }
        if (testsToRun.py.length > 0) {
          console.log('\n  🐍 Python tests:');
          testsToRun.py.forEach(test => console.log(`    - ${test}`));
        }
        if (testsToRun.e2e && testsToRun.e2e.playwright && testsToRun.e2e.playwright.length > 0) {
          console.log('\n  🌐 E2E Playwright tests:');
          testsToRun.e2e.playwright.forEach(test => console.log(`    - ${test}`));
        }
        if (testsToRun.e2e && testsToRun.e2e.backend && testsToRun.e2e.backend.length > 0) {
            console.log('\n  🌐 E2E Backend tests:');
            testsToRun.e2e.backend.forEach(test => console.log(`    - ${test}`));
        }

        if (testSuites.length === 0) {
            console.log('\n✅ No relevant tests would run');
        } else {
            const totalE2ETests = ((testsToRun.e2e && testsToRun.e2e.playwright) ? testsToRun.e2e.playwright.length : 0) + ((testsToRun.e2e && testsToRun.e2e.backend) ? testsToRun.e2e.backend.length : 0);
            console.log(`\n📊 Total: ${testsToRun.js.length + testsToRun.py.length + totalE2ETests} tests would run across ${testSuites.length} suite(s)`);
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
          console.log('  JavaScript tests:');
          testsToRun.js.forEach(test => console.log(`    - ${test}`));
        }
        if (testsToRun.py.length > 0) {
          console.log('  Python tests:');
          testsToRun.py.forEach(test => console.log(`    - ${test}`));
        }
        if (testsToRun.e2e.playwright.length > 0) {
          console.log('  E2E Playwright tests:');
          testsToRun.e2e.playwright.forEach(test => console.log(`    - ${test}`));
        }
        if (testsToRun.e2e.backend.length > 0) {
            console.log('  E2E Backend tests:');
            testsToRun.e2e.backend.forEach(test => console.log(`    - ${test}`));
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

/**
 * @param {string[]} args
 */
function parseArgs(args) {
    const parsed = {
        all: false,
        help: false,
        tap: false,
        dryRun: false,
        debug: false,
        forceAnalysis: false,
        /** @type {string[] | null} */
        changedFiles: null,
        /** @type {string | null} */
        dotenvPath: null
    };

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];

        switch (arg) {
            case '--all':
                parsed.all = true;
                break;
            case '--help':
            case '-h':
                parsed.help = true;
                break;
            case '--tap':
                parsed.tap = true;
                break;
            case '--dry-run':
                parsed.dryRun = true;
                break;
            case '--debug':
                parsed.debug = true;
                break;
            case '--force-analysis':
                parsed.forceAnalysis = true;
                break;
            case '--changed-files':
                if (i + 1 < args.length) {
                    parsed.changedFiles = args[i + 1].split(',').map((/** @type {string} */ f) => f.trim());
                    i++; // Skip the next argument as it's the file list
                }
                break;
            case '--dotenv-path':
                if (i + 1 < args.length) {
                    parsed.dotenvPath = args[i + 1];
                    i++; // Skip the next argument as it's the dotenv path
                }
                break;
        }
    }

    return parsed;
}

function showHelp() {
    console.log('🧠 Smart Test Runner - Intelligent test execution based on file dependencies');
    console.log('');
    console.log('Usage:');
    console.log('  node tests/smart-test-runner.js [options]');
    console.log('');
    console.log('Options:');
    console.log('  --all                    Run all tests regardless of changes');
    console.log('  --changed-files <files>  Comma-separated list of changed files to analyze');
    console.log('  --dry-run                Show which tests would run without executing them');
    console.log('  --dotenv-path <path>     Path to .env file for E2E tests (passed to e2e-runner.js)');
    console.log('  --tap                    Output results in TAP format');
    console.log('  --debug                  Enable debug logging');
    console.log('  --help, -h               Show this help message');
    console.log('');
    console.log('Examples:');
    console.log('  node tests/smart-test-runner.js');
    console.log('  node tests/smart-test-runner.js --all');
    console.log('  node tests/smart-test-runner.js --changed-files app/src/ui.js,server/api/auth.py');
    console.log('  node tests/smart-test-runner.js --changed-files app/src/ui.js --dry-run --debug');
    console.log('  node tests/smart-test-runner.js --dotenv-path .env.testing');
    console.log('  node tests/smart-test-runner.js --tap');
    console.log('');
    console.log('How it works:');
    console.log('  • Analyzes test files for @testCovers annotations');
    console.log('  • Detects JavaScript import dependencies automatically');
    console.log('  • Runs only tests affected by changed files');
    console.log('  • Always runs tests marked with @testCovers *');
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
    const args = parseArgs(process.argv.slice(2));

    if (args.help) {
        showHelp();
        process.exit(0);
    }

    const runner = new SmartTestRunner();

    const options = {
        all: args.all,
        tap: args.tap,
        dryRun: args.dryRun,
        changedFiles: args.changedFiles,
        dotenvPath: args.dotenvPath,
        forceAnalysis: args.forceAnalysis
    };

    runner.run(options).catch(error => {
        console.error('Smart test runner failed:', error);
        process.exit(1);
    });
}

export default SmartTestRunner;
