# Consolidate documentation

Currently, the documentation for the FastAPI application is scattered across multiple files and formats. This task involves consolidating all relevant documentation into a single, well-organized format to improve accessibility and maintainability.

Current documentation sources include:

- Markdown files in the `docs/` directory
- Prompts in the `prompts/` directory (document the Flask-based implementation)
- Prompts in the fastapi_app/prompts/ directory (document the FastAPI-based implementation)

Goal:

- consolidate all documentation facing end-users, developers, and code assistants in separate directories below the "docs/" directory
  - `docs/user-manual/` for end-user documentation. This should concentrate on concrete usage instructions, feature descriptions. Avoid including implementation details or developer-focused content. Do not discuss the advantages of particular features unless it is necessary for user understanding. Omit any content that is not directly relevant to end-users. Do not describe usage in general terms; focus on specific, actionable instructions as far as you know about the UI. You can use the the `@typedef` which specify the UI structure (starting in `app/src/ui.js`), the templates in `app/src/templates` and the E2E tests in `tests/e2e/tests` to infer end-user workflows. However, if you don't know the specifics, don't include anything speculative, don't attempt to fill in gaps with assumptions, rather add "to be completed" notes where necessary.
  - `docs/development/` for developer documentation: this should be helpful information on architecture, design decisions, API references, and setup instructions - it should avoid redundancy with the code assistant documentation by focusing on higher-level concepts and implementation details. Do not include basic usage instructions that are already covered in the end-user documentation. Do not talk about the advantages of a particular feature unless it is necessary for understanding the implementation. Omit any content that is not directly relevant to developers working on the codebase.
  - `docs/code-assistant/` for code assistant prompts and related documentation: this section should only have concise technical details necessary for understanding and utilizing the prompts effectively and should link to the dveloper documentation for more in-depth information wherever applicable to avoid redundancy - it should focus on implementation rules, practical usage, and examples for patterns and anti-patterns.
  - `docs/images/` for any images used in the documentation
- the landing page `docs/index.md` should provide an overview of the documentation structure and guide users to the appropriate sections based on their needs. No need to reference the code-assistant documents - they should be referenced in CLAUDE.md
- update CLAUDE.md where it is not longer up-to-date and link to the code-assistant documents where applicable. 
- README.md in the project root should be updated to reflect the new documentation structure and provide links to the consolidated documentation, providing only miminal information that does not change frequently plus a "quickstart" section

- ensure that all links within the documentation are updated to reflect the new structure
- review and update the content to ensure consistency in style, formatting, and terminology across all documentation sections
- You will find information that applies to the Flask server and does no longer apply. When you find inconsistencies, You MUST ALWAYS check the code or ask me. Do not manke your own assumptions.

## Documentation Structure Plan

### docs/code-assistant/

This directory will contain concise technical documentation for code assistants (Claude Code and similar tools).

**New files to create:**

1. **architecture.md** - Core system architecture patterns
   - Source: `prompts/architecture.md` (migrate and condense)
   - Focus: Plugin system, state management, frontend/backend structure
   - Link to `docs/development/architecture.md` for details

2. **coding-standards.md** - Code quality rules and conventions
   - Source: `prompts/coding-standards.md` (migrate)
   - Focus: JSDoc requirements, naming conventions, anti-patterns

3. **development-commands.md** - Command reference
   - Source: `prompts/development-commands.md` (migrate)
   - Focus: Testing, building, user management commands

4. **plugin-development.md** - Plugin creation rules
   - Source: `prompts/plugin-development.md` (migrate)
   - Focus: Plugin patterns, state management, endpoint usage

5. **testing-guide.md** - Testing practices
   - Source: `prompts/testing-guide.md` (migrate)
   - Focus: Test structure, E2E patterns, debugging approaches

6. **api-client.md** - API client usage patterns
   - Source: `fastapi_app/prompts/api-client-usage.md` (migrate)
   - Focus: FastAPI client patterns, type safety

7. **README.md** - Code assistant docs index
   - New file
   - Overview of available prompts and when to use them

**Files to keep in prompts/ for historical reference:**
- `prompts/plans/` - Migration planning documents (historical)
- `fastapi_app/prompts/phase-*.md` - Migration completion reports (historical)
- `fastapi_app/prompts/todo/` - Current development tasks (active)

### docs/development/

This directory will contain comprehensive developer documentation.

**Files to create/update:**

1. **architecture.md** - Detailed architecture documentation
   - Source: Expand from `prompts/architecture.md` + `docs/development.md`
   - Content: Complete system design, data flow, component interactions
   - Add FastAPI-specific architecture from migration docs

2. **plugin-system.md** - Plugin architecture deep dive
   - Source: Extract from `docs/development.md` + `prompts/plugin-development.md`
   - Content: Plugin lifecycle, dependency resolution, endpoint system

3. **state-management.md** - Application state patterns
   - Source: Extract from `docs/development.md` + `prompts/architecture.md`
   - Content: Immutable state, update patterns, debugging

4. **access-control.md** - Access control implementation
   - Source: Keep and enhance `docs/development/access-control.md`
   - Content: RBAC system, permission model, implementation

5. **collections.md** - Collection system architecture
   - Source: Keep and enhance `docs/development/collections.md`
   - Content: Collection management, data structures

6. **testing.md** - Testing infrastructure
   - Source: Expand from `docs/testing.md`
   - Content: Test architecture, fixtures, CI/CD integration

7. **api-reference.md** - FastAPI endpoints
   - Source: New file based on FastAPI app structure
   - Content: Endpoint documentation, request/response schemas

8. **installation.md** - Development setup
   - Source: `docs/installation.md` (move here)
   - Content: Prerequisites, setup steps, troubleshooting

9. **deployment.md** - Deployment guide
   - Source: `docs/deployment.md` (move here)
   - Content: Docker, production setup, configuration

10. **configuration.md** - Configuration system
    - Source: `docs/configuration.md` (move here)
    - Content: Config files, environment variables, settings

11. **database.md** - Database architecture
    - Source: Extract from `fastapi_app/prompts/database-config-setup.md`
    - Content: SQLite structure, migrations, config system

12. **validation.md** - XML/TEI validation system
    - Source: `docs/xml-validation.md` (move here)
    - Content: Schema validation, autocomplete, RelaxNG

13. **README.md** - Developer docs index
    - New file
    - Overview and navigation for developers

### docs/user-manual/

This directory will contain end-user documentation.

**Files to create/update:**

1. **getting-started.md** - First-time user guide
   - Source: Extract from `docs/index.md` + `docs/interface-overview.md`
   - Content: Login, basic navigation, first workflow

2. **interface-overview.md** - UI component reference
   - Source: Refine `docs/interface-overview.md`
   - Content: Toolbar, panels, menus, shortcuts

3. **extraction-workflow.md** - PDF extraction guide
   - Source: Refine `docs/extraction-workflow.md`
   - Content: Step-by-step extraction process

4. **editing-workflow.md** - TEI editing guide
   - Source: Refine `docs/editing-workflow.md`
   - Content: XML editing, validation, auto-completion

5. **sync-workflow.md** - WebDAV synchronization
   - Source: Refine `docs/sync-workflow.md`
   - Content: Sync setup, conflict resolution

6. **merging-workflow.md** - Document merging
   - Source: Refine `docs/merging-workflow.md`
   - Content: Branch comparison, merge operations

7. **collection-management.md** - Managing collections
   - Source: Refine `docs/collection-management.md`
   - Content: Creating, organizing, sharing collections

8. **access-control.md** - Permission management
   - Source: Refine `docs/doc-access-control.md`
   - Content: Document ownership, sharing, permissions

9. **user-management.md** - Account management (admin)
   - Source: Refine `docs/user-management.md`
   - Content: Creating users, roles, password management

10. **testdrive-docker.md** - Quick Docker setup
    - Source: `docs/testdrive-docker.md` (move here)
    - Content: Docker quick start, demo mode

11. **README.md** - User manual index
    - New file
    - Navigation for end users

### Root documentation files

1. **docs/index.md** - Main documentation landing page
   - Update to guide users to manual/development/code-assistant sections
   - Remove redundant content now in subdirectories

2. **docs/about.md** - Project background
   - Keep as-is (general project information)

3. **README.md** - Project root readme
   - Update to minimal info + quickstart
   - Link to docs/index.md for full documentation

**Files to remove:**
- `docs/authentication.md` (merge into user-manual/getting-started.md)
- `docs/pdf-workflow.md` (merge into user-manual/extraction-workflow.md)
- `docs/development.md` (split into development/ subdirectory)
- `docs/testing.md` (move to development/testing.md)
- `docs/installation.md` (move to development/installation.md)
- `docs/deployment.md` (move to development/deployment.md)
- `docs/configuration.md` (move to development/configuration.md)
- `docs/xml-validation.md` (move to development/validation.md)
- `docs/user-management.md` (move to user-manual/user-management.md)
- `docs/collection-management.md` (move to user-manual/collection-management.md)
- `docs/doc-access-control.md` (move to user-manual/access-control.md)

## Implementation Report

### Phase 1: Code Assistant Documentation ✅ COMPLETED

**Date**: 2025-11-28
**Status**: Fully implemented

Created 7 files in `docs/code-assistant/`:

1. **architecture.md** - Core system architecture patterns
   - Updated Flask → FastAPI references
   - Condensed from prompts/architecture.md
   - Links to comprehensive developer docs

2. **coding-standards.md** - Code quality rules and conventions
   - JSDoc requirements (CRITICAL)
   - Python and frontend development patterns
   - Removed Flask-specific references

3. **development-commands.md** - Command reference
   - Verified commands against package.json
   - Updated to FastAPI-specific commands
   - Critical reminders for code assistants

4. **plugin-development.md** - Plugin creation guide
   - State management patterns and rules
   - Common patterns and anti-patterns
   - Migration guidance from legacy patterns

5. **testing-guide.md** - Testing practices
   - Test structure and helper function usage
   - API vs E2E test patterns
   - Backend authentication requirements

6. **api-client.md** - FastAPI client usage patterns
   - Generated client usage
   - Type safety with JSDoc
   - Manual implementation for uploads/SSE

7. **README.md** - Code assistant docs index
   - Overview and navigation
   - When to use each guide
   - Key principles summary

**Updated Files**:
- **CLAUDE.md** - Updated all references to point to docs/code-assistant/
  - Removed Flask references
  - Updated to FastAPI terminology
  - Fixed outdated directory references

**Verification**:
- All Flask references replaced with FastAPI ✅
- Commands verified against actual package.json ✅
- Backend structure verified (fastapi_app/, not server/) ✅
- Links tested for consistency ✅

### Phase 2: Developer Documentation ✅ COMPLETED

**Date**: 2025-11-28
**Status**: 13 of 13 tasks completed

**Completed**:
1. ✅ **development/architecture.md** - Comprehensive architecture overview
2. ✅ **development/plugin-system.md** - Plugin architecture, PluginManager, endpoints, lifecycle
3. ✅ **development/state-management.md** - Immutable state, StateManager, update flows
4. ✅ **development/installation.md** - Moved from docs/
5. ✅ **development/deployment.md** - Moved from docs/
6. ✅ **development/configuration.md** - Moved from docs/, fixed db/ → data/db/ paths
7. ✅ **development/validation.md** - Moved from docs/xml-validation.md
8. ✅ **development/testing.md** - Moved from docs/
9. ✅ **development/access-control.md** - Enhanced with RBAC Manager section
10. ✅ **development/collections.md** - Enhanced with cross-references
11. ✅ **development/database.md** - Database architecture, SQLite schema, repositories
12. ✅ **development/api-reference.md** - Complete FastAPI endpoint reference
13. ✅ **development/README.md** - Comprehensive index and navigation guide
14. ✅ **All internal links updated** - Fixed xml-validation.md → validation.md reference

## Todo List

### Phase 1: Code Assistant Documentation (docs/code-assistant/) ✅ COMPLETED

- [x] Create docs/code-assistant/ directory
- [x] Migrate architecture.md from prompts/ (condense, link to dev docs)
- [x] Migrate coding-standards.md from prompts/
- [x] Migrate development-commands.md from prompts/
- [x] Migrate plugin-development.md from prompts/
- [x] Migrate testing-guide.md from prompts/
- [x] Migrate api-client.md from fastapi_app/prompts/
- [x] Create code-assistant/README.md index
- [x] Update CLAUDE.md to reference docs/code-assistant/

### Phase 2: Developer Documentation (docs/development/) ✅ COMPLETED (13/13)

- [x] Create comprehensive development/architecture.md (merge sources)
- [x] Extract and create development/plugin-system.md
- [x] Extract and create development/state-management.md
- [x] Move installation.md to development/
- [x] Move deployment.md to development/
- [x] Move configuration.md to development/
- [x] Move xml-validation.md to development/validation.md
- [x] Move and expand testing.md to development/
- [x] Enhance development/access-control.md (existing)
- [x] Enhance development/collections.md (existing)
- [x] Create development/api-reference.md from FastAPI code
- [x] Create development/database.md from migration docs
- [x] Create development/README.md index
- [x] Update all internal links in developer docs

### Phase 3: End-User Manual (docs/user-manual/) ✅ COMPLETED

**Date**: 2025-11-28
**Status**: 13 of 13 tasks completed

**Completed**:
1. ✅ **user-manual/getting-started.md** - Created comprehensive getting started guide
2. ✅ **user-manual/interface-overview.md** - Moved from docs/
3. ✅ **user-manual/extraction-workflow.md** - Moved from docs/
4. ✅ **user-manual/editing-workflow.md** - Moved from docs/
5. ✅ **user-manual/sync-workflow.md** - Moved from docs/
6. ✅ **user-manual/merging-workflow.md** - Moved from docs/
7. ✅ **user-manual/collection-management.md** - Moved from docs/
8. ✅ **user-manual/access-control.md** - Moved from docs/doc-access-control.md
9. ✅ **user-manual/user-management.md** - Moved from docs/
10. ✅ **user-manual/testdrive-docker.md** - Moved from docs/
11. ✅ **user-manual/README.md** - Comprehensive user manual index
12. ✅ **docs/index.md updated** - Main landing page with three-tier structure
13. ✅ **Renamed manual/ → user-manual/** - Updated all links throughout documentation

**Notes**:
- All user-facing documentation now organized in docs/user-manual/
- Created getting-started.md combining authentication + workflow intro
- Updated main landing page to clearly separate user, developer, and code-assistant docs
- User manual README provides task-based navigation
- All references updated from manual/ to user-manual/ for consistency

### Phase 4: Root Documentation & Cleanup ✅ COMPLETED

**Date**: 2025-11-28
**Status**: 6 of 6 tasks completed

**Completed**:
1. ✅ **docs/index.md updated** - Main landing page with three-tier structure
2. ✅ **README.md updated** - Minimal, stable content with quickstart and links to docs
3. ✅ **Obsolete files removed** - authentication.md, pdf-workflow.md, development.md
4. ✅ **cli.md moved** - Moved to user-manual/ and added to index
5. ✅ **Image paths fixed** - Updated all user-manual image paths to ../images/
6. ✅ **Cross-references verified** - All internal links updated and working

**Notes**:
- README.md now contains only stable information (quick start, key features, tech stack)
- All documentation paths updated from manual/ to user-manual/
- Image paths in user-manual/ corrected to use relative paths (../images/)
- Obsolete documentation files removed from docs/ root
- CLI reference added to user-manual documentation index
