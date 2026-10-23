# Own-key LLM providers visible to non-admins

## Problem

A non-admin user stored personal API keys for KISSKI and Anthropic (Tools > API Keys shows "Stored"), but neither provider appeared in the inference model menu; only the free Google Gemini models did.

## Root cause

`GET /api/v1/llm/providers` resolved each provider with the user's key and listed its models, but then filtered them through `user_may_use_model()`, which allows non-admins only free models and the configured default. KISSKI and Anthropic models are not free, so every model was removed. `inference-settings.js` skips providers with no models, so the providers vanished from the menu. `check_model_access()` would have rejected the same models with 403 on use.

The free/default restriction exists to protect the operator's shared keys. It should not apply when the request runs on the user's own key, since the user pays for it.

## Fix

- `LLMProvider.uses_user_key` (default `False`); `LLMProviderRegistry.get_provider_for_user()` sets it on the copy built with the user's key.
- `user_may_use_model()` allows any model when `provider.uses_user_key`; `check_model_access()` skips the model listing in that case unless a model filter is active. The include/exclude filter still applies.
- Docs: `docs/development/llm-registry.md` (access control, model picker).

## Tests

- `tests/unit/fastapi/test_llm_user_keys.py`: the flag is set only on user-key copies; the providers listing shows paid models of an own-key provider to a non-admin and hides paid models of a shared-key provider.
- `tests/unit/fastapi/test_llm_model_access.py`: own-key access without listing; the filter still applies.
