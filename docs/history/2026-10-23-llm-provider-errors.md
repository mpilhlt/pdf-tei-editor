# Show LLM provider errors in the model picker

## Problem

After the own-key fix (PR #610), a non-admin user with stored KISSKI and Anthropic keys still saw neither provider in the model picker. KISSKI reports all its models as free, so access rules were not the cause. `GET /api/v1/llm/providers` drops providers silently in two cases:

- `list_models()` raises (rejected key, network or API error): the provider was skipped with only a server log warning.
- The stored user key cannot be decrypted (`SecretsError`, e.g. after `SECRETS_ENCRYPTION_KEY` changed): the exception was not caught, the whole request failed with 500, and the menu kept its previous contents.

## Change

- `ProviderResponse.error`: set in both cases; the provider is listed with no models.
- `inference-settings.js`: a provider with an error gets a "Models unavailable" entry with the error as tooltip. For per-user-key providers the entry opens the API key dialog with the error as message.
- `api-client-v1.js` typedef and `docs/development/llm-registry.md` updated.

## Tests

- `test_llm_router.py`: a failing provider is listed with its error, the healthy one with its models.
- `test_llm_user_keys.py`: undecryptable key yields an error entry instead of a 500.
- `inference-settings.test.js`: error entry rendering (with and without user key) and the message passed to the key dialog.
