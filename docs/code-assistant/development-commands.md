# Development Commands

Quick reference for common development tasks. Always use `uv run python` for Python commands and `node` for Node.js commands.

Script layout: see [bin/README.md](../../bin/README.md), [bin/migrations/README.md](../../bin/migrations/README.md) and [scripts/README.md](../../scripts/README.md).

## Development Server

```bash
# Start development server (FastAPI backend + JS frontend)
npm run start:dev
# Access at http://localhost:3001

# Development mode with source files (append ?dev to URL)
# http://localhost:3001?dev

# Kill running server and restart
npm run start:dev -- --restart

# Bypass authentication for development/testing
FASTAPI_ALLOW_ANONYMOUS_ACCESS=true npm run start:dev
```

**Options**:

- `--restart`: Kill any existing server process on the port and start fresh

**Note**: The `--restart` flag works for both `npm run start:dev` and `npm run start:prod`.

**Logs**: `npm run start:dev` (with or without `--restart`) empties `log/app.log` and `log/server.log` (or the files in `LOG_DIR`), so they only contain the current server run. Reloads after file changes keep appending to them.

## Build System

```bash
# Full build process
npm run build

# Generate the plugin and module registries, the importmap and the highlight.js bundle
# (run by npm install and npm run start:dev)
npm run generate
```

The API client (`app/src/modules/api-client-v1.js`) is hand-maintained, not generated — see [docs/code-assistant/api-client.md](api-client.md).

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
# Manage users via HTTP API (server must be running)
npm run manage-remote -- user add <username> --password <password> --fullname "<Full Name>" --roles <role1,role2>
npm run manage-remote -- user list
npm run manage-remote -- user remove <username>
npm run manage-remote -- user --help
```

## Configuration Management

```bash
# Get/set configuration values via HTTP API (server must be running)
npm run manage-remote -- config get <key>
npm run manage-remote -- config set <key> <json_value>
```

## Development Workflow

1. **Frontend changes**: Edit files in `app/src/`, test with `?dev` URL parameter
2. **DO NOT rebuild after frontend changes** - The importmap loads source files directly in development mode
3. **Backend changes**: Server auto-reloads automatically (FastAPI dev server detects changes), including changes to plugins installed as editable packages from a pte-plugins checkout (`npm run dev:install` there) and to `FASTAPI_PLUGIN_PATHS` plugins
4. **Schema updates**: Delete `schema/cache/` to refresh XSD cache
5. **Building is only needed for production**. The production bundle (templates, version file, PDF.js, Rollup bundle, icons) is built inside the Docker image, both in CI and for releases, so there is no git hook for it. The files that loading the frontend from source needs (`app/src/plugin-registry.js`, `app/src/module-registry.js`, `app/web/importmap.json`, `app/web/highlight.js`) are generated and not under version control. `npm run generate` creates them; `npm install` and `npm run start:dev` run it. After adding or removing a frontend plugin, a `@registerModule` module or an npm dependency while the dev server runs, run `npm run generate`.

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
npm run test:changed           # Test changed files (smart runner)
npm run test:unit:js           # JavaScript unit tests
npm run test:unit:fastapi      # Python unit tests
npm run test:api               # API integration tests
npm run test:e2e               # E2E tests with Playwright
```
