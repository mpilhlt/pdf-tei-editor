# Migration Tests

This directory contains unit tests for database migrations.

## Purpose

These tests are for **manual verification only** and are NOT part of the main test suite. They should not run automatically in CI/CD.

## Why Separate?

Migration tests:
- Test one-time schema changes that have already been applied in production
- Would fail on fresh databases where migrations have already run
- Are primarily useful during migration development and before deployment
- Should be run manually when creating or modifying migrations

## Running Tests

Run individual migration tests:

```bash
# Test specific migration
uv run python -m pytest fastapi_app/lib/migrations/tests/test_migration_002.py -v
uv run python -m pytest fastapi_app/lib/migrations/tests/test_migration_004.py -v

# Run all migration tests
uv run python -m pytest fastapi_app/lib/migrations/tests/ -v
```

## Test Naming Convention

- File: `test_migration_XXX.py` where XXX is the migration number
- Class: `TestMigrationXXX...` following the migration class name

## When to Run

- When developing a new migration
- Before committing a migration to the repository
- When debugging migration issues
- When verifying migration idempotency
