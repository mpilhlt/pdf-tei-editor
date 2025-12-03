# Developer Documentation

Welcome to the PDF-TEI Editor developer documentation. This directory contains comprehensive technical documentation for developers working on the codebase.

## Quick Start

New to the project? Start here:

1. **[Installation](installation.md)** - Set up your development environment
2. **[Architecture Overview](architecture.md)** - Understand the system design
3. **[Testing](testing.md)** - Run and write tests

## Core Documentation

### System Architecture

- **[Architecture Overview](architecture.md)** - Complete system architecture, technology stack, data flow
- **[Plugin System](plugin-system.md)** - Plugin architecture, PluginManager, endpoints, lifecycle
- **[State Management](state-management.md)** - Immutable state architecture, StateManager, update flows
- **[Database](database.md)** - SQLite schema, file metadata, storage architecture

### Backend (FastAPI)

- **[API Reference](api-reference.md)** - Complete REST API endpoint documentation
- **[Database](database.md)** - Database schema, repositories, Pydantic models
- **[Access Control](access-control.md)** - RBAC system, collection-based permissions
- **[Collections](collections.md)** - Collection management and document organization

### Frontend (JavaScript/ES Modules)

- **[Plugin System](plugin-system.md)** - Creating plugins, endpoint system, dependency management
- **[State Management](state-management.md)** - Immutable state patterns, reactive updates
- **[Architecture](architecture.md#frontend-architecture)** - UI components, templates, build system

### Development Operations

- **[Installation](installation.md)** - Development setup, prerequisites, troubleshooting
- **[Configuration](configuration.md)** - Configuration files, CLI commands, settings management
- **[Testing](testing.md)** - Testing infrastructure, API tests, E2E tests, debugging
- **[Deployment](deployment.md)** - Production deployment, Docker, configuration
- **[Validation](validation.md)** - XML/TEI schema validation, autocomplete system

## Documentation by Topic

### Getting Started

| Document | What You'll Learn |
|----------|-------------------|
| [Installation](installation.md) | How to set up your development environment |
| [Architecture](architecture.md) | How the system is structured and organized |
| [Configuration](configuration.md) | How to configure the application |

### Building Features

| Document | What You'll Learn |
|----------|-------------------|
| [Plugin System](plugin-system.md) | How to create new frontend plugins |
| [API Reference](api-reference.md) | Available backend endpoints and how to use them |
| [Database](database.md) | How to work with file metadata and storage |
| [State Management](state-management.md) | How to manage application state correctly |

### Security & Access

| Document | What You'll Learn |
|----------|-------------------|
| [Access Control](access-control.md) | How RBAC and collection permissions work |
| [Collections](collections.md) | How documents are organized and accessed |

### Quality & Deployment

| Document | What You'll Learn |
|----------|-------------------|
| [Testing](testing.md) | How to write and run tests |
| [Validation](validation.md) | How XML validation and autocomplete work |
| [Deployment](deployment.md) | How to deploy to production |

## Common Tasks

### Adding a New Feature

1. Read [Architecture Overview](architecture.md) to understand the system
2. For frontend: Review [Plugin Development Guide](../code-assistant/plugin-development.md)
3. For backend: Review [API Reference](api-reference.md) and [Database](database.md)
4. Write tests following [Testing Guide](testing.md)
5. Update documentation

### Debugging Issues

1. Check [Testing Guide](testing.md#debugging) for debugging techniques
2. Review [State Management](state-management.md#debugging-state) for state-related issues
3. Check [Architecture](architecture.md) for system flow understanding
4. Use [API Reference](api-reference.md) to verify endpoint behavior

### Understanding Data Flow

1. Start with [Architecture Overview](architecture.md#data-flow)
2. Review [State Management](state-management.md#state-update-flow)
3. Check [Database](database.md#query-patterns) for data persistence
4. See [Plugin System](plugin-system.md#plugin-loading) for plugin lifecycle

### Working with Permissions

1. Read [Access Control](access-control.md) for RBAC system
2. Review [Collections](collections.md) for collection management
3. Check [Database](database.md#metadata-inheritance) for metadata inheritance
4. See [API Reference](api-reference.md#collections-api) for collection endpoints

## Key Concepts

### Plugin Architecture

The application uses a plugin-based architecture where all functionality is implemented as plugins. See [Plugin System](plugin-system.md) for details.

**Key Points:**
- Plugins can be classes (modern) or objects (legacy)
- Dependency resolution via topological sorting
- Endpoint system for extensibility
- Automatic state management for Plugin classes

### Immutable State

All state changes create new objects, never mutate existing state. See [State Management](state-management.md) for details.

**Key Points:**
- Use `dispatchStateChange()` or `updateState()` for changes
- Never update state in observer endpoints like `onStateUpdate`
- State history maintained via WeakMap
- Change detection for efficient reactive updates

### Document-Centric Storage

Files are organized around documents, with PDF files storing metadata and TEI files inheriting via `doc_id`. See [Database](database.md) for details.

**Key Points:**
- PDF files store `doc_collections` and `doc_metadata`
- TEI files inherit metadata from PDF via JOIN
- Content-addressable storage using SHA-256 hashes
- Soft deletes for sync tracking

### Collection-Based Access

Users access documents through collection membership. See [Access Control](access-control.md) for details.

**Key Points:**
- Users belong to groups
- Groups have access to collections
- Documents belong to collections
- Wildcard support for admin access

## Technology Stack

### Backend

- **Framework**: FastAPI 0.100+
- **Database**: SQLite 3.x with WAL mode
- **Python**: 3.13+ managed via `uv`
- **Validation**: lxml for XML/TEI schema validation

### Frontend

- **Module System**: ES6 modules with importmap
- **UI Components**: Shoelace web components
- **Editors**: CodeMirror 6 (XML), PDF.js (viewer)
- **Build**: Rollup for production bundling

### Development

- **Testing**: Playwright (E2E), pytest (backend), Node.js native test runner (API)
- **Version Control**: Git with Husky pre-push hooks
- **Package Management**: npm (frontend), uv (backend)

## Related Documentation

### For Code Assistants

See [Code Assistant Documentation](../code-assistant/README.md) for concise technical guides optimized for AI assistants:

- [Architecture](../code-assistant/architecture.md) - Condensed system overview
- [Coding Standards](../code-assistant/coding-standards.md) - Code quality requirements
- [Plugin Development](../code-assistant/plugin-development.md) - Plugin creation patterns
- [Testing Guide](../code-assistant/testing-guide.md) - Test structure and patterns
- [Development Commands](../code-assistant/development-commands.md) - Command reference


## Contributing

1. Read relevant documentation before making changes
2. Follow [Coding Standards](../code-assistant/coding-standards.md)
3. Write tests for new features
4. Update documentation
5. Run tests before committing: `npm run test:changed`

## Need Help?

- Check the relevant documentation section above
- Review [Architecture Overview](architecture.md) for system understanding
- See [Testing Guide](testing.md) for debugging techniques
- Check [API Reference](api-reference.md) for endpoint details

## Documentation Structure

```
docs/
├── code-assistant/      # Concise guides for AI assistants
├── development/         # Comprehensive developer docs (you are here)
├── user-manual/         # End-user documentation
└── images/              # Images for all documentation
```
