# Env templates: plugin system variables, no provider keys

Date: 2026-10-22

## Changes

- `.env.production`, `.env.development`: removed the "AI/ML Provider APIs" section (`GEMINI_API_KEY`, `KISSKI_API_KEY`, ...) and the WebDAV section. Added:
  - "Inference Provider API Keys": points to the key store (user menu > API Keys, `data/db/secrets.db`, `bin/user-secrets.py`) and documents `SECRETS_ENCRYPTION_KEY`.
  - "Plugin System": `FASTAPI_PLUGIN_PATHS`, `PTE_PLUGIN_INSTALL`, `PTE_PLUGIN_SOURCES`, `PTE_PLUGIN_DISCOVER_TOPIC`, `PTE_PLUGIN_TRUSTED_OWNERS`, `PTE_PLUGIN_TRUSTED_ONLY`, `GITHUB_TOKEN`; notes on the `PTE_PLUGIN_EXTRAS` build argument and `PTE_WORKER_RECYCLE`.
- Settings of individual plugins (GROBID, WebDAV, ...) are not documented in the templates; each plugin's README describes them (built-in plugins: `fastapi_app/plugins/<name>/README.md`, which now list the environment variables of dashboard, review_queue and log_viewer; the others: `mpilhlt/pte-plugins`). The core `LLM_*` variables stay in the templates.
- `.env.deploy.*` and `docs/user-manual/docker-deployment.md` follow the same split.
- The key file fallback for `SECRETS_ENCRYPTION_KEY` (`data/db/secrets.key`) is discouraged: the key sits next to the encrypted secrets, so every copy of the data directory (backups, sync mirrors, the Docker volume) can decrypt them. `SecretStore` now logs a warning whenever it uses the key file.
- The "API Keys" user menu item is placed below "User Profile". `ep.toolbar.menuItems` contributions accept an optional `after` (the `name` of the menu item to insert after).
