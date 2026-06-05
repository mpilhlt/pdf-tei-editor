# Testing Rules

Rules specific to tests in `tests/`. The root [CLAUDE.md](../CLAUDE.md) applies here too.

## Test Filtering: --grep Behavior

The `--grep` parameter works **differently** for API vs E2E tests:

- **API tests** (`npm run test:api -- --grep "xxx"`): Matches **file paths**
  - Example: `--grep "files_save"` runs `tests/api/v1/files_save.test.js`
  - Example: `--grep "caching"` runs `tests/api/v1/files_serve_caching.test.js`
  - Implementation: backend-test-runner filters files before passing to Node.js

- **E2E tests** (`npm run test:e2e -- --grep "xxx"`): Matches **test names** (test descriptions)
  - Example: `--grep "should upload"` runs all tests with "upload" in the test name
  - Example: `--grep "new version"` runs tests like `test('should create new version', ...)`
  - Implementation: Playwright receives the grep pattern directly and matches against test descriptions
  - **To run specific test files**, pass file paths as positional arguments: `node tests/e2e-runner.js tests/e2e/tests/auth-workflow.spec.js`

Quick rule: `*.test.js` (API) → grep by **file path**; `*.spec.js` (E2E) → grep by **test name** OR pass file paths directly

The smart-test-runner handles this automatically: API tests use `--grep` with file path patterns, E2E tests pass file paths as positional arguments.

## Test Patterns

- **Check testing guide before writing/debugging tests** - ALWAYS consult [docs/code-assistant/testing-guide.md](../docs/code-assistant/testing-guide.md) before writing new tests or debugging test failures. It contains critical patterns, helper functions, and known issues (like Shoelace component testing). For Python unit tests of FastAPI routes, see the section on dependency overrides vs @patch decorators
- **Testing authenticated routes** - When writing tests for routes that use `Depends(get_session_manager)` and `Depends(get_auth_manager)`, ALWAYS use `app.dependency_overrides` in `setUp()` to mock these dependencies with valid authentication by default, and include `session_id` parameter in test requests. See [docs/code-assistant/testing-guide.md](../docs/code-assistant/testing-guide.md) Authentication Testing Pattern section
- **Backend plugin tests location** - Plugin tests MUST be placed in the plugin's `tests/` directory (e.g., `fastapi_app/plugins/<plugin-name>/tests/`). To run plugin tests, use `--test-dir` parameter: `node tests/backend-test-runner.js --test-dir fastapi_app/plugins/<plugin-name>/tests`. This keeps tests colocated with the plugin code
- **Writing plugin integration tests** - ALWAYS consult the "Plugin Integration Tests" section in [docs/code-assistant/testing-guide.md](../docs/code-assistant/testing-guide.md) before writing integration tests for backend plugins. It covers: required `.env.test` configuration (DATA_ROOT, DB_DIR, LOG_DIR paths), authentication patterns (login returns object not string), testing custom routes, and working with fixtures
- **Suppress expected error output in tests** - When tests validate error handling that logs errors or warnings, ALWAYS use `assertLogs` context manager to suppress console output. This keeps test output clean and verifies the error is logged. Example: `with self.assertLogs('module.name', level='ERROR') as cm:` wrapping the code that produces expected errors. Never let expected errors pollute test output.
- **Shoelace dialog button clicks require delay** - ALWAYS add `await page.waitForTimeout(500)` before clicking buttons in Shoelace dialogs. Shoelace dialogs use Shadow DOM and animations, and clicking too quickly results in the click being ignored. See [docs/code-assistant/testing-guide.md](../docs/code-assistant/testing-guide.md) for the pattern
- **Debugging editor/CodeMirror issues** - When debugging issues in the XML editor (`xmlTagSync` or other CodeMirror extensions), prefer the isolated harness tests (`npm run test:e2e:xmleditor-browsers`) over full E2E tests. The harness isolates editor behaviour without a login sequence, fixture loading, or application state, and runs across all three browser engines. See [docs/code-assistant/testing-guide.md](../docs/code-assistant/testing-guide.md#isolated-component-harness-tests) for details.
- **Use testLog() for E2E test validation** - Don't rely on DOM queries
- **E2E tests: use client.apiClient, not fetch()** - In `page.evaluate()`, NEVER use manual `fetch()` calls to API endpoints. Always use `window.client.apiClient` which provides typed methods for all endpoints. Check `app/src/modules/api-client-v1.js` for available methods (auto-generated from OpenAPI schema). See [docs/code-assistant/testing-guide.md](../docs/code-assistant/testing-guide.md#using-api-client-in-browser-context-e2e-tests)
