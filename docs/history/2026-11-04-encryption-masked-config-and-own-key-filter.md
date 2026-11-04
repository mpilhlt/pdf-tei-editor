# Encrypted masked config values and the model filter for own keys

Issues: #667 (encrypt masked `config.json` values at rest), #685 (inference provider with a private key not shown).

## #685: model filter only for shared keys

### Problem

A reviewer stored a personal Claude key, but no Claude models appeared. The instance has `llm.model-filter.include` set to `.*Flash.*`, and the filter applied to every provider, including those running on the user's own key.

### Fix

- `model_access.passes_model_filter(provider, model)`: true when `provider.uses_user_key`, otherwise `is_model_allowed()`.
- `GET /api/v1/llm/providers` uses it; `check_model_access()` returns early for own-key providers.
- `PUT /api/v1/llm/default-model` still applies the filter, since the default model is used by everyone on the shared key.
- Config key descriptions, `docs/development/llm-registry.md` and the `llmProviders()` JSDoc state that the filter applies to shared keys only.

## #667: encrypt masked config values

### Design

- `fastapi_app/lib/secrets/encryption.py`: `load_fernet(db_dir, create)` extracted from the secret store, so that `config.json` and `secrets.db` share one key (`SECRETS_ENCRYPTION_KEY` or `data/db/secrets.key`). `create=False` for decryption, so that a missing key is reported instead of replaced by a new one. Fernet instances are cached per (environment key, key file).
- `config_utils`: a non-empty value of a key with `.masked = true` is stored as `"fernet:" + token(json.dumps(value))`. `set_config_value()` encrypts after validation and type inference (which see the plain value). Setting `.masked` to true encrypts an existing value; to anything else decrypts it. An unchanged value keeps its token, so plugin re-registration at startup does not rewrite the file. The success message of a masked key no longer contains the value.
- `get_config_value()` / `Config.get()` decrypt; `load_full_config()` / `Config.load()` return tokens, since no caller of `load()` needs secrets (config API, startup, public config). `apply_masks=True` returns the sentinel without decrypting.
- `check_config_secrets(db_dir)` decrypts all tokens and raises `ConfigSecretError` naming the keys; `main.py` calls it at startup before anything reads config, and logs plain-text masked keys as a warning.
- `bin/migrations/encrypt-masked-config-values.py [--db-dir] [--dry-run]`: rejects malformed JSON and values encrypted with another key, re-sets each plain-text masked value through `set_config_value()` (file lock, encryption), verifies the result.
- Not covered: project config overrides in `projects.json`.

### Docs

`docs/user-manual/docker-deployment.md` ("Encryption of secrets": setup, startup check, migration, key loss and rotation), `docs/user-manual/cli.md`, `docs/development/configuration.md`, `docs/code-assistant/backend-plugins.md`, `bin/migrations/README.md`.

### Tests

- `tests/unit/fastapi/test_config_encryption.py`: encryption at rest, types, token reuse, flag changes, no decryption for masks and `load()`, wrong and missing key, shared key with the secret store, plugin config, startup check, migration (encrypt, dry run, malformed file, wrong key).
- The config and secret store tests remove `SECRETS_ENCRYPTION_KEY` from the environment and reset the key cache, so they do not depend on the developer's key.
- `tests/unit/fastapi/test_llm_model_access.py`, `test_llm_router.py`: the filter is not applied to own-key providers.
