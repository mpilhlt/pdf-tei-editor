# CLAUDE.md

This file provides guidance to code assistants when working with code in this repository.

Domain-specific rules are in subdirectory CLAUDE.md files: [app/CLAUDE.md](app/CLAUDE.md) (frontend), [fastapi_app/CLAUDE.md](fastapi_app/CLAUDE.md) (backend), [tests/CLAUDE.md](tests/CLAUDE.md) (testing).

## General rules

- ALWAYS be concise. Only include information that is relevant to the implementation. Omit any kind of motivational or congratulatory language. Do NOT use vocabulary such as "excellent", "brilliant", "great", etc.
- **Python string literals** - Write long strings as single contiguous string literals (readable in soft-wrap mode), not as multiple adjacent string literals implicitly concatenated across lines.
- If you think there might be a problem with the user's idea, push back. Don't assume the user's ideas are necessarily correct. Ask if you should go with their idea, but also suggest alternatives.
- Your effort is precious, and you know how to write shell scripts. If you identify a repetitive workflow that requires you to parse text with a low signal-to-noise ratio, take the time to write helper scripts to automate or filter what can be automated or filtered.
- **Markdown linting** — ignore all markdown linter warnings in files under `dev/`, `.claude/plans/`, or `docs/superpowers/`. These are working documents, not published documentation.

## Detailed Documentation

For comprehensive guides, see the documentation in the `docs/code-assistant/` directory:

- **[Frontend Architecture](docs/code-assistant/architecture-frontend.md)** - Frontend plugin system, UI components, templates
- **[UI Storage](docs/code-assistant/ui-storage.md)** - Persisting UI preferences with UIStorage (localStorage wrapper, DOM binding, testing)
- **[Backend Architecture](docs/code-assistant/architecture-backend.md)** - FastAPI structure, lib/ modules, import patterns
- **[Coding Standards](docs/code-assistant/coding-standards.md)** - JSDoc requirements, best practices, conventions
- **[API Reference](docs/development/api-reference.md)** - Existing API documentation for JavaScript, Python and HTTP backend API, including on machine-readable API schemas
- **[Class Dependencies](docs/development/class-dependencies.md)** - FastAPI dependency injection system, available dependencies
- **[Development Commands](docs/code-assistant/development-commands.md)** - Setup, testing, build system, user management
- **[Plugin Development](docs/code-assistant/plugin-development.md)** - Creating frontend plugins, state management, common patterns
- **[Plugin Communication](docs/code-assistant/plugin-communication.md)** - Inter-plugin communication: state propagation, extension points, getDependency
- **[Plugin Migration Guide](docs/code-assistant/plugin-migration-guide.md)** - Migrating frontend plugins from object-based to class-based architecture
- **[CI/CD Pipeline](docs/development/ci-cd-pipeline.md)** - GitHub Actions workflows, test execution, release process
- **[Backend Plugins](docs/code-assistant/backend-plugins.md)** - Creating backend plugins, role-based access, custom routes
- **[Testing Guide](docs/code-assistant/testing-guide.md)** - E2E tests, backend tests, debugging, test logging
- **[Database Connections](docs/code-assistant/database-connections.md)** - SQLite connection pooling, WAL mode, and transaction handling
- **[CLI](docs/user-manual/cli.md)** - Command Line Interface reference
- **[API Client](docs/code-assistant/api-client.md)** - FastAPI client usage, type safety, patterns

### Key Directories

Read [docs/code-assistant/architecture-frontend.md](docs/code-assistant/architecture-frontend.md) for frontend and [docs/code-assistant/architecture-backend.md](docs/code-assistant/architecture-backend.md) for backend when you need to understand the system design.

- `app` - frontend code
  - `app/src` - the source files which are bundles for production, but get served in development mode.
  - `app/src/modules` - library files which should never directly depend on plugin files - use dependency injection if necessary
  - `app/src/plugins` - Plugin objects and classes (Read [docs/code-assistant/plugin-development.md](docs/code-assistant/plugin-development.md) when creating new plugins)
  - `app/src/templates` - html templates used by the plugins to create UI parts
- `bin` - executable files used on the command line
- `config` - the default content of files in `data/db`
- `data` - file data
- `data/db` - application data stored in subject-specific json files and SQLite databases
  - `data/db/metadata.db` - Main file metadata database (SQLite) - ALWAYS use this for file queries, NOT files.db
- `fastapi_app` - the python backend based on FastAPI
- `tests` - JavaScript and Python unit tests and E2E tests (Read [docs/code-assistant/testing-guide.md](docs/code-assistant/testing-guide.md) when creating or debugging tests)

### Key Files (Frontend)

- Entry point: `app/src/app.js`
- UI elements definitions via `@typedef`: `app/src/ui.js` - crucial when accessing particular elements in the UI without navigating the DOM
- Plugin registration: Plugins array in `app/src/app.js:71-76`
- Plugins: `app/src/plugins.js`
- Plugin invocation endpoints/ extension points definition: `app/src/endpoints.js`
- Application state object definition: `app/src/state.js`
- `app/src/modules/api-client-v1.js` is **auto-generated** from the FastAPI OpenAPI schema. The client provides typed methods for all `/api/v1/` endpoints

### API Verification

Before using any method on a class or module:

1. Check the class definition or module exports first
2. Consult generated API docs in `docs/api/` for signatures
3. Machine-readable JSON available at `docs/api/backend-api.json` for Python class/function APIs

### Debugging Live Application

When debugging, you can also use a running instance of the application and use `bin/debug-api.js` to test API endpoints directly. If it is not running, ask the user to start it.

```bash
# Authenticate and call any endpoint
node bin/debug-api.js <method> <path> [json-params]

# Examples:
node bin/debug-api.js GET /api/v1/plugins
node bin/debug-api.js POST /api/v1/extract '{"extractor":"grobid","file_id":"abc123"}'
node bin/debug-api.js GET /api/v1/collections/test/files
```

The script:

- Authenticates using credentials from `.env` file (API_USER, API_PASSWORD)
- Uses SHA-256 password hashing (matching the auth API requirements)
- Handles GET requests with query parameters
- Handles POST/PUT/DELETE requests with JSON body
- Returns formatted JSON responses with status codes

See the OpenAPI specification at `http://localhost:8000/openapi.json` for all available endpoints and their parameters.

## Important Reminders

### Development Workflow

1. Backend changes: Server auto-reloads automatically (FastAPI dev server detects changes)
2. Schema updates: Delete `schema/cache/` to refresh XSD cache
3. Building is only needed for production and is handled by pre-push git hooks

### Critical Rules

- **Command Execution**: ALWAYS use `uv run python` for Python commands and `node` for Node.js commands
- **Suggest Prompt Updates**: if something in the documentation does not align with the consistent code patterns, suggest to update the documentation
- **NEVER start, restart, or suggest restarting the dev server** - It auto-restarts on changes, tests should use the test runners
- **ALWAYS add comprehensive JSDoc headers** - Use specific types instead of generic "object"
- **JSDoc type imports** - ALWAYS use separate `@import` tag blocks at the top of the file for type imports (e.g., `@import { SlMenuItem } from '../ui.js'`), NEVER use inline `import()` expressions inside type annotations anywhere in the file (e.g., `@param {import('../ui.js').SlMenuItem}`). This applies to all JavaScript files including frontend extension files (`fastapi_app/plugins/*/extensions/*.js`). Inline imports are stripped by the extension bundler comment-stripping and lose IDE support.
- **Check generated documentation before adding new code** - Before implementing new functionality, ALWAYS check available documentation to prevent reinventing existing APIs: (1) For backend Python: check `docs/api/backend-api.json` for class/function signatures, or read the source module directly; (2) For frontend JavaScript: read the module exports directly; (3) For REST endpoints: check FastAPI docs at `/docs` or the OpenAPI schema. See [docs/development/api-reference.md](docs/development/api-reference.md) for complete documentation overview. If functionality already exists, use it instead of creating duplicates
- **NEVER make up non-existing APIs** - Before using any method on a class or module instance, ALWAYS verify that the method exists with the exact signature you're using. Read the class definition or module exports first. If a needed API doesn't exist, implement it rather than assuming it exists
- **Python type annotations** - ALWAYS use precise types in function signatures: never use `Any` when the actual type is known, never use unparameterized `tuple` or `dict` (use `tuple[X, ...]` / `dict[str, X]`), and annotate all FastAPI dependency parameters (e.g. `session_manager: SessionManager = Depends(get_session_manager)`). Resolve all type errors before finishing a task.
- **CI/CD Workflow Changes** - ALWAYS consult [docs/development/ci-cd-pipeline.md](docs/development/ci-cd-pipeline.md) before modifying GitHub Actions workflows. The document describes the test execution strategy, release process, and dependencies between workflows
- **Prefer empirical debugging over theoretical analysis** - When analysis of a problem starts to take longer than roughly two minutes, stop and consider whether adding debug statements would be faster. If so, add the debug output, ask the user to run the program, and use the actual output to guide the fix. Do not reconstruct program behavior theoretically when empirical data is available.
- **Verify system behavior with unit tests, not theoretical tracing** - When unsure how a system works (e.g., how a plugin framework discovers methods, how a state manager dispatches events), write a focused unit test and run it to get ground truth. Theoretically tracing through multiple layers of code wastes tokens and is error-prone. A test gives definitive answers in seconds.
- **When inserting temporary debug logging commands, ALWAYS include `DEBUG` in the message** so that these commands can be found and removed later.
- If during debugging you learn something that is not contained in the code assistant documentation, add it to the respective file!
- When asked to create a github issue or other github maintenance issues, use the `gh` tool and ask the user to install it if it is not available
- **Markdown formatting** — follow these rules in all `.md` files: (1) Table cells must have spaces around the content: `| value |`, not `|value|`; separator rows must be `| --- |`, not `|---|`. (2) Fenced code blocks must always specify a language identifier (bash, python, text, etc.) — never use a bare triple-backtick fence. (3) Anchor links must exactly match a heading in the file after lowercasing and replacing spaces/punctuation with hyphens; verify the target heading exists before writing the link.
- **GitHub issue closure** - When working on a fix for a GitHub issue, do NOT close the issue manually using `gh issue close`. Instead, include the issue reference in the commit message (e.g., "Fixes #123" or "Closes #157") so that GitHub automatically closes it when the commit is pushed to the default branch. Only use `gh issue comment` to add summary comments if needed.

## Missing or incorrect documentation

**IMPORTANT** If during a session you notice that information that the user gives you is missing or outdated in the documentation, suggest to update it.
