# Phase 9b: Test Runner Refinement and CLI Harmonization

## Status: ⬜ Not Started

## Overview

Refine the test infrastructure to support dynamic fixture selection, improve environment variable handling, and harmonize the CLI interfaces between API and E2E test runners. This phase addresses inconsistencies identified after the initial Phase 9 implementation.

## Goals

1. **Dynamic Fixture Selection**: Support multiple fixture presets selectable via `--fixture <name>` flag
2. **Improved dotenv Handling**: Automatic detection of `.env` files in test directories rather than test-by-test specification
3. **CLI Harmonization**: Consistent argument parsing and shared code between API and E2E runners using Commander.js
4. **Better Maintainability**: Extract common functionality into reusable library modules with automatic help generation

## Key Issues Identified

### 1. Static vs Dynamic Fixtures

**Current State**:

- Fixtures are in a single directory: `tests/api/fixtures/` and `tests/e2e/fixtures/`
- No mechanism to select different fixture sets for different test scenarios
- Planning document intended fixtures to be subdirectories (minimal, standard, complex)

**Target State**:

```
tests/api/fixtures/
  ├── minimal/         # Bare minimum config for smoke tests
  │   ├── config/      # users.json, config.json, prompt.json
  │   └── files/       # minimal test files
  ├── standard/        # Typical test scenario (default)
  │   ├── config/
  │   └── files/
  └── complex/         # Advanced scenarios (permissions, workflows)
      ├── config/
      └── files/

tests/e2e/fixtures/
  ├── minimal/
  ├── standard/
  └── complex/
```

**Benefits**:

- Different test suites can use appropriate fixture complexity
- Faster smoke tests with minimal fixtures
- Comprehensive E2E tests with complex fixtures
- Easy to add new fixture presets for specific scenarios

### 2. Environment Variable Handling Issues

**Current State**:

- Smart runner allows `@env path/to/.env` in individual tests
- Tests in the same suite (API or E2E) could theoretically specify different `.env` files
- This creates conflicts since the server loads environment once at startup

**Problems**:

- `.env` files apply to entire server, not individual tests
- Specifying `.env` per-test is misleading and error-prone
- Smart runner has validation to catch conflicts, but should prevent them instead

**Target State**:

- Remove `.env` file support from `@env` annotations in tests
- Keep `@env VAR_NAME` and `@env VAR=VALUE` support for individual variables
- Test runners auto-detect `.env` file in test directory:
  - If `--env-file <path>` provided: use that file
  - Else if `--test-dir <dir>` provided: look for `<dir>/.env`
  - Else look for `.env` in default test discovery path
- Rename `tests/api/.env.test` to `tests/api/v1/.env` (matches test directory structure)
- Create `tests/e2e/.env` for E2E tests

**Benefits**:

- Clearer contract: one `.env` file per test suite execution
- No need to specify `.env` path in npm scripts
- Consistent environment across all tests in a run
- Individual variables can still be overridden via `@env` or `--env` flag

### 3. CLI Inconsistencies and Manual Help Text

**Current State**:

- `backend-test-runner.js` and `e2e-runner.js` have similar but not identical CLIs
- Both parse arguments manually with custom logic
- Help text duplicated with manual `console.log()` statements
- Help text can drift out of sync with actual argument handling
- Common functionality (env loading, arg parsing) duplicated

**Problems**:

- Hard to maintain consistency as features evolve
- Users must learn slightly different interfaces
- Help text maintenance burden (manual updates)
- Code duplication increases maintenance burden
- No automatic validation of argument types

**Target State**:

- Use **Commander.js** for structured argument parsing with automatic help generation
- Extract common CLI setup to `tests/lib/cli-builder.js`
- Standardize common flags across both runners:
  - `--local` / `--container` - execution mode
  - `--fixture <name>` - select fixture preset
  - `--env-file <path>` - explicit env file (optional)
  - `--env <VAR[=VALUE]>` - pass environment variables (multiple allowed)
  - `--grep <pattern>` - filter tests
  - `--grep-invert <pattern>` - exclude tests
  - `--keep-db` / `--clean-db` - database handling
  - `--no-cleanup` - keep server running
  - `--verbose` / `-v` - show server output
  - `--help` / `-h` - show help (automatic)
- Runner-specific flags remain separate (e.g., `--headed`, `--browser` for E2E only)

**Why Commander.js**:

- Industry standard (44M weekly downloads)
- Automatic help text generation from option definitions
- Built-in type validation and default values
- Subcommand support for future extensibility
- Fluent API makes CLI definitions readable
- Active maintenance and excellent documentation

**Benefits**:

- Consistent user experience
- Automatic, always-up-to-date help text
- Type safety for arguments
- Reduced code duplication
- Better error messages for invalid arguments

## Implementation Steps

### Step 1: Install Commander.js and Create Shared CLI Utilities

**Objective**: Install Commander.js and create reusable CLI configuration utilities.

**Tasks**:

1. **Install Commander.js**:

   ```bash
   npm install commander
   ```

2. **Create `tests/lib/cli-builder.js`**:

   ```javascript
   import { Command, Option } from 'commander';

   /**
    * Create a test runner command with common options
    * @param {Object} config - Command configuration
    * @param {string} config.name - Command name
    * @param {string} config.description - Command description
    * @param {Option[]} [config.extraOptions] - Additional runner-specific options
    * @returns {Command} Configured Commander program
    */
   export function createTestRunnerCommand(config) {
     const { name, description, extraOptions = [] } = config;

     const program = new Command();

     program
       .name(name)
       .description(description)
       .version('1.0.0');

     // Execution mode
     program
       .option('--local', 'Use local server (default, fast iteration)', true)
       .option('--container', 'Use containerized server (CI-ready)');

     // Fixture selection
     program
       .option(
         '-f, --fixture <name>',
         'Fixture preset to load (minimal|standard|complex)',
         'standard'
       );

     // Environment
     program
       .option(
         '--env-file <path>',
         'Load environment from .env file (auto-detected if not specified)'
       )
       .option(
         '--env <VAR[=VALUE]>',
         'Set environment variable (can be repeated)',
         collectEnvVars,
         []
       );

     // Test filtering
     program
       .option('-g, --grep <pattern>', 'Only run tests matching pattern')
       .option('--grep-invert <pattern>', 'Exclude tests matching pattern');

     // Test directory
     program
       .option('--test-dir <path>', 'Test directory (auto-detected if not specified)');

     // Server options
     program
       .option('--clean-db', 'Wipe database before tests (default, local only)', true)
       .option('--keep-db', 'Keep existing database (faster, local only)')
       .option('--no-cleanup', 'Keep server running after tests (debug mode)')
       .option('--no-rebuild', 'Skip image rebuild (container only)');

     // Output options
     program
       .option('-v, --verbose', 'Show server output during tests')
       .option('--timeout <seconds>', 'Test timeout in seconds', '60');

     // Add runner-specific options
     for (const option of extraOptions) {
       program.addOption(option);
     }

     return program;
   }

   /**
    * Collector function for --env option (allows multiple values)
    * @param {string} value - Current env argument
    * @param {string[]} previous - Previously collected values
    * @returns {string[]} Updated array
    */
   function collectEnvVars(value, previous) {
     return previous.concat([value]);
   }

   /**
    * Process environment variable arguments into key-value pairs
    * @param {string[]} envArgs - Array of env arguments from --env
    * @returns {Object} Environment variable key-value pairs
    */
   export function processEnvArgs(envArgs) {
     const env = {};
     for (const arg of envArgs) {
       if (arg.includes('=')) {
         const [key, ...valueParts] = arg.split('=');
         env[key] = valueParts.join('=');
       } else {
         // Pass through from process.env
         if (process.env[arg]) {
           env[arg] = process.env[arg];
         }
       }
     }
     return env;
   }

   /**
    * Resolve execution mode from options
    * @param {Object} options - Parsed CLI options
    * @returns {string} 'local' or 'container'
    */
   export function resolveMode(options) {
     // --container flag explicitly sets container mode
     if (options.container) return 'container';

     // CI environment auto-selects container mode
     if (process.env.CI === 'true') return 'container';

     // Default to local
     return 'local';
   }

   /**
    * Validate fixture name
    * @param {string} fixtureName - Fixture name to validate
    * @param {string} fixturesDir - Fixtures directory
    * @throws {Error} If fixture doesn't exist
    */
   export function validateFixture(fixtureName, fixturesDir) {
     const { existsSync, readdirSync, statSync } = await import('fs');
     const { join } = await import('path');

     if (!existsSync(fixturesDir)) {
       throw new Error(`Fixtures directory not found: ${fixturesDir}`);
     }

     const available = readdirSync(fixturesDir)
       .filter(name => statSync(join(fixturesDir, name)).isDirectory())
       .filter(name => !name.startsWith('.'));

     if (!available.includes(fixtureName)) {
       throw new Error(
         `Fixture '${fixtureName}' not found.\n` +
         `Available fixtures: ${available.join(', ')}`
       );
     }
   }
   ```

3. **Create `tests/lib/env-loader.js`**:

   ```javascript
   import { existsSync } from 'fs';
   import { resolve, join } from 'path';
   import dotenv from 'dotenv';

   /**
    * Load environment variables from .env file
    * Handles explicit paths and automatic detection
    *
    * @param {Object} options
    * @param {string} [options.envFile] - Explicit .env file path
    * @param {string} [options.testDir] - Test directory to search
    * @param {string[]} [options.searchDirs] - Default directories to search
    * @param {string} options.projectRoot - Project root directory
    * @returns {Object} Environment variables
    */
   export function loadEnvFile(options) {
     const { envFile, testDir, searchDirs = [], projectRoot } = options;

     let envPath = null;

     // Priority 1: Explicit --env-file flag
     if (envFile) {
       envPath = resolve(projectRoot, envFile);
       if (!existsSync(envPath)) {
         throw new Error(`Environment file not found: ${envFile}`);
       }
     }

     // Priority 2: .env in --test-dir
     if (!envPath && testDir) {
       const testDirEnv = resolve(projectRoot, testDir, '.env');
       if (existsSync(testDirEnv)) {
         envPath = testDirEnv;
       }
     }

     // Priority 3: .env in default search directories
     if (!envPath) {
       for (const dir of searchDirs) {
         const searchPath = resolve(projectRoot, dir, '.env');
         if (existsSync(searchPath)) {
           envPath = searchPath;
           break;
         }
       }
     }

     if (!envPath) {
       return {}; // No .env file found, not an error
     }

     console.log(`📄 Loading environment from: ${envPath}`);

     const result = dotenv.config({ path: envPath });

     if (result.error) {
       throw new Error(`Failed to parse .env file: ${result.error.message}`);
     }

     return result.parsed || {};
   }
   ```

4. **Create `tests/lib/fixture-loader.js`**:

   ```javascript
   import { existsSync } from 'fs';
   import { resolve, join } from 'path';
   import { cp, rm, mkdir } from 'fs/promises';

   /**
    * Load fixture preset into runtime directory
    *
    * @param {Object} options
    * @param {string} options.fixtureName - Fixture preset name (minimal, standard, complex)
    * @param {string} options.fixturesDir - Base fixtures directory
    * @param {string} options.runtimeDir - Runtime directory
    * @param {string} options.projectRoot - Project root
    * @returns {Promise<void>}
    */
   export async function loadFixture(options) {
     const { fixtureName, fixturesDir, runtimeDir, projectRoot } = options;

     const fixturePath = resolve(projectRoot, fixturesDir, fixtureName);

     if (!existsSync(fixturePath)) {
       throw new Error(
         `Fixture '${fixtureName}' not found at ${fixturePath}\n` +
         `Available fixtures: ${getAvailableFixtures(resolve(projectRoot, fixturesDir)).join(', ')}`
       );
     }

     const runtimePath = resolve(projectRoot, runtimeDir);

     console.log(`📦 Loading fixture: ${fixtureName}`);
     console.log(`   From: ${fixturePath}`);
     console.log(`   To: ${runtimePath}`);

     // Clean runtime directory
     if (existsSync(runtimePath)) {
       await rm(runtimePath, { recursive: true, force: true });
     }

     // Create runtime structure
     await mkdir(join(runtimePath, 'db'), { recursive: true });
     await mkdir(join(runtimePath, 'files'), { recursive: true });
     await mkdir(join(runtimePath, 'logs'), { recursive: true });

     // Copy fixture config to runtime/db
     const fixtureConfig = join(fixturePath, 'config');
     if (existsSync(fixtureConfig)) {
       await cp(fixtureConfig, join(runtimePath, 'db'), { recursive: true });
     }

     // Copy fixture files to runtime/files
     const fixtureFiles = join(fixturePath, 'files');
     if (existsSync(fixtureFiles)) {
       await cp(fixtureFiles, join(runtimePath, 'files'), { recursive: true });
     }

     console.log(`✅ Fixture loaded successfully`);
   }

   /**
    * Get list of available fixture presets
    * @param {string} fixturesDir - Fixtures directory
    * @returns {string[]} Array of fixture names
    */
   export function getAvailableFixtures(fixturesDir) {
     if (!existsSync(fixturesDir)) return [];

     const { readdirSync, statSync } = require('fs');
     return readdirSync(fixturesDir)
       .filter(name => statSync(join(fixturesDir, name)).isDirectory())
       .filter(name => !name.startsWith('.'));
   }
   ```

**Validation**:

- ✅ Commander.js installed successfully
- ✅ `cli-builder.js` exports correct interfaces
- ✅ `--help` flag generates automatic help text
- ✅ Type validation works for arguments
- ✅ Unit tests for env loading logic
- ✅ Unit tests for fixture loading logic

---

### Step 2: Reorganize Fixture Directory Structure

**Objective**: Convert flat fixture directories to preset-based structure.

**Tasks**:

1. **Reorganize API fixtures**:

   ```bash
   cd tests/api/fixtures

   # Create preset directories
   mkdir minimal standard complex

   # Move current fixtures to 'standard' (most complete)
   mv config standard/
   mv files standard/

   # Create minimal preset (bare minimum)
   mkdir -p minimal/config minimal/files
   cp standard/config/users.json minimal/config/
   cp standard/config/config.json minimal/config/
   cp standard/config/prompt.json minimal/config/
   # Copy 1-2 minimal test files

   # Create complex preset (copy standard + add more)
   cp -r standard complex/
   # Add additional complex test files, multi-user scenarios, etc.
   ```

2. **Reorganize E2E fixtures**:

   ```bash
   cd tests/e2e/fixtures

   # Same structure as API fixtures
   mkdir minimal standard complex

   # Move current fixtures to appropriate preset
   # (analyze what's currently in tests/e2e/fixtures/)
   ```

3. **Create fixture README files**:

   ```bash
   # Document each preset's purpose and contents
   cat > tests/api/fixtures/README.md << 'EOF'
   # API Test Fixtures

   Test fixtures are organized into presets of varying complexity:

   ## Presets

   ### minimal
   - Bare minimum configuration for smoke tests
   - Single test user
   - Minimal test files
   - Fast loading (~100ms)

   ### standard (default)
   - Typical test scenario
   - Multiple users with different roles
   - Representative test files
   - Comprehensive coverage

   ### complex
   - Advanced scenarios
   - Complex permissions
   - Large file sets
   - Edge cases
   EOF

   # Similar for E2E fixtures
   ```

**Validation**:

- ✅ All three presets exist for both API and E2E
- ✅ Each preset has `config/` and `files/` subdirectories
- ✅ Minimal preset is truly minimal (fast loading)
- ✅ Standard preset covers typical test scenarios
- ✅ Complex preset includes edge cases
- ✅ README files document each preset

---

### Step 3: Update Backend Test Runner

**Objective**: Refactor backend-test-runner.js to use Commander.js and shared utilities.

**Tasks**:

1. **Update imports and CLI setup**:

   ```javascript
   import { createTestRunnerCommand, processEnvArgs, resolveMode } from './lib/cli-builder.js';
   import { loadEnvFile } from './lib/env-loader.js';
   import { loadFixture } from './lib/fixture-loader.js';

   // Create command with Commander.js
   const program = createTestRunnerCommand({
     name: 'backend-test-runner',
     description: 'Run backend API integration tests with local or containerized server',
   });

   // Parse arguments - Commander handles --help automatically
   program.parse(process.argv);
   const options = program.opts();
   ```

2. **Update main() function to use parsed options**:

   ```javascript
   async function main() {
     // Resolve mode (handles --container flag and CI env)
     const mode = resolveMode(options);

     console.log('🧪 Backend Test Runner');
     console.log(`📦 Mode: ${mode}`);

     // Auto-detect test directory
     const testDir = options.testDir || 'tests/api/v1';
     const fixturesDir = 'tests/api/fixtures';
     const runtimeDir = 'tests/api/runtime';

     // Validate fixture
     validateFixture(options.fixture, resolve(projectRoot, fixturesDir));

     // Load fixture (local mode only)
     if (mode === 'local') {
       await loadFixture({
         fixtureName: options.fixture,
         fixturesDir,
         runtimeDir,
         projectRoot,
       });
     }

     // Load environment
     const envFromFile = loadEnvFile({
       envFile: options.envFile,
       testDir,
       searchDirs: [testDir, 'tests/api/v1', 'tests/api/v0'],
       projectRoot,
     });

     // Process --env arguments
     const envFromArgs = processEnvArgs(options.env);

     // Merge (--env args take precedence)
     const env = { ...envFromFile, ...envFromArgs };

     // Convert Commander options to internal format
     const runOptions = {
       mode,
       grep: options.grep,
       grepInvert: options.grepInvert,
       cleanDb: options.keepDb ? false : options.cleanDb,
       noCleanup: options.noCleanup,
       verbose: options.verbose,
       noRebuild: options.rebuild === false,
       testDir,
       env,
       timeout: parseInt(options.timeout, 10) * 1000,
     };

     // Continue with existing server start logic...
     // (rest of function remains similar)
   }
   ```

3. **Remove manual printHelp() function**:
   - Delete the `printHelp()` function entirely
   - Commander.js generates help automatically from option definitions
   - Running `--help` shows all options with descriptions

**Validation**:

- ✅ `node tests/backend-test-runner.js --help` shows comprehensive help
- ✅ `--fixture minimal` loads minimal preset
- ✅ `--fixture standard` loads standard preset (default)
- ✅ `.env` auto-detected from test directory
- ✅ `--env-file <path>` overrides auto-detection
- ✅ `--env VAR=VALUE` works
- ✅ All existing tests pass
- ✅ Backward compatibility maintained

---

### Step 4: Update E2E Test Runner

**Objective**: Apply same Commander.js refactoring to e2e-runner.js.

**Tasks**:

1. **Refactor to use Commander.js with E2E-specific options**:

   ```javascript
   import { Command, Option } from 'commander';
   import { createTestRunnerCommand, processEnvArgs, resolveMode } from './lib/cli-builder.js';
   import { loadEnvFile } from './lib/env-loader.js';
   import { loadFixture } from './lib/fixture-loader.js';

   // Create base command
   const program = createTestRunnerCommand({
     name: 'e2e-runner',
     description: 'Run Playwright E2E tests against local or containerized backend',
     extraOptions: [
       new Option('--browser <name>', 'Browser to use')
         .choices(['chromium', 'firefox', 'webkit'])
         .default('chromium'),
       new Option('--headed', 'Run tests in headed mode (show browser)'),
       new Option('--debugger', 'Enable Playwright debugger'),
       new Option('--debug-messages', 'Enable verbose E2E debug output'),
       new Option('--workers <number>', 'Number of parallel workers')
         .default('1'),
       new Option('--fail-fast', 'Abort on first test failure'),
     ],
   });

   program.parse(process.argv);
   const options = program.opts();
   ```

2. **Update PlaywrightRunner class**:

   ```javascript
   class PlaywrightRunner {
     async run(options) {
       const mode = resolveMode(options);

       console.log('🧪 Playwright E2E Test Runner');
       console.log(`📦 Mode: ${mode}`);

       // Check Playwright installation
       const hasPlaywright = await this.checkPlaywrightInstalled();
       if (!hasPlaywright) return 1;

       // Load fixture
       const fixturesDir = 'tests/e2e/fixtures';
       const runtimeDir = 'tests/e2e/runtime';

       if (mode === 'local') {
         await loadFixture({
           fixtureName: options.fixture,
           fixturesDir,
           runtimeDir,
           projectRoot,
         });
       }

       // Load environment
       const envFromFile = loadEnvFile({
         envFile: options.envFile,
         testDir: 'tests/e2e',
         searchDirs: ['tests/e2e'],
         projectRoot,
       });

       const envFromArgs = processEnvArgs(options.env);
       const env = { ...envFromFile, ...envFromArgs };

       // Start server
       await this.startServer({ mode, env, ...options });

       // Run tests
       await this.runPlaywrightTests(options);

       // Stop server
       await this.stopServer(options);

       return 0;
     }
   }

   // Main execution
   const runner = new PlaywrightRunner();
   const exitCode = await runner.run(options);
   process.exit(exitCode);
   ```

3. **Remove manual help text**:
   - Delete `showHelp()` method
   - Commander.js handles `--help` automatically

**Validation**:

- ✅ `node tests/e2e-runner.js --help` shows comprehensive help
- ✅ E2E runner supports `--fixture` flag
- ✅ Auto-detects `tests/e2e/.env`
- ✅ CLI interface consistent with backend runner
- ✅ E2E-specific flags work (--browser, --headed, etc.)
- ✅ All existing E2E tests pass

---

### Step 5: Update Smart Test Runner

**Objective**: Remove `.env` file support from `@env` annotations, keeping only variable support.

**Tasks**:

1. **Update `parseTestAnnotations()` method**:

   ```javascript
   parseTestAnnotations(testFilePath) {
     // ... existing code ...

     const envRegex = /@env\s+([^\n]+)/g;
     while ((match = envRegex.exec(content)) !== null) {
       const envSpec = match[1].trim();

       // Skip if it looks like a file path
       if (envSpec.startsWith('.') || envSpec.includes('/')) {
         console.warn(
           `⚠️  Warning: ${testFilePath}\n` +
           `   @env annotation contains file path: ${envSpec}\n` +
           `   File paths should not be specified in @env annotations.\n` +
           `   Place .env file in test directory instead (auto-detected).`
         );
         continue;
       }

       // Only support VAR_NAME or VAR=VALUE
       envVars.add(envSpec);
     }
   }
   ```

2. **Remove env file categorization**:

   ```javascript
   // Delete categorizeEnvVars() function - no longer needed
   // All @env values are now simple variables

   async runTests(testsToRun) {
     // API tests
     if (testsToRun.api.length > 0) {
       const testFiles = testsToRun.api.join(' ');
       const envArgs = Array.from(apiEnvVars).map(v => `--env "${v}"`).join(' ');
       apiCommand = `node tests/backend-test-runner.js ${envArgs} ${testFiles}`.trim();
     }

     // E2E tests
     if (testsToRun.e2e.length > 0) {
       const testFiles = testsToRun.e2e.join('|'); // grep pattern
       const envArgs = Array.from(e2eEnvVars).map(v => `--env "${v}"`).join(' ');
       e2eCommand = `node tests/e2e-runner.js --local --grep "${testFiles}" ${envArgs}`;
     }
   }
   ```

3. **Update help text**:

   ```javascript
   console.log('  • @env VAR_NAME or @env VAR=VALUE for environment variables');
   console.log('  • .env files are auto-detected in test directories');
   console.log('  • Do not use @env for .env file paths (will be ignored with warning)');
   ```

**Validation**:

- ✅ `@env VAR_NAME` still works
- ✅ `@env VAR=VALUE` still works
- ✅ `@env .env.testing` triggers warning and is ignored
- ✅ Test runners receive `--env` args correctly
- ✅ No more `--env-file` in generated commands

---

### Step 6: Rename and Create .env Files

**Objective**: Align `.env` file locations with test directory structure.

**Tasks**:

1. **Rename API .env files**:

   ```bash
   # Current: tests/api/.env.test
   # Target: tests/api/v1/.env (matches test directory)

   mv tests/api/.env.test tests/api/v1/.env

   # Create for v0 if needed
   # cp tests/api/v1/.env tests/api/v0/.env
   ```

2. **Create E2E .env file**:

   ```bash
   # Check if tests/e2e needs specific environment config
   # Create tests/e2e/.env if needed

   touch tests/e2e/.env
   # Add any E2E-specific environment variables
   ```

3. **Update .gitignore**:

   ```
   # Allow versioned .env files in test directories
   !tests/api/v0/.env
   !tests/api/v1/.env
   !tests/e2e/.env

   # But ignore runtime .env files
   tests/api/runtime/.env
   tests/e2e/runtime/.env
   ```

4. **Update npm scripts**:

   ```json
   {
     "test:api:v1": "node tests/backend-test-runner.js --test-dir tests/api/v1",
     "test:api:v0": "node tests/backend-test-runner.js --test-dir tests/api/v0",
     "test:backend": "npm run test:api:v1",
     "test:e2e": "node tests/e2e-runner.js"
   }
   ```

   Note: No more `--env-file` flags needed - auto-detected!

**Validation**:

- ✅ `tests/api/v1/.env` exists and is committed
- ✅ `tests/e2e/.env` exists and is committed
- ✅ npm scripts work without explicit `--env-file`
- ✅ Test runners auto-detect correct `.env` files
- ✅ Auto-detection logged to console

---

### Step 7: Update Phase 9 Completion Document

**Objective**: Document Phase 9b changes in completion report.

**Tasks**:

1. **Update [phase-9-completion.md](./phase-9-completion.md)**:
   - Add section for Phase 9b
   - Document Commander.js integration
   - Document fixture system enhancements
   - Document environment handling improvements
   - Document CLI harmonization
   - List created library modules
   - Include example outputs of `--help` from both runners

**Example section**:

```markdown
## Phase 9b: Test Runner Refinement (2025-10-17)

### Achievements

1. **Commander.js Integration**
   - Replaced manual argument parsing with industry-standard Commander.js
   - Automatic help text generation from option definitions
   - Type validation and default values
   - Consistent CLI interface across runners

2. **Dynamic Fixture Selection**
   - Three fixture presets: minimal, standard, complex
   - Selectable via `--fixture <name>` flag
   - Fast smoke tests with minimal preset
   - Comprehensive tests with complex preset

3. **Improved Environment Handling**
   - Auto-detection of .env files in test directories
   - Removed .env file support from @env annotations
   - Clear logging of loaded environment files
   - Priority: --env-file > --test-dir/.env > default search

4. **Shared Library Modules**
   - `tests/lib/cli-builder.js` - CLI configuration
   - `tests/lib/env-loader.js` - Environment loading
   - `tests/lib/fixture-loader.js` - Fixture management
```

**Validation**:

- ✅ Phase 9b section complete
- ✅ Changes clearly documented
- ✅ Benefits explained
- ✅ Example commands provided

---

## Success Criteria

**Phase 9b Completion**:

- ✅ Commander.js installed and integrated
- ✅ Automatic help text generation working
- ✅ Three fixture presets available (minimal, standard, complex) for both API and E2E
- ✅ `--fixture <name>` flag works in both test runners
- ✅ `.env` files auto-detected from test directories
- ✅ `@env` annotations only support variables, not file paths
- ✅ CLI interfaces harmonized between backend and E2E runners
- ✅ Shared code extracted to `tests/lib/` modules:
  - `cli-builder.js` - CLI configuration with Commander.js
  - `env-loader.js` - Environment file loading
  - `fixture-loader.js` - Fixture loading and management
- ✅ All existing tests pass without modification
- ✅ npm scripts simplified (no explicit `--env-file` flags)
- ✅ Backward compatibility maintained where possible

**Quality Metrics**:

- ✅ No code duplication between test runners
- ✅ Consistent CLI interface across runners
- ✅ Help text always in sync with implementation
- ✅ Clear separation of concerns (fixtures, env, CLI)
- ✅ Easy to add new fixture presets
- ✅ Easy to add new CLI options

## Testing Plan

### Unit Tests

Create unit tests for new library modules:

1. **`tests/unit/js/lib/env-loader.test.js`**:
   - Test explicit `--env-file` path
   - Test auto-detection from `--test-dir`
   - Test auto-detection from default search paths
   - Test error handling for missing files

2. **`tests/unit/js/lib/fixture-loader.test.js`**:
   - Test fixture loading with all presets
   - Test error handling for missing fixtures
   - Test cleanup of runtime directory
   - Test file copying behavior

### Integration Tests

Test complete workflows:

1. **API tests with fixtures**:

   ```bash
   npm run test:backend -- --fixture minimal
   npm run test:backend -- --fixture standard
   npm run test:backend -- --fixture complex
   ```

2. **E2E tests with fixtures**:

   ```bash
   npm run test:e2e -- --fixture minimal
   npm run test:e2e -- --fixture standard
   npm run test:e2e -- --fixture complex
   ```

3. **Environment variable handling**:

   ```bash
   # Auto-detected .env
   npm run test:backend

   # Explicit env file
   npm run test:backend -- --env-file .env.custom

   # Individual variables
   npm run test:backend -- --env DEBUG=1 --env API_KEY=test123
   ```

4. **Help text**:

   ```bash
   # Should show comprehensive, formatted help
   node tests/backend-test-runner.js --help
   node tests/e2e-runner.js --help
   ```

5. **Smart test runner**:

   ```bash
   # Should not pass --env-file to runners
   node tests/smart-test-runner.js app/src/ui.js
   ```

## Migration Path

Phase 9b changes are mostly additive and backward-compatible:

1. **Commander.js**: New dependency, doesn't affect existing code
2. **Fixtures**: Existing tests will use "standard" preset by default
3. **Environment**: Existing `.env` files work without changes if in correct locations
4. **CLI**: All existing flags continue to work
5. **npm scripts**: Can be updated incrementally

### Breaking Changes

- `@env path/to/.env` in test annotations no longer supported (warning + ignore)
- `tests/api/.env.test` moved to `tests/api/v1/.env` (npm scripts need update)

### Rollback Plan

If issues arise:

1. Commander.js can be removed and manual parsing restored
2. Shared library modules are new - can be removed
3. Fixture structure can coexist with old structure temporarily
4. Test runners maintain backward compatibility with explicit `--env-file`

## Timeline

Estimated effort: **4-6 hours**

- Step 1 (Commander + utilities): 1.5-2 hours
- Step 2 (Fixture reorganization): 30 min
- Step 3 (Backend runner): 1 hour
- Step 4 (E2E runner): 1 hour
- Step 5 (Smart runner): 30 min
- Step 6 (.env files): 15 min
- Step 7 (Completion doc): 15 min

## Dependencies

- Phase 9 initial implementation complete
- Existing test infrastructure functional
- Node.js ≥16 for Commander.js

## Risks and Mitigations

**Risk**: Commander.js adds dependency and learning curve

- **Mitigation**: Industry standard library, excellent documentation, simpler than manual parsing

**Risk**: Breaking existing tests during refactoring

- **Mitigation**: Maintain backward compatibility, extensive testing at each step

**Risk**: Fixture presets diverge over time

- **Mitigation**: Clear documentation, regular review, automated validation

**Risk**: Auto-detection of `.env` files causes confusion

- **Mitigation**: Clear logging of which file is loaded, override via `--env-file`

**Risk**: Help text still requires maintenance

- **Mitigation**: Commander generates help from definitions - can't get out of sync

## Next Steps

After Phase 9b completion:

- Continue with Phase 9 Step 3: Cross-Backend API Testing
- Use new fixture system for testing API equivalence
- Leverage CLI harmonization for better test workflows
- Consider using Commander.js for other CLI tools in project

---

Last updated: 2025-10-17
