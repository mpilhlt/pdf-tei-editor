#!/usr/bin/env node
import { execSync } from 'child_process';
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import madge from 'madge';
import { parse as parseComments } from 'comment-parser';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = dirname(__dirname); // Go up from tests to project root
const cacheFile = join(projectRoot, 'tests', 'test-dependencies.json');

/**
 * Smart test runner that analyzes dependencies to run only relevant tests
 * 
 * Test files can use JSDoc annotations to control behavior:
 * - @testCovers path/to/file.js - Explicitly declare dependencies
 * - @testCovers * - Mark as critical test that always runs
 */
class SmartTestRunner {
  constructor() {
    this.cache = this.loadCache();
  }

  loadCache() {
    try {
      if (existsSync(cacheFile)) {
        return JSON.parse(readFileSync(cacheFile, 'utf8'));
      }
    } catch (error) {
      console.warn('Could not load dependency cache, will regenerate');
    }
    return { dependencies: {}, lastAnalysis: 0 };
  }

  saveCache() {
    try {
      writeFileSync(cacheFile, JSON.stringify(this.cache, null, 2));
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.warn('Could not save dependency cache:', errorMessage);
    }
  }

  discoverTestFiles() {
    const testsDir = join(projectRoot, 'tests');
    if (!existsSync(testsDir)) return { js: [], py: [], e2e: [] };

    const jsTests = [];
    const pyTests = [];

    // Discover JS tests in tests/js/
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

    // Discover e2e tests (both Playwright .spec.js and backend .js)
    const e2eTests = [];
    const e2eDir = join(testsDir, 'e2e');
    if (existsSync(e2eDir)) {
      const e2eFiles = readdirSync(e2eDir);
      e2eTests.push(...e2eFiles
        .filter(file => file.endsWith('.spec.js') || (file.endsWith('.js') && file.startsWith('test-')))
        .map(file => `tests/e2e/${file}`)
      );
    }

    if (!process.argv.includes('--tap')) {
      console.log(`📋 Discovered ${jsTests.length} JS tests, ${pyTests.length} Python tests, ${e2eTests.length} E2E tests`);
    }
    return { js: jsTests, py: pyTests, e2e: e2eTests };
  }

  /**
   * @param {string} filePath
   */
  parseTestAnnotations(filePath) {
    try {
      const content = readFileSync(filePath, 'utf8');

      // For JS files, parse JSDoc comments
      if (filePath.endsWith('.js')) {
        const comments = parseComments(content);
        const coversTags = [];
        const envVars = [];
        let isAlwaysRun = false;

        for (const comment of comments) {
          for (const tag of comment.tags) {
            if (tag.tag === 'testCovers') {
              const target = tag.name || tag.description;
              if (target === '*') {
                isAlwaysRun = true;
              } else {
                coversTags.push(target);
              }
            } else if (tag.tag === 'env') {
              const envSpec = tag.name || tag.description;
              if (envSpec) {
                envVars.push(envSpec);
              }
            }
          }
        }

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
            const target = match[1];
            if (target === '*') {
              isAlwaysRun = true;
            } else {
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
        if (!process.argv.includes('--tap')) console.log(`  ${testFile}: ${depCount} dependencies${alwaysRunFlag}`);
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
        if (!process.argv.includes('--tap')) console.log(`  ${testFile}: ${depCount} dependencies${alwaysRunFlag}`);
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
        const { dependencies: explicitDeps, alwaysRun, envVars } = this.parseTestAnnotations(testPath);

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
        if (!process.argv.includes('--tap')) console.log(`  ${testFile}: ${depCount} dependencies${alwaysRunFlag}`);
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

    const needsReanalysis = Date.now() - this.cache.lastAnalysis > 24 * 60 * 60 * 1000; // 24 hours
    
    if (!needsReanalysis && this.cache.dependencies && Object.keys(this.cache.dependencies).length > 0) {
      console.log('📋 Using cached dependency analysis');
      return this.cache;
    }

    console.log('🔬 Running dependency analysis...');
    
    const testFiles = this.discoverTestFiles();
    const [jsResult, pyResult, e2eResult] = await Promise.all([
      this.analyzeJSDependencies(testFiles.js),
      this.analyzePyDependencies(testFiles.py),
      this.analyzeE2EDependencies(testFiles.e2e)
    ]);

    const allDeps = { ...jsResult.dependencies, ...pyResult.dependencies, ...e2eResult.dependencies };
    const allAlwaysRun = [...jsResult.alwaysRunTests, ...pyResult.alwaysRunTests, ...e2eResult.alwaysRunTests];
    
    const result = {
      dependencies: allDeps,
      alwaysRunTests: allAlwaysRun,
      lastAnalysis: Date.now()
    };
    
    this.cache = result;
    this.saveCache();

    return result;
  }

  /**
   * @param {string[] | null} customFiles
   * @returns {string[]}
   */
  getChangedFiles(customFiles = null) {
    if (customFiles) {
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
    if (!testData) return false;

    // Always run if marked with @testCovers *
    if (testData.alwaysRun) {
      return true;
    }

    const testDeps = testData.dependencies || [];
    
    return changedFiles.some((/** @type {string} */ changedFile) => {
      return testDeps.some((/** @type {string} */ dep) => {
        // Support directory matches (ending with /)
        if (dep.endsWith('/')) {
          return changedFile.startsWith(dep);
        }
        // Support partial matches (ending with -)
        if (dep.endsWith('-')) {
          return changedFile.startsWith(dep);
        }
        // Support wildcard matches (containing *)
        if (dep.includes('*')) {
          const pattern = dep.replace(/\*/g, '.*');
          const regex = new RegExp(`^${pattern}$`);
          return regex.test(changedFile);
        }
        // Exact file match
        return changedFile === dep || changedFile.startsWith(dep.replace(/\.js$/, ''));
      });
    });
  }

  /**
   * @param {{all?: boolean, tap?: boolean, changedFiles?: string[] | null}} options
   */
  async getTestsToRun(options = {}) {
    const testFiles = this.discoverTestFiles();

    if (options.all) {
      if (!options.tap) console.log('🏃 Running all tests...');
      // For --all mode, we still need analysis to get environment variables
      const analysisResult = await this.analyzeDependencies(options);
      return { tests: testFiles, analysisResult };
    }

    const changedFiles = this.getChangedFiles(options.changedFiles);
    if (!options.tap) console.log('📁 Changed files:', changedFiles.length > 0 ? changedFiles : 'none');

    const analysisResult = await this.analyzeDependencies(options);

    if (changedFiles.length === 0) {
      // No changes, run only always-run tests
      const alwaysRunJs = testFiles.js.filter(test =>
        analysisResult.alwaysRunTests.includes(test)
      );
      const alwaysRunPy = testFiles.py.filter(test =>
        analysisResult.alwaysRunTests.includes(test)
      );
      const alwaysRunE2E = testFiles.e2e.filter(test =>
        analysisResult.alwaysRunTests.includes(test)
      );
      return { tests: { js: alwaysRunJs, py: alwaysRunPy, e2e: alwaysRunE2E }, analysisResult };
    }

    const jsTests = testFiles.js.filter(test =>
      this.shouldRunTest(test, changedFiles, analysisResult)
    );

    const pyTests = testFiles.py.filter(test =>
      this.shouldRunTest(test, changedFiles, analysisResult)
    );

    const e2eTests = testFiles.e2e.filter(test =>
      this.shouldRunTest(test, changedFiles, analysisResult)
    );

    return { tests: { js: jsTests, py: pyTests, e2e: e2eTests }, analysisResult };
  }

  /**
   * @param {{tap?: boolean, dryRun?: boolean, all?: boolean, changedFiles?: string[] | null, dotenvPath?: string | null}} options
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
    const e2eEnvVars = new Set();
    for (const testFile of testsToRun.e2e) {
      const testData = analysisResult.dependencies[testFile];
      if (testData && testData.envVars) {
        testData.envVars.forEach(envVar => e2eEnvVars.add(envVar));
      }
    }

    // Build E2E command with environment variables and dotenv path
    let e2eCommand = null;
    if (testsToRun.e2e.length > 0) {
      const envArgs = Array.from(e2eEnvVars).map(envVar => `--env "${envVar}"`).join(' ');
      const dotenvArg = options.dotenvPath ? `--dotenv-path "${options.dotenvPath}"` : '';

      const extraArgs = [envArgs, dotenvArg].filter(Boolean).join(' ');
      e2eCommand = extraArgs ?
        `node tests/e2e-runner.js --playwright ${extraArgs}` :
        'npm run test:e2e';
    }

    const testSuites = [
        {name: 'JavaScript tests', command: jsCommand, tap: isTap},
        {name: 'Python tests', command: pyCommand, tap: isTap},
        {name: 'E2E tests', command: e2eCommand, tap: false} // no tap support for e2e
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
        if (testsToRun.e2e.length > 0) {
          console.log('\n  🌐 E2E tests:');
          testsToRun.e2e.forEach(test => console.log(`    - ${test}`));
        }

        if (testSuites.length === 0) {
            console.log('\n✅ No relevant tests would run');
        } else {
            console.log(`\n📊 Total: ${testsToRun.js.length + testsToRun.py.length + testsToRun.e2e.length} tests would run across ${testSuites.length} suite(s)`);
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
        if (testsToRun.e2e.length > 0) {
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

/**
 * @param {string[]} args
 */
function parseArgs(args) {
    const parsed = {
        all: false,
        help: false,
        tap: false,
        dryRun: false,
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
    console.log('  --help, -h               Show this help message');
    console.log('');
    console.log('Examples:');
    console.log('  node tests/smart-test-runner.js');
    console.log('  node tests/smart-test-runner.js --all');
    console.log('  node tests/smart-test-runner.js --changed-files app/src/ui.js,server/api/auth.py');
    console.log('  node tests/smart-test-runner.js --changed-files app/src/ui.js --dry-run');
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
        dotenvPath: args.dotenvPath
    };

    runner.run(options).catch(error => {
        console.error('Smart test runner failed:', error);
        process.exit(1);
    });
}

export default SmartTestRunner;
