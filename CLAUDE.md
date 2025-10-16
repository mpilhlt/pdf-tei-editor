# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## General tone

- Don't be too congratulatory. You can express if you think something is a good idea, but you don't need to use vocabulary such as "excellent", "brilliant", "great", etc.
- If you think there might be a problem with the user's idea, push back. Don't assume the user's ideas are necessarily correct. Ask if you should go with their idea, but also suggest alternatives.

## Quick Reference

### Essential Commands

```bash
# Run only tests for changed files
npm run test:changed

# Run all JavaScript unit tests
npm run test:js

# Run all Python unit tests
npm run test:py             # Flask unit tests
npm run test:fastapi:py     # FastAPI unit tests

# Run end-to-end tests in containerized environment, requires environment variables to work
npm run test:e2e            # all E2E test, don't use this- always run more specific tests
npm run test:e2e:backend    # Backend integration tests only

# Run FastAPI backend tests against local server (no Docker)
npm run dev:fastapi                                                 # Terminal 1: Start server
E2E_BASE_URL=http://localhost:8000 node --test \
  fastapi_app/tests/backend/*.test.js                              # Terminal 2: Run tests

# Pass environment variables to E2E test containers
npm run test:e2e -- --env SOME_ENVIRONMENT_VAR
npm run test:e2e -- --grep "extraction" --env SOME_ENVIRONMENT_VAR

# Use custom .env file for E2E tests
npm run test:e2e -- --dotenv-path .env.testing

```

### Key Files

- Entry point: `app/src/app.js`
- UI elements definitions via `@typedef`: `app/src/ui.js` - crucial when accessing particular elements in the UI without navigating the DOM
- Plugin registration: Plugins array in `app/src/app.js:71-76`
- Plugins: `app/src/plugins.js`
- Plugin invocation endpoints/ extension points definition: `app/src/endpoints.js`
- Application state object definition: `app/src/state.js`

### Key Directories:

Read `prompts/architecture.md` when you need to understand the system design

- `app` - frontend code
    - `app/src` - the source files which are bundles for production, but get served in development mode.
    - `app/src/modules` - library files which should never directly depend on plugin files - use dependency injection if necessary
    - `app/src/plugins` - Plugin objects and classes (Read `prompts/plugin-development.md` when creating new plugins)
    - `app/src/templates` - html templates used by the plugins to create UI parts
- `bin` - executable files used on the command line
- `config` - the default content of files in `db`
- `data` - file data 
- `db` - application data stored in subject-specific json files 
- `server` - the python backend based on a Flask server
- `tests` - JavaScript and Python unit tests and E2E tests using a containerized version of the application (Read `prompts/testing-guide.md` when creating or debuggingtests)


## Detailed Documentation

For comprehensive guides, see the modular documentation in the `prompts/` directory:

- **[Development Commands](prompts/development-commands.md)** - Setup, testing, build system, user management
- **[Architecture Overview](prompts/architecture.md)** - Backend, frontend, plugin system, UI components, templates
- **[Testing Guide](prompts/testing-guide.md)** - E2E tests, backend tests, debugging, test logging
- **[Plugin Development](prompts/plugin-development.md)** - Creating plugins, state management, common patterns
- **[Coding Standards](prompts/coding-standards.md)** - JSDoc requirements, best practices, conventions

## Important Reminders

### Development Workflow

1. **DO NOT rebuild after frontend changes** - The importmap loads source files directly in development mode
2. Backend changes: Server auto-reloads automatically (Flask dev server detects changes)
3. Schema updates: Delete `schema/cache/` to refresh XSD cache
4. Building is only needed for production and is handled by pre-push git hooks

### Critical Rules

- **Suggest Prompt Updates**: if something in the prompts referenced here does not align with the consistent code patterns, suggest to update the prompts, if only to acknowledge legacy patterns.
- **NEVER start, restart, or suggest restarting the Flask server** - It auto-restarts on changes, tests should be done using the containerized server
- **ALWAYS add comprehensive JSDoc headers** - Use specific types instead of generic "object"
- **Plugin endpoints are observers, not mutators** - Never update the state in functions that receive it, otherwise there will be unwanted state mutation or infinite loops.
- **Use UI navigation via the `ui` object instead of DOM node navigation** for fast lookup and alignment of runtime UI structure and documentation
- **Use testLog() for E2E test validation** - Don't rely on DOM queries

### Planning documents and completion reports

If you are asked to create planning documents for complex, multi-phase tasks, only include technically relevant information needed for the implementation or for later reference, e.g. for writing documentation on the new code,

- Omit discussion of the advantages of a particular solution unless specifically asked to discuss pros and cons or provide alternatives in a planning document.
- When migrating code to a new state, do not mention the legacy state unless absolutely necessary (for example, when code is concerns with migration of data) and there is no need to discuss the improvements provided by the new solution. This also applies to writing in-code documentation and comments.
- In completion documents, omit statistical information on the number of changed lines, methods etc. or lists of code changes. Just summarize what the new code does and provide examples if the usage is different from before, so that you can update existing documentation.
