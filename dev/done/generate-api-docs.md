# API Documentation Generation Implementation Plan

**GitHub Issue:** <https://github.com/mpilhlt/pdf-tei-editor/issues/122>

## Goal

Generate both human-readable and machine-readable API documentation to prevent code-assistant API hallucinations by providing:

1. Human-readable HTML docs for developers
2. Machine-readable JSON/schema for AI code assistants

## Current State

### Existing Documentation

- **FastAPI endpoints**: Auto-generated OpenAPI schema at `/docs` (Swagger UI)
- **Frontend modules**: Extensive JSDoc comments but no generated docs
- **Python classes**: Google-style docstrings but no generated docs
- **Type definitions**: Auto-generated TypeScript definitions in `app/src/modules/api-client-v1.js`

### Code Quality

- Frontend: Comprehensive JSDoc with specific types (not generic "object")
- Backend: Consistent Google-style docstrings with type hints
- OpenAPI client: Already auto-generated from FastAPI schema

## Tooling Selection

### Frontend: JSDoc with better-docs

- **Tool**: `jsdoc` + `better-docs` theme
- **Rationale**: Already using JSDoc extensively, minimal setup
- **Output**: HTML docs + JSON intermediate format
- **Machine-readable**: Can export TypeScript `.d.ts` files or use `jsdoc-to-markdown` for programmatic access

### Backend: pdoc

- **Tool**: `pdoc` (modern Python documentation generator)
- **Rationale**: Lightweight, works with existing docstrings, generates clean HTML + can output JSON
- **Output**: HTML with source links
- **Machine-readable**: Can generate JSON representation of API via custom template

## Implementation Steps

### 1. Install Dependencies

#### Frontend

```bash
npm install --save-dev jsdoc better-docs jsdoc-to-markdown
```

#### Backend

Add to `pyproject.toml` under `[dependency-groups] dev`:

```toml
"pdoc>=15.0.0",
```

Run: `uv sync`

### 2. Configure JSDoc

Create `jsdoc.json` in project root:

```json
{
  "source": {
    "include": ["app/src/modules"],
    "includePattern": ".+\\.js$",
    "excludePattern": "(node_modules|dist|build)"
  },
  "opts": {
    "destination": "docs/api/frontend",
    "recurse": true,
    "template": "node_modules/better-docs",
    "encoding": "utf8",
    "readme": "docs/api/frontend-readme.md"
  },
  "plugins": ["plugins/markdown"],
  "templates": {
    "better-docs": {
      "name": "PDF-TEI Editor Frontend API",
      "title": "Frontend Modules Documentation",
      "navigation": [
        {
          "label": "Modules",
          "href": "modules.html"
        }
      ]
    }
  }
}
```

### 3. Create Frontend API README

Create `docs/api/frontend-readme.md`:

```markdown
# Frontend Modules API

Auto-generated documentation for PDF-TEI Editor frontend modules.

## Module Categories

- **Plugin System**: `plugin-base.js`, `plugin-manager.js`, `plugin-context.js`
- **State Management**: `state-manager.js`, `application.js`
- **UI System**: `ui-system.js`, panels/*
- **RBAC**: `rbac/entity-manager.js`, `acl-utils.js`
- **Editors**: `xmleditor.js`, `navigatable-xmleditor.js`, `pdfviewer.js`
- **Utilities**: `utils.js`, `sl-utils.js`, `browser-utils.js`
- **API Client**: `api-client-v1.js` (auto-generated from OpenAPI)

## Usage

See individual module documentation for detailed API reference.
```

### 4. Add npm Scripts

Add to `package.json` scripts:

```json
"docs:generate": "npm run docs:frontend && npm run docs:backend && npm run docs:json",
"docs:frontend": "jsdoc -c jsdoc.json",
"docs:backend": "uv run pdoc fastapi_app/lib fastapi_app/plugins fastapi_app/api fastapi_app/routers -o docs/api/backend --docformat google",
"docs:json": "npm run docs:frontend:json && npm run docs:backend:json",
"docs:frontend:json": "jsdoc2md app/src/modules/*.js > docs/api/frontend.json",
"docs:backend:json": "uv run python bin/generate-python-api-json.py",
"docs:serve": "python -m http.server -d docs/api 8080",
"docs:clean": "rm -rf docs/api/frontend docs/api/backend docs/api/*.json"
```

### 5. Create Python API JSON Generator

Create `bin/generate-python-api-json.py`:

```python
#!/usr/bin/env python3
"""
Generate machine-readable JSON documentation for Python modules.

This extracts class and function signatures from docstrings for AI code assistants.
"""

import json
import inspect
import importlib
import pkgutil
from pathlib import Path
from typing import Any

def extract_module_api(module_name: str) -> dict[str, Any]:
    """Extract API information from a module."""
    module = importlib.import_module(module_name)

    api = {
        "module": module_name,
        "doc": inspect.getdoc(module),
        "classes": {},
        "functions": {}
    }

    for name, obj in inspect.getmembers(module):
        if name.startswith("_"):
            continue

        if inspect.isclass(obj) and obj.__module__ == module_name:
            api["classes"][name] = {
                "doc": inspect.getdoc(obj),
                "methods": {}
            }

            for method_name, method in inspect.getmembers(obj, inspect.isfunction):
                if method_name.startswith("_") and method_name not in ["__init__"]:
                    continue

                sig = inspect.signature(method)
                api["classes"][name]["methods"][method_name] = {
                    "signature": str(sig),
                    "doc": inspect.getdoc(method),
                    "params": {
                        param: {
                            "type": str(param_obj.annotation) if param_obj.annotation != inspect.Parameter.empty else None,
                            "default": str(param_obj.default) if param_obj.default != inspect.Parameter.empty else None
                        }
                        for param, param_obj in sig.parameters.items()
                    }
                }

        elif inspect.isfunction(obj) and obj.__module__ == module_name:
            sig = inspect.signature(obj)
            api["functions"][name] = {
                "signature": str(sig),
                "doc": inspect.getdoc(obj)
            }

    return api

def main():
    """Generate API JSON for all fastapi_app modules."""
    output = {
        "generated_at": datetime.now().isoformat(),
        "modules": {}
    }

    # Extract from fastapi_app.lib
    for module_info in pkgutil.iter_modules(["fastapi_app/lib"]):
        if module_info.name.startswith("_"):
            continue
        module_name = f"fastapi_app.lib.{module_info.name}"
        try:
            output["modules"][module_name] = extract_module_api(module_name)
        except Exception as e:
            print(f"Error extracting {module_name}: {e}")

    # Extract from plugins
    plugin_dirs = Path("fastapi_app/plugins").iterdir()
    for plugin_dir in plugin_dirs:
        if not plugin_dir.is_dir() or plugin_dir.name.startswith("_"):
            continue
        plugin_module = f"fastapi_app.plugins.{plugin_dir.name}.plugin"
        try:
            output["modules"][plugin_module] = extract_module_api(plugin_module)
        except Exception as e:
            print(f"Error extracting {plugin_module}: {e}")

    # Write JSON
    output_path = Path("docs/api/backend-api.json")
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with open(output_path, "w") as f:
        json.dump(output, f, indent=2)

    print(f"Generated {output_path}")

if __name__ == "__main__":
    from datetime import datetime
    main()
```

### 6. Update .gitignore

Add to `.gitignore`:

```
# Generated documentation
/docs/api/frontend/
/docs/api/backend/
/docs/api/*.json
```

### 7. Add Pre-release Hook

Update release script to regenerate docs before version bumps.

In `bin/release.js`, add before version bump:

```javascript
// Regenerate API docs
execSync('npm run docs:generate', { stdio: 'inherit' });
```

### 8. Integration with CLAUDE.md

Update CLAUDE.md with reference to generated docs:

```markdown
### API Verification

Before using any method on a class or module:
1. Check the class definition or module exports first
2. Consult generated API docs in `docs/api/` for signatures
3. Machine-readable JSON available at:
   - `docs/api/frontend-api.json` - Frontend module APIs
   - `docs/api/backend-api.json` - Python class/function APIs
```

## Testing

### Manual Testing

```bash
# Generate all docs
npm run docs:generate

# Serve HTML docs locally
npm run docs:serve
# Visit http://localhost:8080

# Verify JSON output
cat docs/api/frontend-api.json | jq '.modules | keys'
cat docs/api/backend-api.json | jq '.modules | keys'
```

### Validation Checklist

- [ ] Frontend HTML docs render correctly
- [ ] Backend HTML docs include all lib modules
- [ ] Backend HTML docs include plugin modules
- [ ] Frontend JSON includes all module exports
- [ ] Backend JSON includes class methods with signatures
- [ ] JSON files are valid JSON
- [ ] Docs contain no broken links

## Files to Create/Modify

### New Files

- `jsdoc.json` - JSDoc configuration
- `docs/api/frontend-readme.md` - Frontend docs landing page
- `bin/generate-python-api-json.py` - Python API JSON generator

### Modified Files

- `package.json` - Add doc generation scripts
- `pyproject.toml` - Add pdoc dependency
- `.gitignore` - Exclude generated docs
- `bin/release.js` - Regenerate docs on release
- `CLAUDE.md` - Add API verification section

## Future Enhancements

1. **CI Integration**: Run `npm run docs:generate` in CI and deploy to GitHub Pages
2. **Version Tracking**: Archive docs for each release version
3. **OpenAPI Extension**: Include FastAPI OpenAPI schema in JSON output
4. **Cross-references**: Link frontend API client types to backend endpoints
5. **Search**: Add search functionality to HTML docs
6. **Coverage**: Add documentation coverage metrics

## Implementation Summary

Successfully implemented API documentation generation with the following components:

### New Files

- [jsdoc.json](../../jsdoc.json) - JSDoc configuration for frontend module documentation
- [docs/api/frontend-readme.md](../../docs/api/frontend-readme.md) - Frontend API documentation landing page
- [bin/generate-python-api-json.py](../../bin/generate-python-api-json.py) - Python script to generate machine-readable JSON from Python modules

### Changed Files

- [package.json](../../package.json:48-53) - Added documentation generation scripts
- [pyproject.toml](../../pyproject.toml:32) - Added pdoc>=15.0.0 dependency
- [.gitignore](../../.gitignore:48-51) - Added generated documentation directories
- [CLAUDE.md](../../CLAUDE.md:146-174) - Added API verification section with documentation commands

### Output

- **Frontend HTML**: `docs/api/frontend/` - JSDoc-generated HTML documentation for all frontend modules (67 files)
- **Backend HTML**: `docs/api/backend/` - pdoc-generated HTML documentation for Python modules
- **Backend JSON**: `docs/api/backend-api.json` - Machine-readable JSON (980KB) containing Python class/function signatures and docstrings

### Commands

```bash
npm run docs:generate        # Generate all documentation
npm run docs:frontend        # Generate frontend HTML only
npm run docs:backend         # Generate backend HTML only
npm run docs:backend:json    # Generate backend JSON only
npm run docs:serve           # Serve docs at http://localhost:8080
npm run docs:clean           # Remove generated docs
```

### Implementation Notes

- JSDoc parser shows warnings for TypeScript-style type annotations (keyof, intersection types, function types) but successfully generates HTML documentation
- Frontend JSON generation was removed from the plan as jsdoc2md produces markdown, not JSON - HTML docs serve the primary purpose
- Backend JSON generation successfully extracts API information from 50+ Python modules
- pdoc shows minor warnings for Pydantic type annotations but generates complete documentation
