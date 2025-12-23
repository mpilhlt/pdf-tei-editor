# Better backend config api

**GitHub Issue:** https://github.com/mpilhlt/pdf-tei-editor/issues/133

At the moment, config values are processed at the backend using an API tha requires knowing where the values are stored. For examples, see `docs/development/configuration.md`. This is not ideal. We need an api similar to the frontend one (`app/src/plugins/config.js`), which is agnostic towards the implementation details.

- Add high-level API to `fastapi_app/lib/config_utils.py`
- Replace existing uses of the old API with the new one 
