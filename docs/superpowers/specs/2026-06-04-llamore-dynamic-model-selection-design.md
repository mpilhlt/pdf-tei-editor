# LLamore Dynamic Gemini Model Selection

**Issue:** #378

## Goal

Allow users to choose from available Gemini models in the extraction dialog, with the model list fetched dynamically from the Gemini API using the configured API key.

## Architecture

All changes are backend-only. The extraction dialog already renders string options with an `options` array as a `<sl-select>` dropdown — no frontend changes needed.

### `LLamoreExtractor` changes ([fastapi_app/plugins/llamore/extractor.py](../../../../fastapi_app/plugins/llamore/extractor.py))

**Model list caching:**

- Add class-level cache: `_models_cache: list[str] | None = None`, `_models_cache_time: float = 0`, `_CACHE_TTL = 86400` (24 h)
- Add `_fetch_available_models()` classmethod:
  - Returns cache if it is less than 24 h old
  - Creates a `genai.Client` with the configured API key
  - Calls `client.models.list()`, filters to models whose `name` starts with `models/gemini-` and whose `supported_actions` includes `"generateContent"`
  - Strips the `models/` prefix from each name
  - Puts the configured default model first if it appears in the list
  - On any error, falls back to `[configured_model]`
  - Updates cache and timestamp on success

**`get_models()` override:**

Returns `cls._fetch_available_models()`.

**`get_info()` augmentation:**

After building the options dict from `get_form_options()`, inserts a `"model"` key:

```python
options["model"] = {
    "type": "string",
    "label": "Model",
    "description": "Gemini model to use for extraction",
    "required": False,
    "options": cls._fetch_available_models()
}
```

**`_extract_refs_from_pdf()` update:**

Reads model from `options.get("model")` first, falls back to config value:

```python
model = options.get("model") or get_config().get("plugin.llamore.model", default="gemini-2.0-flash")
```

### No changes required

- `fastapi_app/plugins/llamore/config.py` — `FORM_OPTIONS` stays static; `model` is injected dynamically in `get_info()`
- `fastapi_app/plugins/llamore/plugin.py` — no changes
- Frontend — extraction dialog already renders string+options as dropdown

## Error handling

If the Gemini API is unreachable or returns an error when fetching models, `_fetch_available_models()` logs a warning and returns a single-item list with the configured default model. This keeps the dialog functional.

## Model filter

Include only models where:
- `name` starts with `models/gemini-`
- `supported_actions` includes `"generateContent"`

This excludes TTS, image-generation, and Gemma models from the list.
