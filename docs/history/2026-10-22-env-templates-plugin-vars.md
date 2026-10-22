# Env templates: plugin variables, no provider keys

Date: 2026-10-22

## Changes

- `.env.production`, `.env.development`: removed the "AI/ML Provider APIs" section (`GEMINI_API_KEY`, `KISSKI_API_KEY`, ...) and the separate WebDAV section. Added:
  - "Inference Provider API Keys": points to the key store (user menu > API Keys, `data/db/secrets.db`, `bin/user-secrets.py`) and documents `SECRETS_ENCRYPTION_KEY`.
  - "Plugin System": `FASTAPI_PLUGIN_PATHS`, `PTE_PLUGIN_INSTALL`, `PTE_PLUGIN_SOURCES`, `PTE_PLUGIN_DISCOVER_TOPIC`, `PTE_PLUGIN_TRUSTED_OWNERS`, `PTE_PLUGIN_TRUSTED_ONLY`, `GITHUB_TOKEN`; notes on the `PTE_PLUGIN_EXTRAS` build argument and `PTE_WORKER_RECYCLE`.
  - "Plugin Settings": the env vars read by `get_plugin_config()` for each bundled plugin, with defaults. They only seed `config.json` keys that do not exist yet.
- `.env.deploy.demo.localhost`, `.env.deploy.example.org`: provider keys replaced by a key store note and the most relevant plugin variables.
- `docs/user-manual/docker-deployment.md`: examples and the variable table no longer use provider keys.
