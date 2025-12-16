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
npm run start:dev -- --restart    # Kill running server and restart

# Reset application (move data/log to trash)
npm run dev:reset                 # Reset only
npm run dev:reset -- --restart    # Reset and restart server

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
npm run container:build -- --tag v1.0.0 --yes  # Skip confirmation

# Build and push to registry
npm run container:push
npm run container:push -- --tag v1.0.0 --no-build
npm run container:push -- --tag v1.0.0 --yes  # Skip confirmation

# Start container
npm run container:start
npm run container:start -- --tag v1.0.0 --port 8080
npm run container:start -- --env GEMINI_API_KEY --env LOG_LEVEL=WARNING
npm run container:start -- --rebuild              # Rebuild before starting
npm run container:start -- --rebuild --no-cache   # Rebuild without cache

# Stop container
npm run container:stop
npm run container:stop -- --name pdf-tei-editor-v1.0.0 --remove
npm run container:stop -- --all

# Restart container
npm run container:restart
npm run container:restart -- --name pdf-tei-editor-v1.0.0
npm run container:restart -- --env GEMINI_API_KEY
npm run container:restart -- --rebuild             # Rebuild before restarting

# Deploy container with nginx/SSL (requires sudo)
sudo npm run container:deploy -- --fqdn editor.example.com
sudo npm run container:deploy -- --fqdn editor.example.com --data-dir /opt/pdf-tei-editor/data
sudo npm run container:deploy -- --fqdn demo.example.com --type demo
npm run container:deploy -- --fqdn test.local --no-nginx --no-ssl  # No sudo needed
GEMINI_API_KEY=key sudo npm run container:deploy -- --fqdn app.example.com --env GEMINI_API_KEY
sudo npm run container:deploy -- --fqdn app.example.com --env GEMINI_API_KEY=key --env LOG_LEVEL=WARNING
sudo npm run container:deploy -- --fqdn app.example.com --data-dir /opt/pdf-tei-editor/data --yes  # Skip confirmation

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

### Application State

The application state object is defined in `app/src/state.js` and contains:

- `sessionId`: Session ID for API authentication (available after login, passed as `X-Session-ID` header value or query parameter for authentication with the endpoints)

### Database Access

- **ALWAYS use API methods** from `fastapi_app/lib/file_repository.py`, `fastapi_app/lib/database.py`, and related modules to read and mutate database items
- **AVOID raw SQL queries** except in exceptional cases where no API method exists
- **If a read/write operation is missing**, add it to the appropriate repository/module rather than using ad-hoc SQL
- This prevents breaking changes when the database schema evolves

### TEI Document Processing

- **ALWAYS use utility functions** from `fastapi_app/lib/tei_utils.py` when working with TEI XML documents
- **Use `extract_tei_metadata()`** to extract metadata (title, authors, DOI, variant, etc.) from TEI documents instead of manual XPath queries
- **Use lxml** (not xml.etree) for TEI processing - it's what `tei_utils.py` uses and ensures consistency
- **Add new utility functions** to `tei_utils.py` when you need TEI processing functionality that doesn't exist yet
- This ensures consistent TEI handling across the codebase and prevents duplication

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
- `data/db` - application data stored in subject-specific json files and SQLite databases
  - `data/db/metadata.db` - Main file metadata database (SQLite) - ALWAYS use this for file queries, NOT files.db
- `fastapi_app` - the python backend based on FastAPI
- `tests` - JavaScript and Python unit tests and E2E tests (Read [docs/code-assistant/testing-guide.md](docs/code-assistant/testing-guide.md) when creating or debugging tests)

## Detailed Documentation

For comprehensive guides, see the documentation in the `docs/code-assistant/` directory:

- **[Architecture Overview](docs/code-assistant/architecture.md)** - Backend, frontend, plugin system, UI components, templates
- **[Coding Standards](docs/code-assistant/coding-standards.md)** - JSDoc requirements, best practices, conventions
- **[Development Commands](docs/code-assistant/development-commands.md)** - Setup, testing, build system, user management
- **[Plugin Development](docs/code-assistant/plugin-development.md)** - Creating frontend plugins, state management, common patterns
- **[Backend Plugins](docs/code-assistant/backend-plugins.md)** - Creating backend plugins, role-based access, custom routes
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
- **NEVER make up non-existing APIs** - Before using any method on a class or module instance, ALWAYS verify that the method exists with the exact signature you're using. Read the class definition or module exports first. If a needed API doesn't exist, implement it rather than assuming it exists
- **File identifiers on the client** - ALWAYS use `stable_id` (nanoid) when referencing files in client-side code (frontend plugins, HTML output, JavaScript). NEVER use `file_id` (content hash) on the client. The `stable_id` is the permanent identifier for files, while `file_id` is only used internally for storage and deduplication
- **Check testing guide before writing/debugging tests** - ALWAYS consult [docs/code-assistant/testing-guide.md](docs/code-assistant/testing-guide.md) before writing new tests or debugging test failures. It contains critical patterns, helper functions, and known issues (like Shoelace component testing)
- **Check backend plugin guide when creating backend plugins** - ALWAYS consult [docs/code-assistant/backend-plugins.md](docs/code-assistant/backend-plugins.md) before creating or modifying backend plugins. It contains the plugin architecture, patterns, and Shadow DOM handling requirements
- **Suppress expected error output in tests** - When tests validate error handling that logs errors or warnings, ALWAYS use `assertLogs` context manager to suppress console output. This keeps test output clean and verifies the error is logged. Example: `with self.assertLogs('module.name', level='ERROR') as cm:` wrapping the code that produces expected errors. Never let expected errors pollute test output.
- **Plugin endpoints are observers, not mutators** - Never update the state in functions that receive it, otherwise there will be unwanted state mutation or infinite loops.
- **Template registration pattern** - ALWAYS register templates at module level using `await registerTemplate('template-name', 'template-file.html')` BEFORE the plugin class definition, then use `createFromTemplate('template-name', parentElement)` in the `install()` method. Never use direct `fetch()` and `insertAdjacentHTML()` - this bypasses the template system and prevents proper logging and UI registration.
- **ALWAYS use UI navigation via the `ui` object** - Never use `querySelector()` or `querySelectorAll()` to access UI elements. Use the `ui` object hierarchy instead (e.g., `ui.toolbar.logoutButton` instead of `ui.toolbar.querySelector('[name="logoutButton"]')`). This ensures alignment with runtime UI structure and documentation
- **ALWAYS add UI typedefs for plugin UI elements** - When a plugin adds UI elements, MUST add a `@typedef` documenting the structure (see `app/src/plugins/toolbar.js` for pattern), import it in `app/src/ui.js`, and add the property to the parent typedef (e.g., `toolbarPart`). This enables autocomplete and eliminates need for defensive checks
- **UI elements are always available after `updateUi()`** - After calling `updateUi()`, assume all UI elements are properly registered in the ui object. NEVER use defensive optional chaining (`ui.foo?.bar`), existence checks (`if (ui.foo)`), or nullish coalescing (`ui.foo ?? fallback`) when accessing UI elements defined in typedefs - if elements are missing, it indicates a logic error that needs fixing. The app should fail hard, not silently continue
- **UI element hierarchy** - Named elements inside other named elements create a hierarchy. Access nested elements via `ui.parent.child.grandchild`, not `ui.parent.grandchild`. Example: if a checkbox with `name="myCheckbox"` is inside a div with `name="myContainer"`, access it as `ui.parent.myContainer.myCheckbox`
- **Tooltip wrappers don't need names** - SlTooltip components are wrappers and don't need `name` attributes. Only the element inside (like a button) needs a name
- **Programmatic checkbox changes don't fire events** - Setting `checkbox.checked` programmatically does NOT trigger `sl-change` events in Shoelace components. Must manually update state when programmatically changing checkbox states
- **Use testLog() for E2E test validation** - Don't rely on DOM queries
- **User notifications** - Use `notify(message, variant, icon)` from `app/src/modules/sl-utils.js` for toast notifications. Variants: "primary", "success", "warning", "danger". Common icons: "check-circle", "exclamation-triangle", "exclamation-octagon", "info-circle"
- **Reload file data** - Use `FiledataPlugin.getInstance().reload({ refresh: true })` to reload file data from the server. Import `FiledataPlugin` from `../plugins.js`
- ** when inserting temporary debug logging commands, ALWAYS include `DEBUG` in the message so that these commands can be found and removed later.
- If during debugging you learn something that is not contained in the code assistant documentation, add it to the respective file!

## Planning documents, todo documents, github issues

### Standard Feature Implementation Workflow

When implementing a new feature, follow this workflow:

1. **Create implementation plan** in `dev/todo/<feature-name>-implementation.md`
   - Document technical requirements and API endpoints
   - List UI components to add
   - Outline implementation steps
   - Include code examples for key patterns
2. **Work on the implementation** following the plan
3. **Document results** in the same plan document under "Implementation Progress"
   - List completed changes with file references and line numbers
   - Document key implementation details and patterns used
   - Include lessons learned for future reference

### Planning Document Content

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
