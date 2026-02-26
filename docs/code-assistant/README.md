# Code Assistant Documentation

This directory contains concise technical documentation for AI code assistants (Claude Code and similar tools) working with the PDF-TEI Editor codebase.

## Purpose

These guides provide:

- Quick reference for common tasks
- Implementation rules and patterns
- Anti-patterns to avoid
- Links to comprehensive developer documentation for details

## Available Guides

### [architecture-frontend.md](./architecture-frontend.md)

Frontend architecture including:

- Frontend structure (ES modules, plugin system)
- Plugin types (objects vs classes)
- UI component system
- Template registration

### [architecture-backend.md](./architecture-backend.md)

Backend architecture including:

- FastAPI application structure
- `lib/` directory organization by domain
- Module dependency hierarchy
- Common import patterns

### [database-connections.md](./database-connections.md)

SQLite connection management details:

- Connection pooling and WAL mode
- Transaction handling and locking

### [coding-standards.md](./coding-standards.md)

Code quality rules and conventions:

- JSDoc type annotation requirements (CRITICAL)
- Python development patterns
- Frontend development patterns (Shoelace, debugging)
- General code conventions

### [development-commands.md](./development-commands.md)

Command reference for common tasks:

- Development server commands
- Build system
- Testing commands
- User and configuration management
- Development workflow

### [plugin-development.md](./plugin-development.md)

Plugin creation and state management:

- Creating plugin classes
- Plugin registration
- State management rules (immutable state)
- Common patterns and anti-patterns
- Legacy plugin object migration

### [testing-guide.md](./testing-guide.md)

Testing practices and patterns:

- Test structure and types
- Writing API and E2E tests
- Using helper functions (CRITICAL)
- Debugging tests
- Backend authentication requirements

### [api-client.md](./api-client.md)

FastAPI client usage patterns:

- Using the generated client
- Client regeneration
- Dependency injection pattern
- Type safety with JSDoc
- Manual implementation for uploads/SSE

## Quick Start

When working on this codebase:

1. **Read [coding-standards.md](./coding-standards.md) first** - Critical JSDoc requirements
2. **Check [architecture-frontend.md](./architecture-frontend.md)** - Understand the plugin system
3. **Check [architecture-backend.md](./architecture-backend.md)** - Understand the backend structure
4. **Reference [development-commands.md](./development-commands.md)** - Run tests and commands
5. **Follow [plugin-development.md](./plugin-development.md)** - When creating/modifying plugins
6. **Use [testing-guide.md](./testing-guide.md)** - When writing tests
7. **Consult [api-client.md](./api-client.md)** - When working with backend API

## Key Principles

### Critical Rules

1. **JSDoc annotations are mandatory** - Use specific types, not generic `object`
2. **Never mutate state** - Always use `dispatchStateChange()`
3. **Use helper functions** - Never reimplement auth or test utilities
4. **Don't restart dev server** - It auto-restarts on changes
5. **Check code first** - Don't assume; verify implementation

### State Management

- Plugin endpoints are **observers, not mutators**
- Never call `updateState()` in endpoints that receive state
- Use `onStateUpdate()` for reactions, not state.update
- Store plugin-specific state in `state.ext`

### Testing

- Always add `@testCovers` annotations
- Use existing helper functions from `tests/*/helpers/`
- API tests run locally (fast iteration)
- E2E tests use local server by default
- Clean up locks and resources in test cleanup

### Frontend Development

- Shoelace components must be registered in `app/src/ui.js`
- Use `window.ui` navigation in E2E tests
- Prefix debug logging with "DEBUG" for easy cleanup
- Templates must be registered at module level

## Related Documentation

For comprehensive information, see:

- **[../development/](../development/)** - Detailed developer documentation
- **[../user-manual/](../user-manual/)** - End-user documentation
- **[CLAUDE.md](../../CLAUDE.md)** - Project-specific instructions for Claude Code

## Contributing to Documentation

When updating code assistant documentation:

1. Keep it concise - link to comprehensive docs for details
2. Focus on rules and patterns, not explanations
3. Include anti-patterns (what NOT to do)
4. Provide code examples for clarity
5. Update this README if adding new guides
