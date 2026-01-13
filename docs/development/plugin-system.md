# Plugin System Overview

The PDF-TEI Editor uses two independent plugin systems:

## Frontend Plugins (JavaScript)

**Location**: `app/src/plugins/`

Frontend plugins extend the browser-based UI using a class or object-based architecture:

- **Dependency resolution** - Automatic topological sorting ensures plugins load in correct order
- **State management** - Integration with immutable state system
- **Lifecycle hooks** - `install`, `start`, `shutdown`, `onStateUpdate`
- **Plugin classes** - Modern pattern with automatic state management via `Plugin` base class
- **Plugin objects** - Legacy pattern with manual state tracking

**See**: [Frontend Plugin System Documentation](plugin-system-frontend.md)

## Backend Plugins (Python)

**Location**: `fastapi_app/plugins/`

Backend plugins provide server-side functionality and API endpoints:

- **Runtime discovery** - Plugins discovered from `fastapi_app/plugins/` and `FASTAPI_PLUGIN_PATHS`
- **Role-based access** - Control plugin visibility and execution by user roles
- **Custom routes** - Optional FastAPI routes for specialized endpoints
- **Frontend integration** - Plugins appear in toolbar, return HTML/URLs for display

**See**: [Backend Plugin System Documentation](plugin-system-backend.md)

## Key Differences

| Aspect | Frontend Plugins | Backend Plugins |
|--------|-----------------|-----------------|
| **Language** | JavaScript (ES6 modules) | Python |
| **Location** | `app/src/plugins/` | `fastapi_app/plugins/` |
| **Registration** | Static array in `app.js` | Runtime discovery |
| **State** | Reactive state management | Stateless endpoints with context |
| **Dependencies** | Topological sort via `deps` | No inter-plugin dependencies |
| **Lifecycle** | install → start → shutdown | Registered at startup |
| **Access Control** | Client-side (state-based) | Server-side (role-based) |

## Development Guides

- **[Frontend Plugin Development](../code-assistant/plugin-development.md)** - Practical guide for creating UI plugins
- **[Backend Plugin Development](../code-assistant/backend-plugins.md)** - Practical guide for creating server plugins
- **[Frontend Plugin Architecture](plugin-system-frontend.md)** - Technical architecture details
- **[Backend Plugin Architecture](plugin-system-backend.md)** - Technical architecture details
