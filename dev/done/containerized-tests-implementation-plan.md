# Containerized Tests - Simplification Implementation Plan

## Current State Analysis

The project has two container scenarios that are overly complex:

1. **Production Container** ([bin/container.js](bin/container.js), [docker/entrypoint.sh](docker/entrypoint.sh))
   - Works correctly for running the application
   - No changes needed

2. **Test Container** (Currently Complex - NEEDS SIMPLIFICATION)
   - [tests/lib/container-server-manager.js](tests/lib/container-server-manager.js) - manages containerized servers for testing FROM OUTSIDE
   - [docker/entrypoint-test.sh](docker/entrypoint-test.sh) - starts server inside container for external tests
   - [tests/backend-test-runner.js](tests/backend-test-runner.js) and [tests/e2e-runner.js](tests/e2e-runner.js) - have `--container` modes
   - Problem: Complex fixture mounting, config mismatches, client-server architecture

## Target Architecture

**Two Clean Scenarios:**

### Scenario 1: Production Container (No Changes)
- Build: `npm run container:build`
- Run: `npm run container:start`
- Uses: [Dockerfile](Dockerfile) production stage, [docker/entrypoint.sh](docker/entrypoint.sh)

### Scenario 2: Test Runner Container (NEW SIMPLIFIED APPROACH)
- Build & Run: `npm run test:container [--no-cache] [changed files...]`
- Container runs ALL tests internally and exits with test results
- **Test output streams to host console in real-time** (not a black box)
- No server exposed, no external test runners
- Test runners always run locally (either on host or in container)

## Implementation Steps

### 1. Create New Test Runner Container Stage

**File: [Dockerfile](Dockerfile)**
- Add new `ci` stage after `test` stage
- Copies full test suite into container
- Copies all test dependencies (node_modules with dev deps, Python test packages)
- Sets `ENTRYPOINT` to run tests internally
- **Critical**: Ensure unbuffered output for real-time streaming

### 2. Create Test Runner Entrypoint

**File: `docker/entrypoint-ci.sh`** (NEW)
- Sets up test environment variables
- Initializes test database/fixtures
- Runs `node tests/smart-test-runner.js` with passed arguments
- **Uses `exec` to replace shell process** (ensures signal handling)
- **Unbuffered output** to stream logs in real-time
- Exits with test exit code

### 3. Create Container Test Runner Script

**File: `bin/test-container.js`** (NEW)
- Detects Docker/Podman
- Builds `pdf-tei-editor:ci` image (with optional --no-cache)
- **Runs container with `stdio: 'inherit'`** to stream output to console
- Uses `docker run --rm` for automatic cleanup
- Passes through all arguments to smart-test-runner
- Returns test exit code from container

Example implementation:
```javascript
// Stream output in real-time
const result = spawn(containerCmd, [
  'run',
  '--rm',
  'pdf-tei-editor:ci',
  ...testArgs
], {
  stdio: 'inherit', // Stream stdout/stderr to parent process
  cwd: projectRoot
});

result.on('close', (code) => {
  process.exit(code); // Exit with container's exit code
});
```

### 4. Add npm Script

**File: [package.json](package.json)**
```json
"test:container": "node bin/test-container.js"
```

### 5. Update GitHub Actions Workflow

**File: [.github/workflows/pr-tests.yml](.github/workflows/pr-tests.yml)**
- Use Docker layer caching (already configured)
- Build `pdf-tei-editor:ci` target
- Run `docker run --rm pdf-tei-editor:ci --changed-files "$FILES"`
- **Output streams automatically to GitHub Actions logs**
- No need for server startup, health checks, or cleanup
- Re-enable PR triggers (currently disabled)

### 6. Remove Obsolete Infrastructure

**Files to Delete:**
- `tests/lib/container-server-manager.js` - no longer needed
- `docker/entrypoint-test.sh` - replaced by `entrypoint-ci.sh`
- `bin/test-container-startup.js` - no longer needed
- `docker-compose.test.yml` - no longer needed

**Files to Modify:**
- `tests/backend-test-runner.js` - remove `--container` mode
- `tests/e2e-runner.js` - remove `--container` mode
- Remove from [package.json](package.json):
  - `test:api:container`
  - `test:api:container:cached`
  - `test:e2e:container`
  - `test:e2e:container:cached`
  - `test:container` (replaced with new version)

### 7. Update Documentation

**Files:**
- [dev/todo/containerized-tests.md](dev/todo/containerized-tests.md) - mark as completed with summary
- [CLAUDE.md](CLAUDE.md) - update container commands section
- [docs/code-assistant/testing-guide.md](docs/code-assistant/testing-guide.md) - update container testing section

## Benefits

1. **Simpler Architecture**: Tests run in container, not against container
2. **No Fixture Issues**: All fixtures baked into image at build time
3. **No Config Mismatches**: Test environment initialized inside container
4. **Faster CI**: No startup delays, health checks, or cleanup needed
5. **Consistent Interface**: Same test runner locally or in container
6. **Better Caching**: Full Docker layer caching for dependencies
7. **Real-time Feedback**: Test output streams to console as it runs

## Migration Path

1. Implement new container test infrastructure (steps 1-4)
2. Test locally: `npm run test:container` (verify streaming output works)
3. Update GitHub Actions (step 5)
4. Test in CI with manual workflow trigger
5. Once validated, remove old infrastructure (step 6)
6. Update documentation (step 7)

## Testing Validation

Before removing old infrastructure:
- `npm run test:container` runs all tests successfully with streaming output
- `npm run test:container --no-cache` rebuilds and runs successfully
- `npm run test:container path/to/changed/file.js` runs only relevant tests
- Test output appears in real-time (not buffered until completion)
- GitHub Actions workflow runs successfully with cached layers
- GitHub Actions workflow shows streaming test output in logs
- GitHub Actions workflow handles test failures correctly
