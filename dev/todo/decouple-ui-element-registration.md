# Proposed Issue: Decouple UI Element Registration from Plugin Dependency Chain

## Problem

The current UI type system violates the dependency inversion principle. Parent plugins must declare UI elements created by dependent plugins in their `@typedef` definitions to enable IDE autocomplete and type checking. This creates circular dependencies and tight coupling between plugins:

- Parent plugins must know about child plugin UI structure
- Changes to child plugin UI require modifying parent plugin typedefs
- The `app/src/ui.js` typedefs must be manually synchronized with runtime UI registration
- Plugin independence is compromised by compile-time type declarations

**Example:** A toolbar plugin must declare UI elements added by plugins that extend it, even though it should be agnostic to those extensions.

## Proposed Solution

Implement a build-time UI type generation system:

1. **Colocate UI declarations with creation code**: Each plugin declares its UI elements in JSDoc where they're created (e.g., `install()` methods)

2. **Extract declarations at build time**: Create a build step that:
   - Scans plugin files for UI element registrations
   - Extracts `@typedef` declarations from plugin JSDoc
   - Analyzes `name` attributes in template HTML files
   - Generates a complete UI type hierarchy

3. **Generate `app/src/ui.js` automatically**: The build step produces:
   - Complete `@typedef` declarations for all UI parts
   - Hierarchical type structure matching runtime registration
   - No manual synchronization needed

4. **Development workflow**:
   - During development: Use existing manual typedef declarations
   - Pre-commit hook: Regenerate `app/src/ui.js` from plugin sources
   - CI validation: Ensure generated types match committed version

## Implementation Approach

1. **Phase 1**: Create a static analysis tool that:
   - Parses JavaScript for `registerTemplate()` and `createFromTemplate()` calls
   - Parses HTML templates for `name` attributes
   - Builds a dependency graph of UI element hierarchy

2. **Phase 2**: Generate TypeScript-style declarations:
   - Output `@typedef` blocks for each UI part
   - Handle nested element hierarchies
   - Preserve custom property types from source JSDoc

3. **Phase 3**: Integrate into build system:
   - Add `npm run build:ui-types` script
   - Update pre-commit hook to regenerate types
   - Add CI check to validate type freshness

## Benefits

- Plugins remain independent and loosely coupled
- UI type information stays synchronized with implementation
- No manual typedef maintenance
- Preserves IDE autocomplete and type safety
- Follows single responsibility principle: plugins declare their own UI
