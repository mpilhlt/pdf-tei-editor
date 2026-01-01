# Better backend config api

**GitHub Issue:** https://github.com/mpilhlt/pdf-tei-editor/issues/133

At the moment, config values are processed at the backend using an API tha requires knowing where the values are stored. For examples, see `docs/development/configuration.md`. This is not ideal. We need an api similar to the frontend one (`app/src/plugins/config.js`), which is agnostic towards the implementation details.

- Add high-level API to `fastapi_app/lib/config_utils.py`
- Replace existing uses of the old API with the new one

## Implementation Summary

Implemented a high-level `Config` class and module-level API for backend configuration management:

1. **Config Class** ([fastapi_app/lib/config_utils.py:58-131](fastapi_app/lib/config_utils.py#L58-L131))
   - Provides methods: `get()`, `set()`, `delete()`, `load()`
   - Abstracts away db_dir implementation details
   - Uses existing low-level functions internally

2. **Module-Level API** ([fastapi_app/lib/__init__.py](fastapi_app/lib/__init__.py))
   - Exports preconfigured `config` instance via `get_config()`
   - Lazy initialization with settings.db_dir injection
   - Usage: `from fastapi_app.lib import config`

3. **Updated All Backend Code**:
   - [fastapi_app/main.py:51-68](fastapi_app/main.py#L51-L68) - Application initialization
   - [fastapi_app/main.py:239-241](fastapi_app/main.py#L239-L241) - Development mode check
   - [fastapi_app/api/config.py:18,103,117,138](fastapi_app/api/config.py) - Config API endpoints
   - [fastapi_app/routers/files_save.py:316-318](fastapi_app/routers/files_save.py#L316-L318) - XML entity encoding
   - [fastapi_app/config.py:100-102](fastapi_app/config.py#L100-L102) - Session timeout fallback

4. **Updated Tests** ([tests/unit/fastapi/test_config_utils.py](tests/unit/fastapi/test_config_utils.py))
   - Rewritten to use Config class API
   - All 12 tests pass, including concurrent writes test

5. **Updated Documentation** ([docs/development/configuration.md:68-176,226-254](docs/development/configuration.md))
   - Replaced low-level API documentation with high-level API
   - Added usage examples with module-level config instance
   - Updated configuration flow section

All 336 FastAPI unit tests pass.
