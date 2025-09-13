#!/usr/bin/env node
import { execSync } from 'child_process';
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import madge from 'madge';
import { parse as parseComments } from 'comment-parser';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = dirname(__dirname);
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
      console.warn('Could not save dependency cache:', error.message);
    }
  }

  discoverTestFiles() {
    const testsDir = join(projectRoot, 'tests');
    if (!existsSync(testsDir)) return { js: [], py: [] };

    const files = readdirSync(testsDir);
    
    const jsTests = files
      .filter(file => file.endsWith('.test.js'))
      .map(file => `tests/${file}`);
    
    const pyTests = files
      .filter(file => file.startsWith('test_') && file.endsWith('.py'))
      .map(file => `tests/${file}`);

    console.log(`📋 Discovered ${jsTests.length} JS tests, ${pyTests.length} Python tests`);
    return { js: jsTests, py: pyTests };
  }

  parseTestCoversAnnotations(filePath) {
    try {
      const content = readFileSync(filePath, 'utf8');
      
      // For JS files, parse JSDoc comments
      if (filePath.endsWith('.js')) {
        const comments = parseComments(content);
        const coversTags = [];
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
            }
          }
        }

        return { dependencies: coversTags, alwaysRun: isAlwaysRun };
      }
      
      // For Python files, parse docstring comments
      if (filePath.endsWith('.py')) {
        const coversTags = [];
        let isAlwaysRun = false;
        
        const docstringRegex = /"""[\s\S]*?@testCovers\s+([^\s\n]+)[\s\S]*?"""/g;
        let match;
        while ((match = docstringRegex.exec(content)) !== null) {
          const target = match[1];
          if (target === '*') {
            isAlwaysRun = true;
          } else {
            coversTags.push(target);
          }
        }

        return { dependencies: coversTags, alwaysRun: isAlwaysRun };
      }

      return { dependencies: [], alwaysRun: false };
    } catch (error) {
      return { dependencies: [], alwaysRun: false };
    }
  }

  async analyzeJSDependencies(testFiles) {
    console.log('🔍 Analyzing JavaScript dependencies...');
    const jsDeps = {};
    const alwaysRunTests = [];

    for (const testFile of testFiles) {
      const fullPath = join(projectRoot, testFile);
      if (!existsSync(fullPath)) continue;

      try {
        // Parse @testCovers annotations
        const { dependencies: explicitDeps, alwaysRun } = this.parseTestCoversAnnotations(fullPath);
        
        if (alwaysRun) {
          alwaysRunTests.push(testFile);
        }
        
        // Use madge to analyze imports
        const result = await madge(fullPath, {
          fileExtensions: ['js'],
          excludeRegExp: [/node_modules/, /\.husky/]
        });
        
        const dependencies = result.depends(fullPath);
        const filteredDeps = dependencies
          .filter(dep => dep.startsWith('app/') || dep.startsWith('server/'))
          .map(dep => dep.replace(/^\.\//, ''));

        // Combine explicit and discovered dependencies
        jsDeps[testFile] = {
          dependencies: [...new Set([...explicitDeps, ...filteredDeps])],
          alwaysRun
        };
        
        const depCount = jsDeps[testFile].dependencies.length;
        const alwaysRunFlag = alwaysRun ? ' (always run)' : '';
        console.log(`  ${testFile}: ${depCount} dependencies${alwaysRunFlag}`);
      } catch (error) {
        console.warn(`  Could not analyze ${testFile}:`, error.message);
        jsDeps[testFile] = { dependencies: [], alwaysRun: false };
      }
    }

    return { dependencies: jsDeps, alwaysRunTests };
  }

  async analyzePyDependencies(testFiles) {
    console.log('🔍 Analyzing Python dependencies...');
    const pyDeps = {};
    const alwaysRunTests = [];

    for (const testFile of testFiles) {
      const fullPath = join(projectRoot, testFile);
      if (!existsSync(fullPath)) continue;

      try {
        const content = readFileSync(fullPath, 'utf8');
        const dependencies = [];

        // Parse @testCovers annotations
        const { dependencies: explicitDeps, alwaysRun } = this.parseTestCoversAnnotations(fullPath);
        
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
          alwaysRun
        };
        
        const depCount = pyDeps[testFile].dependencies.length;
        const alwaysRunFlag = alwaysRun ? ' (always run)' : '';
        console.log(`  ${testFile}: ${depCount} dependencies${alwaysRunFlag}`);
      } catch (error) {
        console.warn(`  Could not analyze ${testFile}:`, error.message);
        pyDeps[testFile] = { dependencies: [], alwaysRun: false };
      }
    }

    return { dependencies: pyDeps, alwaysRunTests };
  }

  async analyzeDependencies() {
    const needsReanalysis = Date.now() - this.cache.lastAnalysis > 24 * 60 * 60 * 1000; // 24 hours
    
    if (!needsReanalysis && this.cache.dependencies && Object.keys(this.cache.dependencies).length > 0) {
      console.log('📋 Using cached dependency analysis');
      return this.cache;
    }

    console.log('🔬 Running dependency analysis...');
    
    const testFiles = this.discoverTestFiles();
    const [jsResult, pyResult] = await Promise.all([
      this.analyzeJSDependencies(testFiles.js),
      this.analyzePyDependencies(testFiles.py)
    ]);

    const allDeps = { ...jsResult.dependencies, ...pyResult.dependencies };
    const allAlwaysRun = [...jsResult.alwaysRunTests, ...pyResult.alwaysRunTests];
    
    const result = {
      dependencies: allDeps,
      alwaysRunTests: allAlwaysRun,
      lastAnalysis: Date.now()
    };
    
    this.cache = result;
    this.saveCache();

    return result;
  }

  getChangedFiles() {
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

  shouldRunTest(testFile, changedFiles, analysisResult) {
    const testData = analysisResult.dependencies[testFile];
    if (!testData) return false;

    // Always run if marked with @testCovers *
    if (testData.alwaysRun) {
      return true;
    }

    const testDeps = testData.dependencies || [];
    
    return changedFiles.some(changedFile => {
      return testDeps.some(dep => {
        // Support directory matches (ending with /)
        if (dep.endsWith('/')) {
          return changedFile.startsWith(dep);
        }
        // Support partial matches (ending with -)  
        if (dep.endsWith('-')) {
          return changedFile.startsWith(dep);
        }
        // Exact file match
        return changedFile === dep || changedFile.startsWith(dep.replace(/\.js$/, ''));
      });
    });
  }

  async getTestsToRun() {
    const changedFiles = this.getChangedFiles();
    console.log('📁 Changed files:', changedFiles.length > 0 ? changedFiles : 'none');

    const testFiles = this.discoverTestFiles();
    const analysisResult = await this.analyzeDependencies();

    if (changedFiles.length === 0) {
      // No changes, run only always-run tests
      const alwaysRunJs = testFiles.js.filter(test => 
        analysisResult.alwaysRunTests.includes(test)
      );
      const alwaysRunPy = testFiles.py.filter(test => 
        analysisResult.alwaysRunTests.includes(test)
      );
      return { js: alwaysRunJs, py: alwaysRunPy };
    }

    const jsTests = testFiles.js.filter(test => 
      this.shouldRunTest(test, changedFiles, analysisResult)
    );
    
    const pyTests = testFiles.py.filter(test => 
      this.shouldRunTest(test, changedFiles, analysisResult)
    );

    return { js: jsTests, py: pyTests };
  }

  async run() {
    console.log('🧠 Smart Test Runner - Analyzing dependencies and changes...');
    
    const testsToRun = await this.getTestsToRun();
    const totalTests = testsToRun.js.length + testsToRun.py.length;
    
    if (totalTests === 0) {
      console.log('✅ No relevant tests to run');
      return;
    }

    console.log(`🧪 Running ${totalTests} relevant test(s):`);
    
    if (testsToRun.js.length > 0) {
      console.log('  JavaScript tests:');
      testsToRun.js.forEach(test => console.log(`    - ${test}`));
    }
    
    if (testsToRun.py.length > 0) {
      console.log('  Python tests:');
      testsToRun.py.forEach(test => console.log(`    - ${test}`));
    }

    try {
      // Run JavaScript tests
      if (testsToRun.js.length > 0) {
        console.log('\n🟨 Running JavaScript tests...');
        execSync(`node --test ${testsToRun.js.join(' ')}`, { 
          stdio: 'inherit',
          cwd: projectRoot 
        });
      }

      // Run Python tests  
      if (testsToRun.py.length > 0) {
        console.log('\n🐍 Running Python tests...');
        for (const test of testsToRun.py) {
          execSync(`uv run python -m pytest ${test} -v`, { 
            stdio: 'inherit',
            cwd: projectRoot 
          });
        }
      }

      console.log('\n✅ All tests passed');
    } catch (error) {
      console.error('\n❌ Tests failed');
      process.exit(1);
    }
  }
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  const runner = new SmartTestRunner();
  runner.run().catch(error => {
    console.error('Smart test runner failed:', error);
    process.exit(1);
  });
}

export default SmartTestRunner;