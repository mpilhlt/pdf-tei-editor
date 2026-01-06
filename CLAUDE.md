# CLAUDE.md

This file provides guidance to code assistants when working with code in this repository.

## General tone

- ALWAYS be concise. Only include information that is relevant to the implementation. Omit any kind of motivational or congratulatory language. Do NOT use vocabulary such as "excellent", "brilliant", "great", etc.
- If you think there might be a problem with the user's idea, push back. Don't assume the user's ideas are necessarily correct. Ask if you should go with their idea, but also suggest alternatives.

## Detailed Documentation

For comprehensive guides, see the documentation in the `docs/code-assistant/` directory:

- **[Architecture Overview](docs/code-assistant/architecture.md)** - Backend, frontend, plugin system, UI components, templates
- **[Coding Standards](docs/code-assistant/coding-standards.md)** - JSDoc requirements, best practices, conventions
- **[API Reference](docs/development/api-reference.md) - Existing API documentation for JavaScript, Python and HTTP backend API, including on machine-readable API schemas
- **[Development Commands](docs/code-assistant/development-commands.md)** - Setup, testing, build system, user management
- **[Plugin Development](docs/code-assistant/plugin-development.md)** - Creating frontend plugins, state management, common patterns
- **[CI/CD Pipeline](docs/development/ci-cd-pipeline.md)** - GitHub Actions workflows, test execution, release process
- **[Backend Plugins](docs/code-assistant/backend-plugins.md)** - Creating backend plugins, role-based access, custom routes
- **[Testing Guide](docs/code-assistant/testing-guide.md)** - E2E tests, backend tests, debugging, test logging
- **[CLI](docs/user-manual/cli.md) - Command Line Interface reference
- **[API Client](docs/code-assistant/api-client.md)** - FastAPI client usage, type safety, patterns

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

### Database Access

- **ALWAYS use API methods** from `fastapi_app/lib/file_repository.py`, `fastapi_app/lib/database.py`, and related modules to read and mutate database items
- **AVOID raw SQL queries** except in exceptional cases where no API method exists
- **If a read/write operation is missing**, add it to the appropriate repository/module rather than using ad-hoc SQL
- This prevents breaking changes when the database schema evolves

### Database Migrations

- **ALWAYS use the migration infrastructure** when database schema changes are needed - see [docs/development/migrations.md](docs/development/migrations.md)
- **NEVER modify the database schema directly** - create a versioned migration instead
- Migrations provide automatic backups, rollback support, and version tracking
- See `fastapi_app/lib/migrations/versions/m001_locks_file_id.py` for a complete example
- **When adding a new database**, use the centralized migration runner - see [docs/development/adding-new-databases.md](docs/development/adding-new-databases.md)
  - Call `run_migrations_if_needed()` from `fastapi_app/lib/migration_runner.py` in your database initialization
  - This ensures migrations run automatically on application startup for all databases
- **Migration tests location** - ALWAYS place migration tests in `fastapi_app/lib/migrations/tests/` directory (not in the main test suite). These tests are for manual verification and should not run automatically in CI/CD. Name test files as `test_migration_XXX.py` where XXX is the migration number

### TEI Document Processing

- **ALWAYS use utility functions** from `fastapi_app/lib/tei_utils.py` when working with TEI XML documents
- **Use `extract_tei_metadata()`** to extract metadata (title, authors, DOI, variant, etc.) from TEI documents instead of manual XPath queries
- **Use lxml** (not xml.etree) for TEI processing - it's what `tei_utils.py` uses and ensures consistency
- **Add new utility functions** to `tei_utils.py` when you need TEI processing functionality that doesn't exist yet
- This ensures consistent TEI handling across the codebase and prevents duplication

### User Authentication and Access Control

**Authentication Pattern for Custom Routes:**

When implementing authenticated routes (e.g., plugin routes), use dependency injection:

```python
from fastapi import APIRouter, Depends, Header, Query
from fastapi_app.lib.dependencies import (
    get_auth_manager,
    get_db,
    get_session_manager,
)

@router.get("/endpoint")
async def my_endpoint(
    session_id: str | None = Query(None),
    x_session_id: str | None = Header(None, alias="X-Session-ID"),
    session_manager=Depends(get_session_manager),
    auth_manager=Depends(get_auth_manager),
):
    from fastapi_app.config import get_settings

    # Extract session ID (header takes precedence)
    session_id_value = x_session_id or session_id
    if not session_id_value:
        raise HTTPException(status_code=401, detail="Authentication required")

    # Validate session
    settings = get_settings()
    if not session_manager.is_session_valid(session_id_value, settings.session_timeout):
        raise HTTPException(status_code=401, detail="Invalid or expired session")

    # Get user
    user = auth_manager.get_user_by_session_id(session_id_value, session_manager)
    if not user:
        raise HTTPException(status_code=401, detail="User not found")
```

**Access Control Pattern for Documents/Files:**

Access control is **collection-based**, not direct user-document relationships. Use utility functions from `fastapi_app/lib/user_utils.py`:

```python
from fastapi_app.lib.user_utils import user_has_collection_access

# Check if user has access to a document via its collections
file = file_repo.get_file_by_stable_id(stable_id)
user_has_access = False

for collection_id in file.doc_collections or []:
    if user_has_collection_access(user, collection_id, settings.db_dir):
        user_has_access = True
        break

if not user_has_access:
    raise HTTPException(status_code=403, detail="Access denied")
```

**Key Points:**

- Users access documents through **collection membership**, not direct user-document links
- Use `user_has_collection_access(user, collection_id, db_dir)` to check access to a specific collection
- Use `get_user_collections(user, db_dir)` to get all collections a user can access (returns `None` if user has wildcard access)
- Admin users and users with wildcard (`*`) in their groups have access to all collections
- Import settings with `from fastapi_app.config import get_settings` (not `fastapi_app.lib.settings`)
- See [fastapi_app/routers/files_save.py](fastapi_app/routers/files_save.py) for reference implementation

### Configuration Access

**ALWAYS use the high-level config API** to retrieve configuration values. Do NOT use `ConfigManager` directly.

```python
from fastapi_app.lib.config_utils import get_config

# Get config instance
config = get_config()

# Get configuration values with defaults
value = config.get('annotation.lifecycle.order', default=[])
timeout = config.get('session.timeout', default=3600)
```

**Key Points:**

- Use `get_config()` to get the config instance (lazy initialization)
- Use `config.get(key, default)` to retrieve any configuration value
- The config instance handles initialization and caching automatically
- Never instantiate `ConfigManager` directly - use `get_config()` instead

### Test Filtering: --grep Behavior

**CRITICAL for debugging tests efficiently:**

The `--grep` parameter works **differently** for API vs E2E tests:

- **API tests** (`npm run test:api -- --grep "xxx"`): Matches **file paths**
  - Example: `--grep "files_save"` runs `tests/api/v1/files_save.test.js`
  - Example: `--grep "caching"` runs `tests/api/v1/files_serve_caching.test.js`
  - Use file name patterns when debugging API tests
  - Implementation: backend-test-runner filters files before passing to Node.js

- **E2E tests** (`npm run test:e2e -- --grep "xxx"`): Matches **test names** (test descriptions)
  - Example: `--grep "should upload"` runs all tests with "upload" in the test name
  - Example: `--grep "new version"` runs tests like `test('should create new version', ...)`
  - Use test description patterns when debugging E2E tests
  - Implementation: Playwright receives the grep pattern directly and matches against test descriptions
  - **To run specific test files**, pass file paths as positional arguments: `node tests/e2e-runner.js tests/e2e/tests/auth-workflow.spec.js`

**Quick rule:**

- `*.test.js` (API) → grep by **file path**
- `*.spec.js` (E2E) → grep by **test name** OR pass file paths directly

**Smart test runner:**

The smart-test-runner automatically uses the correct approach:

- For API tests: constructs `--grep` with file path patterns
- For E2E tests: passes test file paths as positional arguments (not via --grep)

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
- **JSDoc type imports** - ALWAYS use separate `@import` blocks for type imports (e.g., `@import { SlMenuItem } from '../ui.js'`), NEVER use inline imports in type annotations (e.g., `@property {import('../ui.js').SlMenuItem}`). This ensures consistency, readability, and proper IDE support
- **Check generated documentation before adding new code** - Before implementing new functionality, ALWAYS check available documentation to prevent reinventing existing APIs: (1) For backend Python: check `docs/api/backend-api.json` for class/function signatures, or read the source module directly; (2) For frontend JavaScript: read the module exports directly; (3) For REST endpoints: check FastAPI docs at `/docs` or the OpenAPI schema. See [docs/development/api-reference.md](docs/development/api-reference.md) for complete documentation overview. If functionality already exists, use it instead of creating duplicates
- **NEVER make up non-existing APIs** - Before using any method on a class or module instance, ALWAYS verify that the method exists with the exact signature you're using. Read the class definition or module exports first. If a needed API doesn't exist, implement it rather than assuming it exists
- **File identifiers on the client** - ALWAYS use `stable_id` (nanoid) when referencing files in client-side code (frontend plugins, HTML output, JavaScript). NEVER use `file_id` (content hash) on the client. The `stable_id` is the permanent identifier for files, while `file_id` is only used internally for storage and deduplication
- **Check testing guide before writing/debugging tests** - ALWAYS consult [docs/code-assistant/testing-guide.md](docs/code-assistant/testing-guide.md) before writing new tests or debugging test failures. It contains critical patterns, helper functions, and known issues (like Shoelace component testing). For Python unit tests of FastAPI routes, see the section on dependency overrides vs @patch decorators
- **Testing authenticated routes** - When writing tests for routes that use `Depends(get_session_manager)` and `Depends(get_auth_manager)`, ALWAYS use `app.dependency_overrides` in `setUp()` to mock these dependencies with valid authentication by default, and include `session_id` parameter in test requests. See [docs/code-assistant/testing-guide.md](docs/code-assistant/testing-guide.md) Authentication Testing Pattern section
- **FastAPI routes must use dependency injection** - ALWAYS use `Depends(get_db)` and `Depends(get_file_storage)` as route parameters, NEVER call `db = get_db()` or `file_storage = get_file_storage()` inside route functions. This enables proper test mocking via `app.dependency_overrides` and prevents CI failures when databases don't exist. See [docs/code-assistant/testing-guide.md](docs/code-assistant/testing-guide.md) for details
- **Check backend plugin guide when creating backend plugins** - ALWAYS consult [docs/code-assistant/backend-plugins.md](docs/code-assistant/backend-plugins.md) before creating or modifying backend plugins. It contains the plugin architecture, patterns, and Shadow DOM handling requirements
- **CI/CD Workflow Changes** - ALWAYS consult [docs/development/ci-cd-pipeline.md](docs/development/ci-cd-pipeline.md) before modifying GitHub Actions workflows. The document describes the test execution strategy, release process, and dependencies between workflows
- **Suppress expected error output in tests** - When tests validate error handling that logs errors or warnings, ALWAYS use `assertLogs` context manager to suppress console output. This keeps test output clean and verifies the error is logged. Example: `with self.assertLogs('module.name', level='ERROR') as cm:` wrapping the code that produces expected errors. Never let expected errors pollute test output.
- **Plugin endpoints are observers, not mutators** - Never update the state in functions that receive it, otherwise there will be unwanted state mutation or infinite loops.
- **Template registration pattern** - ALWAYS register templates at module level using `await registerTemplate('template-name', 'template-file.html')` BEFORE the plugin class definition, then use `createFromTemplate('template-name', parentElement)` in the `install()` method. Never use direct `fetch()` and `insertAdjacentHTML()` - this bypasses the template system and prevents proper logging and UI registration.
- **ALWAYS use UI navigation via the `ui` object** - Never use `querySelector()` or `querySelectorAll()` to access UI elements. Use the `ui` object hierarchy instead (e.g., `ui.toolbar.logoutButton` instead of `ui.toolbar.querySelector('[name="logoutButton"]')`). This ensures alignment with runtime UI structure and documentation
- **UI element hierarchy** - Named elements inside other named elements create a hierarchy. Access nested elements via `ui.parent.child.grandchild`, not `ui.parent.grandchild`. Example: if a checkbox with `name="myCheckbox"` is inside a div with `name="myContainer"`, access it as `ui.parent.myContainer.myCheckbox`. When asked to refactor the UI (i.e., move a button from one location to another), **always** also update references to the UI hierarchy. For example, if during a refactoring, the UI element referenced by `ui.parent.myContainer.myCheckbox` is moved to `ui.parent.otherContainer`, its reference **must** be renamed to `ui.parent.otherContainer.myCheckbox` throughout the application.
- **ALWAYS add UI typedefs for plugin UI elements** - When a plugin adds UI elements, MUST add a `@typedef` documenting the structure (see `app/src/plugins/toolbar.js` for pattern), import it in `app/src/ui.js`, and add the property to the parent typedef (e.g., `toolbarPart`). This enables autocomplete and eliminates need for defensive checks. During refactoring, **always** also update all of the affected typedefs.
- **UI elements are always available after `updateUi()`** - After calling `updateUi()`, assume all UI elements are properly registered in the ui object. NEVER use defensive optional chaining (`ui.foo?.bar`), existence checks (`if (ui.foo)`), or nullish coalescing (`ui.foo ?? fallback`) when accessing UI elements defined in typedefs - if elements are missing, it indicates a logic error that needs fixing. The app should fail hard, not silently continue.
- **Tooltip wrappers don't need names** - SlTooltip components are wrappers and don't need `name` attributes. Only the element inside (like a button) needs a name
- **Programmatic checkbox changes don't fire events** - Setting `checkbox.checked` programmatically does NOT trigger `sl-change` events in Shoelace components. Must manually update state when programmatically changing checkbox states
- **Shoelace dialog button clicks require delay** - ALWAYS add `await page.waitForTimeout(500)` before clicking buttons in Shoelace dialogs. Shoelace dialogs use Shadow DOM and animations, and clicking too quickly results in the click being ignored. See [docs/code-assistant/testing-guide.md](docs/code-assistant/testing-guide.md) for the pattern
- **Use testLog() for E2E test validation** - Don't rely on DOM queries
- **User notifications** - Use `notify(message, variant, icon)` from `app/src/modules/sl-utils.js` for toast notifications. Variants: "primary", "success", "warning", "danger". Common icons: "check-circle", "exclamation-triangle", "exclamation-octagon", "info-circle"
- **Reload file data** - Use `FiledataPlugin.getInstance().reload({ refresh: true })` to reload file data from the server. Import `FiledataPlugin` from `../plugins.js`
- ** when inserting temporary debug logging commands, ALWAYS include `DEBUG` in the message so that these commands can be found and removed later.
- If during debugging you learn something that is not contained in the code assistant documentation, add it to the respective file!
- When asked to create a github issue or other github mainenance issues, use the `gh` tool and ask the user to install it if it is not available
- **GitHub issue closure** - When working on a fix for a GitHub issue, do NOT close the issue manually using `gh issue close`. Instead, include the issue reference in the commit message (e.g., "Fixes #123" or "Closes #157") so that GitHub automatically closes it when the commit is pushed to the default branch. Only use `gh issue comment` to add summary comments if needed.

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

## Backend Plugin Output Pattern

**IMPORTANT: When creating backend plugins that generate HTML or CSV output, ALWAYS use custom routes instead of returning content directly from plugin endpoints.**

### Pattern for HTML/CSV Output

1. **Plugin endpoint returns URLs** (not HTML/CSV content):

   ```python
   async def analyze(self, context, params: dict) -> dict:
       """Return URLs pointing to custom routes."""
       pdf_id = params.get("pdf")
       variant = params.get("variant")

       view_url = f"/api/plugins/my-plugin/view?pdf={pdf_id}&variant={variant}"
       export_url = f"/api/plugins/my-plugin/export?pdf={pdf_id}&variant={variant}"

       return {
           "outputUrl": view_url,    # For HTML view
           "exportUrl": export_url,  # For CSV export
           "pdf": pdf_id,
           "variant": variant
       }
   ```

2. **Custom routes generate content** (in `routes.py`):

   ```python
   @router.get("/view", response_class=HTMLResponse)
   async def view_history(
       pdf: str = Query(...),
       variant: str = Query("all"),
       session_id: str | None = Query(None),
       x_session_id: str | None = Header(None, alias="X-Session-ID"),
       session_manager=Depends(get_session_manager),
       auth_manager=Depends(get_auth_manager),
   ):
       """Generate HTML page with results."""
       # Authenticate user
       # Process data
       # Generate HTML using generate_datatable_page() or custom template
       return HTMLResponse(content=html)

   @router.get("/export")
   async def export_csv(
       pdf: str = Query(...),
       variant: str = Query("all")
   ):
       """Generate CSV export."""
       # Process data
       # Generate CSV
       return StreamingResponse(
           iter([csv_content]),
           media_type="text/csv",
           headers={"Content-Disposition": f"attachment; filename=export.csv"}
       )
   ```

### Why This Pattern

- **Proper authentication**: Routes can use FastAPI's dependency injection for session validation
- **Better script execution**: HTML pages in iframes load JavaScript naturally
- **Separation of concerns**: Plugin coordinates, route generates
- **Reusable utilities**: Use `generate_datatable_page()` from `fastapi_app.lib.plugin_tools`

### Reference Examples

- `fastapi_app/plugins/edit_history/` - Collection-based edit history with DataTables
- `fastapi_app/plugins/annotation_history/` - Document-based annotation history with nested tables

See [docs/code-assistant/backend-plugins.md](docs/code-assistant/backend-plugins.md) for complete documentation.

## Completion documents and summaries

- When told to work on a todo document or github issue, add a summary of what was done at the end of the document or issue comment.
- Omit statistical information on the number of changed lines, methods etc. or lists of code changes. Just summarize what the new code does and provide examples if the usage is different from before, so that you can update existing documentation.
- The summary should be concise and only include information relevant to understanding the implementation. Omit discussion of advantages, alternatives, or motivational language.
- If there were any significant challenges or deviations from the original plan, briefly mention them in a factual manner.
- The goal is to provide a clear understanding of what was implemented without unnecessary detail.
