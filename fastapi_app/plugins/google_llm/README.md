# Google Gemini LLM Plugin

Registers Google's Gemini API as a provider in the core LLM provider registry (`fastapi_app/lib/llm/`), so Gemini models can be selected wherever the registry is used (for example Tools > Default Model, the [Annotation Review](../annotation_review/README.md) plugin and the [LLamore extractor](../llamore_extractor/README.md)).

The plugin has no menu entries or routes of its own.

## Configuration

| Config key | Environment variable | Default |
| --- | --- | --- |
| `plugin.google-llm.api.key` | `GEMINI_API_KEY` | none (required) |

Obtain a key from Google AI Studio. The plugin is unavailable without an API key. The provider is not registered when `FASTAPI_APPLICATION_MODE=testing`.

## Provider

- Provider ID: `google`
- Uses the `google-genai` SDK
- Lists `gemini-*` models that support `generateContent`, excluding image, TTS, transcription and computer-use models
- Supports PDF input: `chat_completion_with_pdf()` uploads the PDF via the Files API, prompts with it and deletes it afterwards
- Sends `temperature` only to models before Gemini 3; Flash-Lite models of Gemini 3+ use a medium thinking level

## Implementation

- **Plugin file**: [plugin.py](plugin.py)
- **Provider**: [llm_provider.py](llm_provider.py)
- **Tests**: [tests/](tests/)

## Technical Details

- Category: `inference`
- Requires: User role or higher
