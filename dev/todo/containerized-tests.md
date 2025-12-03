# Containerized Tests - Fix Required

## Status: BLOCKED

The GitHub Actions workflow for PR testing is disabled due to containerized API tests failing.

## Problem

When running API tests with `npm run test:api:container:cached`, most tests fail with configuration and data mismatches. The core issue is that **test fixtures are not accessible to the containerized backend**.

### Specific Issues

1. **Configuration mismatch**: Tests expect `session.timeout = 3600` but container returns `86400`
   - Root cause: Test configs in `tests/api/runtime/config/` aren't being used by the container
   - The entrypoint script was modified to check for mounted test configs at `/app/data/config/`
   - Volume mount was added: `tests/api/runtime:/app/data`
   - But config values still don't match

2. **Test data isolation**: Local tests use individual fixture data per test suite
   - Files in `tests/api/fixtures/` and `tests/e2e/fixtures/`
   - These fixtures are not available to the containerized backend
   - Tests expect specific users, files, and data that don't exist in the container

3. **Setup phase differences**:
   - Local tests: Fixtures loaded by `fixture-loader.js` into `tests/api/runtime/`
   - Container tests: Uses baked-in fixtures from image + volume-mounted runtime
   - The fixture loading happens on the host, but container can't see the setup

## What Was Fixed

1. **Port mapping**: Fixed default containerPort from 8011 to 8000 ([tests/lib/container-server-manager.js:41](tests/lib/container-server-manager.js#L41))

2. **Volume mounting**: Added mount for test data directory ([tests/lib/container-server-manager.js:223-230](tests/lib/container-server-manager.js#L223-L230))

3. **Entrypoint script**: Modified to prefer test configs from mounted volume ([docker/entrypoint-test.sh:22-45](docker/entrypoint-test.sh#L22-L45))

4. **Health check debugging**: Improved error logging with curl verbose output

5. **Test script**: Fixed method name from `getUrl()` to `getBaseUrl()` ([bin/test-container-startup.js:28](bin/test-container-startup.js#L28))

## What Still Needs Work

### Option A: Full Fixture Mounting (Recommended)

Mount all test fixtures into the container so it has access to the same test data:

1. Modify `docker/entrypoint-test.sh` to detect and use mounted test fixtures
2. Update `tests/lib/container-server-manager.js` to mount additional volumes:
   - `tests/api/fixtures:/app/test-fixtures`
   - `tests/e2e/fixtures:/app/e2e-fixtures`
3. Ensure fixture loading happens inside the container or data is pre-populated

### Option B: Simplified Test Fixtures

Create a minimal, self-contained fixture set specifically for containerized testing:

1. Create `tests/api/container-fixtures/` with minimal config and data
2. Bake these into the container image at build time
3. Modify tests to work with this simplified fixture set when running in container mode

### Option C: Hybrid Approach

Use environment variables to override config values:

1. Modify FastAPI config loading to prefer environment variables over file-based config
2. Pass all test configuration via environment variables
3. Still mount test data directory for file fixtures

## Test Commands

```bash
# Test specific suite
npm run test:api:container:cached -- --grep "config"

# Test with rebuild
npm run test:api:container -- --grep "config"

# Test container startup
npm run test:container
```

## Related Files

- `.github/workflows/pr-tests.yml` - Disabled workflow
- `tests/backend-test-runner.js` - Test runner with container mode
- `tests/lib/container-server-manager.js` - Container lifecycle management
- `tests/lib/fixture-loader.js` - Fixture loading (host-side)
- `docker/entrypoint-test.sh` - Container initialization
- `tests/api/v1/.env.test` - Test environment variables
- `tests/api/runtime/` - Runtime data directory (mounted)
- `tests/api/fixtures/` - Test fixture presets (NOT mounted currently)

## Next Steps

1. Investigate fixture-loader.js to understand full fixture setup process
2. Decide on approach (A, B, or C above)
3. Implement chosen approach
4. Verify all API tests pass with containerized backend
5. Re-enable GitHub Actions workflow
6. Test on CI to ensure Docker layer caching works properly

## Notes

- Container builds successfully and server starts
- Health check passes
- Port mapping works correctly (8020:8000)
- Volume mount for runtime data works
- The issue is purely about test fixture/config availability
