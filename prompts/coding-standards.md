# Coding Standards and Best Practices

## 🚨 CRITICAL: JSDoc Type Annotation Requirements

**ALWAYS create comprehensive JSDoc headers for ALL functions and use specific types instead of generic "object".**

When creating or modifying JavaScript functions, you MUST:

1. **Add JSDoc headers to ALL functions** - No exceptions, even simple utility functions
2. **Use specific types instead of "object"** - TypeScript can infer most types; leverage this
3. **Import types from relevant modules** - Use `@import` statements for external types
4. **Add @param annotations with union types** - E.g., `@param {UserData|null}` not `@param {Object}`
5. **Add @returns annotations with specific types** - E.g., `@returns {Promise<void>}` not just `@returns`
6. **Type-cast variables when needed** - Use `/** @type {SpecificType|null} */` for variable declarations

**Examples of CORRECT JSDoc annotations:**

```javascript
/**
 * @import { UserData } from './authentication.js'
 * @import { LookupItem } from '../modules/file-data-utils.js'
 */

/**
 * Checks if user has specific role
 * @param {UserData|null} user - User object or null
 * @param {string} role - Role name to check
 * @returns {boolean} True if user has role
 */
function userHasRole(user, role) {
  return user && user.roles && user.roles.includes(role)
}

/**
 * Gets file metadata by hash
 * @param {string} hash - File hash identifier
 * @returns {LookupItem|null} File data or null if not found
 */
function getFileData(hash) {
  /** @type {LookupItem|null} */
  const fileData = getFileDataByHash(hash)
  return fileData
}
```

**AVOID these patterns:**
- `@param {Object}` - Too generic, use specific interface types
- `@param {object}` - Same issue, specify the actual structure
- Missing `@returns` on functions - Always specify return types
- Untyped variables - Use `@type` comments for complex assignments

This ensures TypeScript error-free code and provides excellent IDE autocompletion support.

## Python Development

- Always prefer pathlib Path().as_posix() over manually concatenating path strings or os.path.join()
- **NEVER start, restart, or suggest restarting the Flask server** - It is already running and auto-restarts when changes are detected. You cannot access server logs of the running server. If you need output, ask the user to supply it.

## Frontend Development

- **Shoelace Component Registration**: When using new Shoelace components, ensure they are properly imported and exported in `app/src/ui.js`. Components not properly registered will have `visibility: hidden` due to the `:not(:defined)` CSS rule. Example: if using `sl-tree-item`, import `SlTreeItem` from `@shoelace-style/shoelace/dist/components/tree-item/tree-item.js` and add it to the export list. This is critical for proper component rendering.
- **Shoelace Icon Resources**: When using Shoelace icons programmatically (via `icon` attribute or StatusText widget) where the literal `<sl-icon name="icon-name"></sl-icon>` is not present in the codebase, add a comment with the HTML literal to ensure the build system includes the icon resource: `// <sl-icon name="icon-name"></sl-icon>`. This is not needed when the icon tag already exists verbatim in templates or HTML.
- **Debug Logging**: When adding temporary debug statements in the source code so that the user can test interactively, use `console.log("DEBUG ...")` instead of `logger.debug()`. Always prefix the message with "DEBUG" to make them easily searchable and removable. Example: `console.log("DEBUG Collection in options:", options.collection);`. This allows easy filtering with browser dev tools and quick cleanup using search/replace.
- The UI name resolution system allows to lookup dom elements by a chain of nested "name" attribute. In the runtime, it is updated by calling updateUi() from ui.js. Then, elements can be referred to by ui.<top-level-name>.<next-level-name>.... etc. Each time a new element with a name is added to the DOM, `updateUi()` has to be called again. In code, this hierarchy has to be manually added by JSDoc/Typescript `@typedef` definitions in order to get autocompletion. TypeScript errors can indicate that such definitions haven't been added. If so, add them.

## JSDoc/TypeScript Best Practices

The application uses plain javascript to avoid transpilation. It stores all its type annotations in JSDOC annotations.

In order to avoid typescript errors, follow these best practices:

- In `catch` blocks, use `String(error)` instead of `error.message` when the error message should be used in console messages etc. in order to avoid to have to do a type check first.

## General Code Conventions

When making changes to files, first understand the file's code conventions. Mimic code style, use existing libraries and utilities, and follow existing patterns.

- NEVER assume that a given library is available, even if it is well known. Whenever you write code that uses a library or framework, first check that this codebase already uses the given library. For example, you might look at neighboring files, or check the package.json (or cargo.toml, and so on depending on the language).
- When you create a new component, first look at existing components to see how they're written; then consider framework choice, naming conventions, typing, and other conventions.
- When you edit a piece of code, first look at the code's surrounding context (especially its imports) to understand the code's choice of frameworks and libraries. Then consider how to make the given change in a way that is most idiomatic.
- Always follow security best practices. Never introduce code that exposes or logs secrets and keys. Never commit secrets or keys to the repository.