# Database Configuration Setup - Implementation Summary

**Date**: 2025-10-11
**Status**: ✅ Complete and Tested

## Overview

Implemented the Flask-style configuration pattern for FastAPI where default configuration files are stored in version control (`config/`) and runtime database files are generated on startup (`db/`).

## Problem Statement

Previously, database files (`.json`, `.db`) were committed to git in `fastapi_app/db/`, which caused:
- Configuration changes to conflict across branches
- Test state to leak between runs
- SQLite databases to be versioned (unnecessary and problematic)
- No clear separation between defaults and runtime state

## Solution

Implemented a **config-to-db initialization pattern** matching the Flask server:

1. **Default files** stored in `fastapi_app/config/` (versioned)
2. **Runtime files** generated in `fastapi_app/db/` (gitignored)
3. **Automatic initialization** on server startup
4. **Test-friendly** with utilities for clean state

## Changes Made

### 1. Directory Structure

```
fastapi_app/
├── config/                    # NEW: Default configuration (versioned)
│   ├── README.md              # Documentation
│   ├── config.json            # App configuration defaults
│   ├── users.json             # Default user accounts
│   └── prompt.json            # Default LLM prompts
├── db/                        # Runtime database files (gitignored)
│   ├── config.json            # (Generated from config/)
│   ├── users.json             # (Generated from config/)
│   ├── prompt.json            # (Generated from config/)
│   ├── sessions.db            # (Created on demand)
│   ├── locks.db               # (Created on demand)
│   └── metadata.db            # (Created in data/)
└── lib/
    └── db_init.py             # NEW: Initialization logic
```

### 2. Files Created

#### `fastapi_app/lib/db_init.py`
- `initialize_db_from_config()` - Copy JSON files from config to db
- `_merge_config_defaults()` - Add missing keys from config template
- `clean_db_directory()` - Remove db files for testing
- `ensure_db_initialized()` - High-level initialization

#### `fastapi_app/config/README.md`
- Documents the config → db pattern
- Explains startup behavior
- Provides test examples
- Lists default user accounts

#### `fastapi_app/tests/helpers/db-setup.js`
- `cleanDbDirectory()` - Clean db for tests
- `initDbFromConfig()` - Initialize from defaults
- `resetDbToDefaults()` - One-step reset
- `checkDbFiles()` - Verify files exist
- `waitForServerReady()` - Wait after reset

#### `fastapi_app/tests/py/test_db_init.py`
- 10 unit tests for initialization logic
- Tests file copying, merging, cleaning
- Verifies real config files exist
- All tests passing ✅

### 3. Git Configuration

Updated `.gitignore`:
```gitignore
# FastAPI database files (runtime-generated from config/)
fastapi_app/db/*.json
fastapi_app/db/*.db
fastapi_app/db/*.db-*
```

Removed from git tracking:
```bash
git rm --cached fastapi_app/db/*.json
git rm --cached fastapi_app/db/*.db*
```

### 4. Startup Integration

Updated `fastapi_app/main.py`:
```python
# Initialize database directory from config defaults
from .lib.db_init import ensure_db_initialized
try:
    ensure_db_initialized()
    logger.info("Database configuration initialized from defaults")
except Exception as e:
    logger.error(f"Error initializing database from config: {e}")
    raise
```

## Behavior

### Application Startup

1. Server starts
2. `ensure_db_initialized()` called
3. Checks if `db/*.json` files exist
4. If missing, copies from `config/*.json`
5. Merges missing keys into `db/config.json`
6. SQLite databases created on first access (on-demand)

### For New Installations

- Clean checkout has no `db/` files
- First run creates `db/` directory
- Copies all defaults from `config/`
- Server starts with sensible defaults

### For Existing Installations

- Existing `db/` files preserved
- Only missing files copied from `config/`
- Missing config keys merged (non-destructive)
- User customizations kept

### For Tests

```javascript
// JavaScript/Node tests
import { resetDbToDefaults } from './helpers/db-setup.js';

describe('My Tests', () => {
  before(async () => {
    resetDbToDefaults();  // Clean slate
    await waitForServerReady();
  });
});
```

```python
# Python tests
from fastapi_app.lib.db_init import clean_db_directory, initialize_db_from_config

def setup_function():
    clean_db_directory(Path("fastapi_app/db"))
    initialize_db_from_config(
        Path("fastapi_app/config"),
        Path("fastapi_app/db")
    )
```

## Default User Accounts

Added to `config/users.json`:

- **admin** / password: `admin` - Full admin access
- **annotator** / password: `annotator` - Can create/edit versions
- **reviewer** / password: `reviewer` - Can create/edit gold files

Password hashes stored as SHA-256.

## Testing Results

### Unit Tests (Python)
```bash
$ uv run pytest fastapi_app/tests/py/test_db_init.py -v
============================= test session starts ==============================
10 passed in 0.07s
```

All 10 tests passing:
- ✅ Files copied from config to db
- ✅ Existing files not overwritten
- ✅ Missing config keys merged
- ✅ Clean removes correct files
- ✅ Force overwrite works
- ✅ Creates db directory if missing
- ✅ Real config files exist
- ✅ Reviewer user in defaults

### Integration Test

```bash
# Clean db directory
$ rm -rf fastapi_app/db/*.json fastapi_app/db/*.db*
$ ls fastapi_app/db/
# (empty)

# Start server
$ npm run dev:fastapi

# Files created automatically
$ ls -la fastapi_app/db/
config.json
users.json
prompt.json
locks.db        # Created on demand
```

Login test:
```bash
$ curl -X POST http://localhost:8000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username": "reviewer", "passwd_hash": "..."}'

{
  "username": "reviewer",
  "fullname": "Test Reviewer",
  "role": null,
  "sessionId": "e34f54a1-9128-4deb-a0c5-75079b8bd1cd"
}
✅ Login works with config-initialized user
```

## Benefits

### For Development

1. **Clean branches** - No db file conflicts in git
2. **Easy reset** - Delete `db/`, restart server
3. **Default recovery** - Missing files auto-restore
4. **Config updates** - New keys merge automatically

### For Testing

1. **Isolated tests** - Each test can start clean
2. **Fixture-based** - Tests control initial state
3. **Fast reset** - Delete files, no database commands
4. **Reproducible** - Same defaults every time

### For Production

1. **Sensible defaults** - Ships with working config
2. **Safe updates** - Preserves customizations
3. **Self-healing** - Recreates missing files
4. **Documented** - Clear README in config/

## Migration Guide

### For Existing Deployments

No action required! The system:
- Detects existing `db/` files
- Preserves them
- Only adds missing files

### For New Deployments

1. Clone repository
2. Start server
3. Files automatically initialized from `config/`

### For Development

1. Pull latest code
2. Delete `fastapi_app/db/*` to get clean state
3. Start server
4. Fresh defaults loaded

## Comparison with Flask

| Aspect | Flask Server | FastAPI Server | Match? |
|--------|-------------|----------------|--------|
| **Config dir** | `config/` | `fastapi_app/config/` | ✅ |
| **Runtime dir** | `db/` | `fastapi_app/db/` | ✅ |
| **Copy on startup** | Yes (flask_app.py:136-141) | Yes (main.py + db_init.py) | ✅ |
| **Merge missing keys** | Yes (flask_app.py:143-152) | Yes (db_init.py:_merge_config_defaults) | ✅ |
| **SQLite on demand** | Yes | Yes (database.py:_ensure_db_exists) | ✅ |
| **Gitignore db/** | Yes | Yes (.gitignore:24-26) | ✅ |

**Result**: ✅ Complete parity with Flask pattern

## Known Issues

None. The configuration system is working correctly.

The remaining test failures in Phase 4B are unrelated to configuration:
- Save API 500 errors (separate issue)
- Delete API 422 errors (caused by Save failures)
- Locks API path vs hash issues

## Next Steps

1. ✅ Configuration system complete
2. ⏭️ Debug Save API 500 errors (Phase 4B blocker)
3. ⏭️ Complete Phase 4B integration tests
4. ⏭️ Document for production deployment

## References

- Flask implementation: `server/flask_app.py:136-152`
- FastAPI implementation: `fastapi_app/lib/db_init.py`
- Tests: `fastapi_app/tests/py/test_db_init.py`
- Documentation: `fastapi_app/config/README.md`
- Test helpers: `fastapi_app/tests/helpers/db-setup.js`

## Conclusion

✅ **Configuration system successfully implemented and tested**

The FastAPI server now matches the Flask pattern for configuration management:
- Default files in version control
- Runtime files gitignored
- Automatic initialization on startup
- Test-friendly utilities
- Production-ready with sensible defaults

This provides a solid foundation for:
- Clean test setup/teardown
- Branch switching without conflicts
- Easy deployment
- Self-healing configuration
