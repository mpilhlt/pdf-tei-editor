#!/usr/bin/env node
import { execSync } from 'child_process';
import { readFileSync, existsSync } from 'fs';
import { join, dirname, relative } from 'path';
import { fileURLToPath } from 'url';
import { Command } from 'commander';
import madge from 'madge';
import { logger } from './api/helpers/test-logger.js';

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
 * @typedef {Object} SmartTestRunnerOptions
 * @property {string[]} [baseDirs=['app/src', 'fastapi_app']] - Base directories to analyze
 * @property {RegExp[]} [excludeRegExp=[/node_modules/, /\.husky/]] - Patterns to exclude from analysis
 * @property {string[]} [fileExtensions=['js']] - File extensions to analyze
 * @property {(string|RegExp)[]} [ignoreChanges=[]] - Files or patterns to ignore from change detection (e.g., auto-generated files)
 */

/**
 * Smart test runner that analyzes dependencies to run only relevant tests
 *
 * Test files can use JSDoc annotations to control behavior:
 * - @testCovers path/to/file.js - Explicitly declare dependencies
 * - @testCovers * - Mark as critical test that always runs
 */
class SmartTestRunner {
  /**
   * @param {SmartTestRunnerOptions} [options]
   */
  constructor(options = {}) {
    this.options = {
      baseDirs: options.baseDirs || ['app/src', 'fastapi_app'],
      excludeRegExp: options.excludeRegExp || [/node_modules/, /\.husky/],
      fileExtensions: options.fileExtensions || ['js'],
      ignoreChanges: options.ignoreChanges || ['app/src/modules/api-client-v1.js']
    };
    /** @type {Map<string, Set<string>> | null} */
    this.reverseDepsCache = null;
  }

  /**
   * Build a reverse dependency graph showing what files depend on each file
   * @returns {Promise<Map<string, Set<string>>>} Map from file to set of files that import it
   */
  async buildReverseDependencyGraph() {
    if (this.reverseDepsCache) {
      return this.reverseDepsCache;
    }

    debugLog('Building reverse dependency graph for:', this.options.baseDirs);
    /** @type {Map<string, Set<string>>} */
    const reverseDeps = new Map();

    // Build graph for JavaScript files
    if (this.options.baseDirs.includes('app/src')) {
      const result = await madge('app/src', {
        baseDir: projectRoot,
        fileExtensions: this.options.fileExtensions,
        excludeRegExp: this.options.excludeRegExp
      });

      const tree = result.obj();

      for (const [file, deps] of Object.entries(tree)) {
        // Normalize file path to full format
        const normalizedFile = file.startsWith('app/src/') ? file : `app/src/${file}`;

        for (const dep of deps) {
          // Normalize dep path to full format
          const normalizedDep = dep.startsWith('app/src/') ? dep : `app/src/${dep}`;

          if (!reverseDeps.has(normalizedDep)) {
            reverseDeps.set(normalizedDep, new Set());
          }
          reverseDeps.get(normalizedDep).add(normalizedFile);
        }
      }
    }

    // TODO: Add Python dependency analysis if needed in the future

    this.reverseDepsCache = reverseDeps;
    debugLog(`Built reverse dependency graph with ${reverseDeps.size} entries`);
    return reverseDeps;
  }

  /**
   * Get all files transitively affected by a change to the given file
   * @param {string} changedFile - The file that changed
   * @param {Map<string, Set<string>>} reverseDeps - The reverse dependency graph
   * @returns {Set<string>} All files affected by the change
   */
  getTransitivelyAffectedFiles(changedFile, reverseDeps) {
    const affected = new Set([changedFile]);
    const queue = [changedFile];

    while (queue.length > 0) {
      const current = queue.shift();
      const importers = reverseDeps.get(current) || new Set();

      for (const importer of importers) {
        if (!affected.has(importer)) {
          affected.add(importer);
          queue.push(importer);
        }
      }
    }

    return affected;
  }

  async discoverTestFiles() {
    const testsDir = join(projectRoot, 'tests');
    if (!existsSync(testsDir)) return { js: [], py: [], api: [], e2e: [] };

    const { glob } = await import('glob');

    // Helper to normalize paths for glob (use forward slashes even on Windows)
    const normalizeGlobPattern = (path) => path.replace(/\\/g, '/');

    // Helper to convert absolute paths to relative and normalize to forward slashes
    const makeRelative = (file) => relative(projectRoot, file).replace(/\\/g, '/');

    // Discover JS unit tests in tests/unit/ (recursively)
    const unitDir = join(testsDir, 'unit');
    const jsTests = [];
    if (existsSync(unitDir)) {
      const jsPattern = normalizeGlobPattern(join(unitDir, '**/*.test.js'));
      const jsFiles = await glob(jsPattern);
      jsTests.push(...jsFiles.map(makeRelative));
    }

    // Discover Python unit tests in tests/unit/ (recursively)
    const pyTests = [];
    if (existsSync(unitDir)) {
      const pyPattern = normalizeGlobPattern(join(unitDir, '**/test_*.py'));
      const pyFiles = await glob(pyPattern);
      pyTests.push(...pyFiles.map(makeRelative));
    }

    // Discover API tests in tests/api/ (backend API integration tests)
    const apiTests = [];
    const apiDir = join(testsDir, 'api');
    if (existsSync(apiDir)) {
      const apiPattern = normalizeGlobPattern(join(apiDir, '**/*.test.js'));
      const apiFiles = await glob(apiPattern);
      apiTests.push(...apiFiles.map(makeRelative));
    }

    // Discover E2E tests in tests/e2e/ (Playwright frontend E2E tests)
    const e2eTests = [];
    const e2eDir = join(testsDir, 'e2e');
    if (existsSync(e2eDir)) {
      const e2ePattern = normalizeGlobPattern(join(e2eDir, '**/*.spec.js'));
      const e2eFiles = await glob(e2ePattern);
      e2eTests.push(...e2eFiles.map(makeRelative));
    }

    if (!process.argv.includes('--tap')) {
      logger.info(`Discovered ${jsTests.length} JS unit tests, ${pyTests.length} Python unit tests, ${apiTests.length} API tests, ${e2eTests.length} E2E tests`);
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

            // Parse @env annotations (VAR_NAME, VAR=VALUE, or .env file paths)
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

          // Parse @env annotations (VAR_NAME, VAR=VALUE, or .env file paths)
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
    if (!process.argv.includes('--tap')) logger.info('Analyzing JavaScript dependencies...');
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
    if (!process.argv.includes('--tap')) logger.info('Analyzing Python dependencies...');
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
   * Categorize @env annotations into environment variables and .env files
   * @param {Set<string>} envVars - Set of env annotations
   * @returns {{vars: string[], files: string[]}} Categorized env vars and files
   */
  categorizeEnvVars(envVars) {
    const vars = [];
    const files = [];

    for (const envSpec of envVars) {
      // Check if it's a .env file path
      if (envSpec.startsWith('.env')) {
        files.push(envSpec);
      } else {
        vars.push(envSpec);
      }
    }

    return { vars, files };
  }

  /**
   * Check if a file should be ignored from change detection
   * @param {string} filePath - File path to check
   * @returns {boolean} True if file should be ignored
   */
  shouldIgnoreChange(filePath) {
    for (const pattern of this.options.ignoreChanges) {
      if (pattern instanceof RegExp) {
        if (pattern.test(filePath)) {
          debugLog(`Ignoring change to ${filePath} (matches pattern ${pattern})`);
          return true;
        }
      } else if (typeof pattern === 'string') {
        if (filePath === pattern) {
          debugLog(`Ignoring change to ${filePath} (exact match)`);
          return true;
        }
      }
    }
    return false;
  }

  /**
   * @param {string[] | null} customFiles
   * @returns {string[]}
   */
  getChangedFiles(customFiles = null) {
    if (customFiles) {
      debugLog('Using custom changed files:', customFiles);
      return customFiles.filter(f => !this.shouldIgnoreChange(f));
    }

    try {
      // Get staged files
      const staged = execSync('git diff --cached --name-only', { encoding: 'utf8' });
      // Get modified files
      const modified = execSync('git diff --name-only', { encoding: 'utf8' });

      const allChanged = [...new Set([
        ...staged.split('\n').filter(f => f.trim()),
        ...modified.split('\n').filter(f => f.trim())
      ])].filter(f => !this.shouldIgnoreChange(f));

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
   * @param {Map<string, Set<string>>} reverseDeps
   */
  shouldRunTest(testFile, changedFiles, analysisResult, reverseDeps) {
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
      // Build set of all files affected by this change (transitive)
      const affectedFiles = this.getTransitivelyAffectedFiles(changedFile, reverseDeps);

      return testDeps.some((/** @type {string} */ dep) => {
        let match = false;

        // Support directory matches (ending with /)
        if (dep.endsWith('/')) {
          // Check if any affected file starts with this directory
          match = changedFile.startsWith(dep) || Array.from(affectedFiles).some(f => f.startsWith(dep));
        }
        // Support partial matches (ending with -)
        else if (dep.endsWith('-')) {
          match = changedFile.startsWith(dep) || Array.from(affectedFiles).some(f => f.startsWith(dep));
        }
        // Support wildcard matches (containing *)
        else if (dep.includes('*')) {
          const pattern = dep.replace(/\*/g, '.*');
          const regex = new RegExp(`^${pattern}`);
          match = regex.test(changedFile) || Array.from(affectedFiles).some(f => regex.test(f));
        }
        // Exact file match - check both changed file and all affected files
        else {
          match = changedFile === dep ||
                  changedFile.startsWith(dep.replace(/\.js$/, '')) ||
                  affectedFiles.has(dep) ||
                  Array.from(affectedFiles).some(f => f.startsWith(dep.replace(/\.js$/, '')));
        }

        if (match) {
          debugLog(`Match found for ${testFile}: changed file '${changedFile}' (or its dependents) matches dependency '${dep}'`);
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
    if (!options.tap) logger.info('Changed files:', changedFiles.length > 0 ? changedFiles.join(', ') : 'none');

    const analysisResult = await this.analyzeDependencies(options);
    debugLog('Analysis result:', JSON.stringify(analysisResult, null, 2));

    // Build reverse dependency graph for transitive matching
    const reverseDeps = await this.buildReverseDependencyGraph();

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
      this.shouldRunTest(test, changedFiles, analysisResult, reverseDeps)
    );

    const pyTests = testFiles.py.filter(test =>
      this.shouldRunTest(test, changedFiles, analysisResult, reverseDeps)
    );

    const apiTests = testFiles.api.filter(test =>
      this.shouldRunTest(test, changedFiles, analysisResult, reverseDeps)
    );

    const e2eTests = testFiles.e2e.filter(test =>
      this.shouldRunTest(test, changedFiles, analysisResult, reverseDeps)
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
      const { vars: apiVars, files: apiFiles } = this.categorizeEnvVars(apiEnvVars);

      // Check for conflicting .env files
      if (apiFiles.length > 1) {
        throw new Error(
          `API test suite has conflicting .env files specified:\n${apiFiles.map(f => `  - ${f}`).join('\n')}\n` +
          `Please ensure all API tests use the same .env file or use --env variables instead.`
        );
      }

      const envArgsStr = apiVars.map(v => `--env "${v}"`).join(' ');
      const envFileArg = apiFiles.length > 0 ? `--env-file "${apiFiles[0]}"` : '';
      const extraArgs = [envArgsStr, envFileArg].filter(Boolean).join(' ');
      // Route API tests to backend-test-runner (.env auto-detected from test directory)
      apiCommand = `node tests/backend-test-runner.js ${extraArgs} ${testFiles}`.trim();
    }

    // Build E2E command (Playwright frontend tests)
    let e2eCommand = null;
    if (testsToRun.e2e && testsToRun.e2e.length > 0) {
      const testFiles = testsToRun.e2e.map(f => f.replace('tests/e2e/', '').replace('.spec.js', '')).join('|');
      const grepArg = `--grep "${testFiles}"`;
      const { vars: e2eVars, files: e2eFiles } = this.categorizeEnvVars(e2eEnvVars);

      // Check for conflicting .env files
      if (e2eFiles.length > 1) {
        throw new Error(
          `E2E test suite has conflicting .env files specified:\n${e2eFiles.map(f => `  - ${f}`).join('\n')}\n` +
          `Please ensure all E2E tests use the same .env file or use --env variables instead.`
        );
      }

      const envArgsStr = e2eVars.map(v => `--env "${v}"`).join(' ');
      const envFileArg = e2eFiles.length > 0 ? `--env-file "${e2eFiles[0]}"` : '';
      const extraArgs = [grepArg, envArgsStr, envFileArg].filter(Boolean).join(' ');
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
        logger.info('Dry run - showing tests that would run:');
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
      if (!isTap) logger.success('No relevant tests to run');
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
        .arguments('[files...]')
        .usage('[options] [files...]')
        .addHelpText('after', `
Arguments:
  files...    List of files for which tests should be run

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
