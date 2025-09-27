# Development Commands



## Development Server

```bash
# Start development server (Python/Flask backend + JS frontend)
npm start
# Access at http://localhost:3001

# Development mode with source files (append ?dev to URL)
# http://localhost:3001?dev
```

## Build System

```bash
# Full build process
npm run build
# Equivalent to: ./bin/build

# Update import map after changing NPM dependencies
npm run update-importmap
```

## Testing and Validation

```bash
# Run all tests (JS, Python, E2E) - don't use this, run more specific tests
npm test

# Run only tests for changed files
npm run test:changed

# Run all JavaScript unit tests
npm run test:js

# Run all Python integration tests
npm run test:py

# Run end-to-end tests in containerized environment
npm run test:e2e
npm run test:e2e:firefox    # Test with Firefox
npm run test:e2e:headed     # Show browser UI
npm run test:e2e:debug      # Debug mode
npm run test:e2e:backend    # Backend integration tests only

# Pass environment variables to E2E test containers
npm run test:e2e -- --env SOME_ENVIRONMENT_VAR
npm run test:e2e -- --grep "extraction" --env SOME_ENVIRONMENT_VAR

# Use custom .env file for E2E tests
npm run test:e2e -- --dotenv-path .env.testing

# Run smart test runner (selects tests based on file changes)
node tests/smart-test-runner.js --changed-files <files>

# The application includes XML validation through TEI schema validation
```

## User Management

```bash
# Manage users via CLI
./bin/manage.py user add <username> --password <password> --fullname "<Full Name>" --roles <role1,role2>
./bin/manage.py user list
./bin/manage.py user remove <username>
```

## Configuration Management

```bash
# Get/set configuration values
./bin/manage.py config get <key>                    # Read from db/config.json
./bin/manage.py config get <key> --default          # Read from config/config.json
./bin/manage.py config set <key> <json_value>       # Set in db/config.json
./bin/manage.py config set <key> <json_value> --default  # Set in both files
./bin/manage.py config delete <key>                 # Delete from db/config.json
./bin/manage.py config delete <key> --default       # Delete from both files

# Value constraints and validation
./bin/manage.py config set <key> --values '["val1", "val2"]'  # Set allowed values
./bin/manage.py config set <key> --type "string"              # Set type constraint
```

## Development Workflow

1. Frontend changes: Edit files in `app/src/`, test with `?dev` URL parameter
2. **DO NOT rebuild after frontend changes** - The importmap loads source files directly in development mode
3. Backend changes: Server auto-reloads automatically (Flask dev server detects changes)
4. **DO NOT restart the server** - Flask development server auto-restarts on backend changes
5. Schema updates: Delete `schema/cache/` to refresh XSD cache
6. Building is only needed for production and is handled by pre-push git hooks

## Debugging and Logging

- Development server uses colorized logging for better visibility
- WARNING messages appear in orange/yellow for timeouts and issues
- ERROR messages appear in red for critical problems

## Annex: documentation of NPM commands:

```bash
available via `npm run-script`:
  ci
    uv sync && npm install
  start:dev
    uv run python bin/start-dev
  start:prod
    uv run python bin/start-prod
  build
    node bin/build.js
  manage
    node bin/manage.js
  test:all
    node tests/smart-test-runner.js --all
  test:changed
    node tests/smart-test-runner.js
  test:tap
    node tests/smart-test-runner.js --all --tap
  test:js
    node --test tests/js/*.test.js
  test:py
    uv run pytest tests/py/
  test:e2e
    node tests/e2e-runner.js --playwright --env SOME_ENVIRONMENT_VAR
  test:e2e:fast
    node tests/e2e-runner.js --playwright --no-rebuild --env SOME_ENVIRONMENT_VAR
  test:e2e:fast:dev
    node tests/e2e-runner.js --playwright --no-rebuild --development --env SOME_ENVIRONMENT_VAR
  test:e2e:headed
    node tests/e2e-runner.js --playwright --headed --no-rebuild --env SOME_ENVIRONMENT_VAR
  test:e2e:headed-debug
    PWDEBUG=1 node tests/e2e-runner.js --playwright --debug --headed --no-rebuild --env SOME_ENVIRONMENT_VAR
  test:e2e:backend
    node tests/e2e-runner.js --backend --env SOME_ENVIRONMENT_VAR
  test:e2e:backend:fast
    node tests/e2e-runner.js --backend --no-rebuild --env SOME_ENVIRONMENT_VAR
```

