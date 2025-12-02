# Development Commands

Quick reference for common development tasks. Always use `uv run python` for Python commands and `node` for Node.js commands.

## Development Server

```bash
# Start development server (FastAPI backend + JS frontend)
npm run start:dev
# Access at http://localhost:3001

# Development mode with source files (append ?dev to URL)
# http://localhost:3001?dev

# Bypass authentication for development/testing
FASTAPI_ALLOW_ANONYMOUS_ACCESS=true npm run start:dev
```

## Build System

```bash
# Full build process
npm run build

# Generate API client from FastAPI OpenAPI spec
npm run generate-client

# Check if API client is outdated
npm run generate-client:check
```

## Testing Commands

```bash
# Run tests for changed files (most common)
npm run test:changed

# Unit tests
npm run test:unit:js          # JavaScript unit tests
npm run test:unit:fastapi     # Python unit tests
npm run test:unit             # Both JS and Python units

# API integration tests (local server, fast)
npm run test:api
npm run test:api -- --grep "save"  # Filter by test name

# E2E tests (Playwright)
npm run test:e2e              # Run E2E tests with local server
npm run test:e2e:headed       # Show browser UI
npm run test:e2e:debug        # Step-through debugging
npm run test:e2e:container    # Run in container

# Run all tests
npm run test:all
```

## User Management

```bash
# Manage users via CLI
npm run manage user add <username> --password <password> --fullname "<Full Name>" --roles <role1,role2>
npm run manage user list
npm run manage user remove <username>
npm run manage user help
```

## Configuration Management

```bash
# Get/set configuration values
npm run manage config get <key>                    # Read from db/config.json
npm run manage config get <key> --default          # Read from config/config.json
npm run manage config set <key> <json_value>       # Set in db/config.json
npm run manage config set <key> <json_value> --default  # Set in both files
npm run manage config delete <key>                 # Delete from db/config.json
npm run manage config delete <key> --default       # Delete from both files

# Value constraints and validation
npm run manage config set <key> --values '["val1", "val2"]'  # Set allowed values
npm run manage config set <key> --type "string"              # Set type constraint
```

## Development Workflow

1. **Frontend changes**: Edit files in `app/src/`, test with `?dev` URL parameter
2. **DO NOT rebuild after frontend changes** - The importmap loads source files directly in development mode
3. **Backend changes**: Server auto-reloads automatically (FastAPI dev server detects changes)
4. **Schema updates**: Delete `schema/cache/` to refresh XSD cache
5. **Building is only needed for production** and is handled by pre-push git hooks

## Critical Reminders

- **ALWAYS use `uv run python`** for Python commands
- **NEVER restart the dev server manually** - It auto-restarts on changes
- Backend changes auto-reload - watch terminal for reload confirmation
- Tests should use containerized server or local test runner, not the dev server
- The `?dev` URL parameter enables source file loading for faster frontend iteration

## Common NPM Scripts Reference

```bash
npm run start:dev              # Start FastAPI development server
npm run start:prod             # Start production server
npm run build                  # Build for production
npm run manage                 # User/config management CLI
npm run test:changed           # Test changed files (smart runner)
npm run test:unit:js           # JavaScript unit tests
npm run test:unit:fastapi      # Python unit tests
npm run test:api               # API integration tests
npm run test:e2e               # E2E tests with Playwright
npm run generate-client        # Generate TypeScript API client
```
