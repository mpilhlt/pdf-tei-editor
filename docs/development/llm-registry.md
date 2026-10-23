# LLM Provider Registry

A pluggable registry of LLM inference connectors. Backend plugins register a configured provider instance; consumers (e.g. the annotation-review plugin, the frontend model picker) query the registry without hardcoding provider-specific HTTP logic or environment variables.

Code: `fastapi_app/lib/llm/`. HTTP API: `fastapi_app/routers/llm.py`. Frontend: `app/src/plugins/inference-settings.js`.

## Components

| Module | Purpose |
| --- | --- |
| `base.py` | `LLMProvider` ABC, `LLMModel` and `ModelStatus` TypedDicts, `LLMProviderError` |
| `registry.py` | `LLMProviderRegistry` singleton |
| `openai_compatible.py` | `OpenAICompatibleProvider` for endpoints speaking the OpenAI `chat/completions` format; `chat_completion_sync()` |
| `default_model.py` | Installation-wide default model (stored in config) |
| `model_filter.py` | Admin-configurable include/exclude regex filter |
| `model_access.py` | `check_model_access()`: per-user authorization of a model |

## Bundled providers

| Plugin | Provider id | Label | API key env var | Config key |
| --- | --- | --- | --- | --- |
| `kisski` | `kisski` | KISSKI | `KISSKI_API_KEY` | `plugin.kisski.api.key` (+ `.api.url`) |
| `google_llm` | `google` | Google Gemini | `GEMINI_API_KEY` | `plugin.google-llm.api.key` |
| `anthropic_llm` | `anthropic` | Anthropic Claude | `ANTHROPIC_API_KEY` (+ `ANTHROPIC_API_URL`) | `plugin.anthropic-llm.api.key` (+ `.api.url`) |
| `inference-endpoints` | `endpoint-<id>` | as entered | none (keys in the secret store) | none (endpoints in `data/db/inference-endpoints.json`) |

The [inference-endpoints](https://github.com/mpilhlt/pte-plugins/tree/main/plugins/inference-endpoints#readme) plugin registers one provider per OpenAI-compatible endpoint (e.g. Ollama) that an administrator adds in its management page; it is registered in testing mode too, since it has no endpoints until one is added.

The bundled providers always register, with or without a configured key. Providers are not registered when `FASTAPI_APPLICATION_MODE=testing`.

- **Per-user keys (default)**: without a configured key, each user supplies their own through Tools > API Keys (secret services `kisski`, `google`, `anthropic`; see [User API Keys](../code-assistant/backend-plugins.md#user-api-keys)). `GET /api/v1/llm/providers` lists such a provider with `key_required: true` and no models until the user stored a key; the model picker then shows "Add your API key…".
- **Shared key (shared infrastructure)**: if a key is set in `.env` or `config.json` (`config.json` wins), it is used for all users and no key prompt appears.

## Writing a provider

Subclass `LLMProvider` and implement `list_models()` and `chat_completion()`:

```python
class MyProvider(LLMProvider):
    def __init__(self, api_key: str):
        self.id = "my-provider"
        self.label = "My Provider"   # shown as "<label>/<model label>" in the UI

    def list_models(self) -> list[LLMModel]:
        return [{"id": "m1", "label": "Model 1", "capabilities": frozenset({"chat"}),
                 "status": None, "free": False}]

    async def chat_completion(self, model_id, system_prompt, user_prompt, temperature=0.2) -> str: ...
```

- `LLMModel.free`: `True` if using the model costs the operator nothing. Non-free models are restricted (see [Access control](#access-control)).
- `LLMModel.status`: optional live load state (`availability`: `available`, `busy` or `very_busy`, plus a free-text `detail`); the frontend shows a warning icon when not `available`.
- `is_available()` (default `True`) may be overridden to hide a provider that cannot currently be used. It is not about API keys.
- Per-user keys: set `secret_service` to the id of a registered secret service, return `has_shared_key()` `True` only if a configured key exists, and implement `with_api_key(key)` returning a copy that uses the given key. Consumers get a provider for the requesting user with `LLMProviderRegistry.get_instance().get_provider_for_user(provider_id, username)`, which raises `MissingSecretError` when the user has no key (map it to HTTP 428 with `secret_required_detail(error)`; the extraction endpoint does this already). Do not use `get_provider()` for requests made on behalf of a user.
- Raise `LLMProviderError` with a user-presentable message for upstream failures (rate limit, overload, bad request); routes map it to HTTP 502.
- Multimodal input is optional: override `supports_pdf_input(model_id)` and `chat_completion_with_pdf()` to accept a PDF file, and `supports_image_input(model_id)` and `chat_completion_with_images(model_id, system_prompt, user_prompt, images)` to accept a list of `LLMImage` (`{"data": bytes, "media_type": "image/png"}`), sent in order ahead of the prompt. Consumers check the `supports_*` method before calling. The Anthropic provider implements both.
- Only offer chat models in `list_models()`. Commercial APIs mostly expose no machine-readable modality field, so the Google provider filters non-chat models (image, embedding, etc.) by name markers.

Register the instance in the owning plugin's `initialize()` (not `__init__`) and unregister it in `cleanup()`:

```python
LLMProviderRegistry.get_instance().register(MyProvider(api_key))
...
LLMProviderRegistry.get_instance().unregister("my-provider")
```

Consumers query the registry lazily, inside route handlers, and never declare the provider plugin as a plugin dependency; registration order therefore does not matter. Use `get_provider(id)` (raises `KeyError`) or `list_providers(available_only=True)`.

See `pte-plugins/plugins/anthropic-llm/src/pte_plugin_anthropic_llm/plugin.py` for a complete example. For OpenAI-compatible endpoints, use `OpenAICompatibleProvider` instead of writing a new class (see `pte-plugins/plugins/kisski/src/pte_plugin_kisski/`).

## Model filter

Administrators can restrict which models are offered and usable, e.g. to exclude expensive premium models or to allow only "flash" models. Patterns are matched (`re.search`, i.e. substring) against the `<Provider label>/<Model label>` string shown in the UI, e.g. `Google Gemini/Gemini 2.5 Flash`.

| Config key | Env var | Effect |
| --- | --- | --- |
| `llm.model-filter.include` | `LLM_MODEL_FILTER_INCLUDE` | If non-empty, only models matching at least one pattern are allowed |
| `llm.model-filter.exclude` | `LLM_MODEL_FILTER_EXCLUDE` | Models matching any pattern are rejected, even if they match an include pattern |

The value is a comma-separated list of double-quoted regular expressions: `"^Google Gemini/.*[Ff]lash", "^KISSKI/"`. A non-empty value without quotes is treated as one single pattern. Both keys are empty by default (no filtering). The keys are flat `llm.*` keys rather than `plugin.<name>.*` because the filter is not owned by a single plugin.

The filter is enforced in two places: `GET /api/v1/llm/providers` omits rejected models, and `check_model_access()` rejects them at inference time (HTTP 403). `PUT /api/v1/llm/default-model` also refuses them.

## Default model

The admin-chosen default is stored under `llm.default-model.provider` / `llm.default-model.model` (env `LLM_DEFAULT_PROVIDER` / `LLM_DEFAULT_MODEL`), read and written via `get_default_model()` / `set_default_model()`.

## Access control

`check_model_access(provider, model_id, user)` raises `ModelAccessDenied` (routes return 403) unless:

1. the model passes the include/exclude filter (applies to everyone, admins included), and
2. the user is an admin, or the provider runs on the user's own API key (`provider.uses_user_key`, set by `get_provider_for_user()`; usage is billed to the user), or the model is free, or it is the configured default model.

Pass the provider returned by `get_provider_for_user()`, not the registered one, so that `uses_user_key` is set.

A model is free if its provider sets `LLMModel.free`, or if its `<Provider label>/<Model label>` matches a pattern in `llm.free-models` (env `LLM_FREE_MODELS`, same syntax as the model filter). Use this for models on a provider's free tier, e.g. `"^Google Gemini/Gemini Flash"`.

`GET /api/v1/llm/providers` lists only the models the current user may use, so non-admins never see models they cannot pick.

Consuming routes must call it before invoking a provider; see `pte-plugins/plugins/annotation-review/src/pte_plugin_annotation_review/routes.py`.

## HTTP API

| Endpoint | Access | Description |
| --- | --- | --- |
| `GET /api/v1/llm/providers` | authenticated | Available providers with the (filtered) models the current user may use; a provider whose `list_models()` fails is skipped |
| `GET /api/v1/llm/default-model` | authenticated | Configured default `{provider_id, model_id}` or `null` |
| `PUT /api/v1/llm/default-model` | admin | Set the default; model must exist and pass the filter |

## Frontend

`inference-settings.js` adds a Tools menu entry listing every provider's models. The entry label shows the selected `<provider>/<model>` (else "Default Model"), and a toast confirms each selection. Admins set the installation default; any user can pick a per-session model (kept in `sessionStorage`, takes precedence over the default). Non-admins only see free models, the default, and all models of providers they stored their own key for (the server omits the rest); providers without visible models are left out of the menu. No requests are made without a session. Other plugins read the effective choice via the plugin's `getDefaultModel()`.

## Design documents

- `docs/superpowers/specs/2026-09-24-llm-annotation-review-design.md` (design rationale)
- `docs/superpowers/plans/2026-09-24-llm-provider-registry.md` (implementation plan)
