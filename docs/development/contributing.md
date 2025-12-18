# Contributing Guide

This guide covers best practices for contributing to the PDF-TEI Editor project.

## Commit Messages

Use conventional commit format for clear, structured commit history:

```
<type>: <description>

[optional body]

[optional footer]
```

### Commit Types

- **feat**: New feature
- **fix**: Bug fix
- **docs**: Documentation changes
- **refactor**: Code restructuring without behavior change
- **test**: Adding or updating tests
- **chore**: Maintenance tasks (dependencies, tooling, etc.)

### Guidelines

- **Use present tense**: "Add feature" not "Added feature"
- **Be concise**: Keep subject line under 72 characters
- **Describe why, not what**: The diff shows what changed; explain the reason
- **Reference issues**: Use `#123` or `fixes #123` in the footer
- **Scope (optional)**: Add scope in parentheses: `feat(api): add user endpoint`

### Examples

```
feat: add XML validation on save

Validates TEI documents against schema before saving to prevent
corrupt data in the database.

Closes #142
```

```
fix: correct viewport scaling on mobile devices
```

```
refactor(plugins): extract common state update logic
```

```
docs: update installation instructions for Python 3.13
```

```
test: add E2E test for document export
```

### Chore Commits

Chore commits are filtered from release notes. Use for:

- Dependency updates
- Build configuration
- Development tooling
- Code formatting
- Minor cleanup

```
chore: update dependencies
chore(deps): bump fastapi to 0.109.0
chore: configure ESLint rule for imports
```

### Breaking Changes

For breaking changes, add `BREAKING CHANGE:` in the footer:

```
feat: migrate to FastAPI backend

BREAKING CHANGE: API endpoints now use /api/v1 prefix instead of /api.
Update client code to use new paths.
```

## Code Quality

### Before Committing

1. Run tests for changed files: `npm run test:changed`
2. Ensure working directory is clean (no untracked debug files)
3. Follow [Coding Standards](../code-assistant/coding-standards.md)

### JSDoc Requirements

All exported functions, classes, and methods must have comprehensive JSDoc comments:

```javascript
/**
 * Validates TEI document against schema
 * @param {string} documentId - Document identifier
 * @param {Object} options - Validation options
 * @param {boolean} options.strict - Enable strict validation
 * @returns {Promise<ValidationResult>} Validation result with errors
 * @throws {ValidationError} If document not found
 */
async function validateDocument(documentId, options = {}) {
  // Implementation
}
```

See [Coding Standards](../code-assistant/coding-standards.md) for complete requirements.

## Branch Workflow

### Development Branches

- **`devel`** - Main development branch. All development work happens here.
- **`main`** - Stable release branch. Only receives merges from `devel` after releases.
- **Feature branches** - Created from `devel`, merged back to `devel`.

### Working with Branches

1. **Create feature branch from `devel`**

   ```bash
   git checkout devel
   git pull origin devel
   git checkout -b feature/my-feature
   ```

2. **Make changes and commit**

   ```bash
   git add .
   git commit -m "feat: add new feature"
   ```

3. **Keep branch updated with `devel`**

   ```bash
   git checkout devel
   git pull origin devel
   git checkout feature/my-feature
   git merge devel
   ```

4. **Push and create PR targeting `devel`**

   ```bash
   git push origin feature/my-feature
   # Create PR with base branch: devel
   ```

### Important Rules

- **ALWAYS target `devel` for PRs**, never `main`
- **NEVER commit directly to `main`**
- `main` only receives merges from `devel` after releases
- Feature branches must be up to date with `devel` before merging

## Pull Requests

### Creating a PR

1. Create feature branch from `devel` (see Branch Workflow above)
2. Ensure commits follow conventional format
3. Update relevant documentation
4. Add tests for new features
5. Run full test suite: `npm run test:all`
6. Push branch and create PR **targeting `devel`**
7. Write clear PR description explaining changes

### PR Description Template

```markdown
## Summary

Brief description of what this PR does.

## Changes

- List key changes
- Organized by type if multiple

## Testing

- [ ] Unit tests added/updated
- [ ] API tests added/updated
- [ ] E2E tests added/updated
- [ ] Manual testing completed

## Related Issues

Closes #123
```

## Testing

### Test Requirements

- **New features**: Add unit tests and E2E tests
- **Bug fixes**: Add regression test
- **Refactoring**: Ensure existing tests pass

### Running Tests

```bash
# Quick check for changed files
npm run test:changed

# Full test suite
npm run test:all

# Specific test types
npm run test:unit:js
npm run test:unit:fastapi
npm run test:api
npm run test:e2e
```

See [Testing Guide](testing.md) for comprehensive testing documentation.

## Code Review

### For Authors

- Keep PRs focused and reasonably sized
- Respond to feedback promptly
- Update documentation as needed
- Ensure CI passes before requesting review

### For Reviewers

- Check code follows project conventions
- Verify tests are comprehensive
- Ensure documentation is updated
- Test functionality locally when needed

## Release Process

### Recommended Workflow

The recommended approach for creating releases:

1. **Ensure `devel` is ready for release**
   - All features complete and tested
   - All tests passing: `npm run test:all`

2. **Run release script on `devel`**

   ```bash
   git checkout devel
   node bin/release.js patch  # or minor/major
   ```

   - Bumps version on `devel`
   - Creates tag pointing to `devel` commit
   - Pushes both branch and tag to GitHub
   - GitHub Actions triggers and creates release

3. **Merge `devel` to `main`**

   ```bash
   git checkout main
   git merge devel
   git push origin main
   ```

### Why Release from `devel`?

- Development happens on `devel`, so version bump occurs where work is done
- Tag triggers release workflow immediately
- Merging to `main` brings the release commit into stable branch
- Simpler than creating intermediate release branches
- Keeps `main` clean with only merged, tested code

### Release Script Usage

Releases are automated via [bin/release.js](../../bin/release.js):

```bash
# Bump patch version (0.8.0 -> 0.8.1)
node bin/release.js patch # shorthand: npm release:patch

# Bump minor version (0.8.0 -> 0.9.0)
node bin/release.js minor # shorthand: npm release:minor

# Bump major version (0.8.0 -> 1.0.0)
node bin/release.js major # shorthand: npm release:major

# Test without pushing
node bin/release.js patch --dry-run # shorthand: npm release:patch -- --dry-run

# Skip test execution
node bin/release.js patch --skip-tests
```

The script:

1. Validates working directory is clean
2. Runs full test suite (unless `--skip-tests`)
3. Regenerates API client if needed
4. Bumps version and creates git tag
5. Pushes changes and tag to GitHub
6. Creates PR if on main branch (requires `gh` CLI)

GitHub Actions automatically:

- Generates changelog from conventional commits
- Creates GitHub release
- Builds and pushes Docker image

See [bin/release.js:3-15](../../bin/release.js#L3-L15) for complete usage.

## Documentation

### When to Update

- **New features**: Add to relevant docs, update API reference if backend
- **Bug fixes**: Update if documentation was incorrect
- **Breaking changes**: Update all affected documentation
- **Configuration changes**: Update [Configuration](configuration.md)

### Documentation Structure

```
docs/
├── code-assistant/      # Concise guides for AI assistants
├── development/         # Developer documentation (you are here)
├── user-manual/         # End-user documentation
└── images/              # Shared images
```

### Documentation Guidelines

- Keep code examples up to date
- Link to related documentation
- Use markdown formatting consistently
- Include code references with line numbers: `file.js:42`

## Getting Help

- Check [Architecture Overview](architecture.md) for system understanding
- Review [Testing Guide](testing.md) for test-related questions
- See [API Reference](api-reference.md) for endpoint details
- Consult [Plugin System](plugin-system.md) for plugin development

## License

By contributing, you agree that your contributions will be licensed under the project's license.
