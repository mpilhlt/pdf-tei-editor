# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Keep in mind this is the FastAPI migration branch, so things could be different than what is written here - see the migration step completion documents in `fastapi_app/prompts`.

## General tone

- ALWAYS be concise. Only include information that is relevant to the implementation. Omit any kind of motivational or congratulatory language. Do NOT use vocabulary such as "excellent", "brilliant", "great", etc.
- If you think there might be a problem with the user's idea, push back. Don't assume the user's ideas are necessarily correct. Ask if you should go with their idea, but also suggest alternatives.

## Quick Reference

### Testing Commands

See [docs/code-assistant/testing-guide.md](docs/code-assistant/testing-guide.md) for complete testing documentation.

```bash
# Run tests for changed files (most common)
npm run test:changed

# Unit tests
npm run test:unit:js          # JavaScript units
npm run test:unit:fastapi     # Python units

# API integration tests (local server, fast)
npm run test:api
npm run test:api -- --grep "save"

# E2E tests (Playwright)
npm run test:e2e
npm run test:e2e:headed       # Show browser
npm run test:e2e:debug        # Step-through debugging

# Container tests (runs all tests inside container)
npm run test:container                           # Run with cache
npm run test:container -- --no-cache             # Rebuild all layers
npm run test:container -- path/to/changed/file.js  # Specific files
npm run test:container -- --browser firefox      # Use specific browser for E2E
npm run test:container -- --browser chromium,firefox,webkit  # Test multiple browsers
```

### Development Commands

```bash
# Start dev server
npm run start:dev

# Build for production
npm run build

# Bypass authentication for development/testing
FASTAPI_ALLOW_ANONYMOUS_ACCESS=true npm run start:dev
```

### Container Commands

```bash
# Build container image locally (Docker/Podman auto-detected)
npm run container:build
npm run container:build -- --tag v1.0.0
npm run container:build:no-cache -- --tag v1.0.0

# Build and push to registry
npm run container:push
npm run container:push -- --tag v1.0.0 --no-build

# Start container
npm run container:start
npm run container:start -- --tag v1.0.0 --port 8080
npm run container:start -- --rebuild              # Rebuild before starting
npm run container:start -- --rebuild --no-cache   # Rebuild without cache

# Stop container
npm run container:stop
npm run container:stop -- --name pdf-tei-editor-v1.0.0 --remove
npm run container:stop -- --all

# Restart container
npm run container:restart
npm run container:restart -- --name pdf-tei-editor-v1.0.0
npm run container:restart -- --rebuild             # Rebuild before restarting

# Run tests in container (CI mode)
npm run test:container                           # Run with cache
npm run test:container -- --no-cache             # Rebuild all layers
npm run test:container -- path/to/file.js        # Run for specific files
```

### Key Files

- Entry point: `app/src/app.js`
- UI elements definitions via `@typedef`: `app/src/ui.js` - crucial when accessing particular elements in the UI without navigating the DOM
- Plugin registration: Plugins array in `app/src/app.js:71-76`
- Plugins: `app/src/plugins.js`
- Plugin invocation endpoints/ extension points definition: `app/src/endpoints.js`
- Application state object definition: `app/src/state.js`

### Key Directories

Read [docs/code-assistant/architecture.md](docs/code-assistant/architecture.md) when you need to understand the system design.

- `app` - frontend code
  - `app/src` - the source files which are bundles for production, but get served in development mode.
  - `app/src/modules` - library files which should never directly depend on plugin files - use dependency injection if necessary
  - `app/src/plugins` - Plugin objects and classes (Read [docs/code-assistant/plugin-development.md](docs/code-assistant/plugin-development.md) when creating new plugins)
  - `app/src/templates` - html templates used by the plugins to create UI parts
- `bin` - executable files used on the command line
- `config` - the default content of files in `data/db`
- `data` - file data
- `data/db` - application data stored in subject-specific json files
- `fastapi_app` - the python backend based on FastAPI
- `tests` - JavaScript and Python unit tests and E2E tests (Read [docs/code-assistant/testing-guide.md](docs/code-assistant/testing-guide.md) when creating or debugging tests)

## Detailed Documentation

For comprehensive guides, see the documentation in the `docs/code-assistant/` directory:

- **[Architecture Overview](docs/code-assistant/architecture.md)** - Backend, frontend, plugin system, UI components, templates
- **[Coding Standards](docs/code-assistant/coding-standards.md)** - JSDoc requirements, best practices, conventions
- **[Development Commands](docs/code-assistant/development-commands.md)** - Setup, testing, build system, user management
- **[Plugin Development](docs/code-assistant/plugin-development.md)** - Creating plugins, state management, common patterns
- **[Testing Guide](docs/code-assistant/testing-guide.md)** - E2E tests, backend tests, debugging, test logging
- **[API Client](docs/code-assistant/api-client.md)** - FastAPI client usage, type safety, patterns

## Important Reminders

### Development Workflow

1. **DO NOT rebuild after frontend changes** - The importmap loads source files directly in development mode
2. Backend changes: Server auto-reloads automatically (FastAPI dev server detects changes)
3. Schema updates: Delete `schema/cache/` to refresh XSD cache
4. Building is only needed for production and is handled by pre-push git hooks

### Critical Rules

- **Command Execution**: ALWAYS use `uv run python` for Python commands and `node` for Node.js commands
- **Suggest Prompt Updates**: if something in the documentation does not align with the consistent code patterns, suggest to update the documentation
- **NEVER start, restart, or suggest restarting the dev server** - It auto-restarts on changes, tests should use the test runners
- **ALWAYS add comprehensive JSDoc headers** - Use specific types instead of generic "object"
- **Plugin endpoints are observers, not mutators** - Never update the state in functions that receive it, otherwise there will be unwanted state mutation or infinite loops.
- **Use UI navigation via the `ui` object instead of DOM node navigation** for fast lookup and alignment of runtime UI structure and documentation
- **Use testLog() for E2E test validation** - Don't rely on DOM queries
- ** when inserting temporary debug logging commands, ALWAYS include `DEBUG` in the message so that these commands can be found and removed later.
- If during debugging you learn something that is not contained in the code assistant documentation, add it to the respective file!

## Planning documents, todo documents, github issues

- If you are asked to create planning documents for complex, multi-phase tasks, only include technically relevant information needed for the implementation or for later reference, e.g. for writing documentation on the new code
- Omit discussion of the advantages of a particular solution unless specifically asked to discuss pros and cons or provide alternatives in a planning document.
- When migrating code to a new state, do not mention the legacy state unless absolutely necessary (for example, when code is concerns with migration of data) and there is no need to discuss the improvements provided by the new solution. This also applies to writing in-code documentation and comments.

## Commit messages and contributing best practices

- When asked to document best practices for contributors, add information to [docs/development/contributing.md](docs/development/contributing.md)
- This includes commit message conventions, code quality requirements, pull request guidelines, testing requirements, and release processes
- Use conventional commit format: `<type>: <description>` where type is feat, fix, docs, refactor, test, or chore

## Completion documents and summaries

- When told to work on a todo document or github issue, add a summary of what was done at the end of the document or issue comment.
- Omit statistical information on the number of changed lines, methods etc. or lists of code changes. Just summarize what the new code does and provide examples if the usage is different from before, so that you can update existing documentation.
- The summary should be concise and only include information relevant to understanding the implementation. Omit discussion of advantages, alternatives, or motivational language.
- If there were any significant challenges or deviations from the original plan, briefly mention them in a factual manner.
- The goal is to provide a clear understanding of what was implemented without unnecessary detail.
