# Anthropic Claude LLM Plugin

Registers Anthropic's Claude API as a provider in the core LLM provider registry (`fastapi_app/lib/llm/`), so Claude models can be selected wherever the registry is used (for example Tools > Default Model, the [Annotation Review](../annotation_review/README.md) plugin and the [LLamore extractor](../llamore_extractor/README.md)).

The plugin has no menu entries or routes of its own.

## Configuration

| Config key | Environment variable | Default |
| --- | --- | --- |
| `plugin.anthropic-llm.api.key` | `ANTHROPIC_API_KEY` | none (required) |
| `plugin.anthropic-llm.api.url` | `ANTHROPIC_API_URL` | `https://api.anthropic.com/v1` |

The plugin is unavailable without an API key. The provider is not registered when `FASTAPI_APPLICATION_MODE=testing`.

## Provider

- Provider ID: `anthropic`
- Models are listed live from the API's `/models` endpoint
- Supports PDF input: `chat_completion_with_pdf()` sends the PDF as a base64 `document` content block
- Retries a request without `temperature` when a model rejects that parameter

## Implementation

- **Plugin file**: [plugin.py](plugin.py)
- **Provider**: [llm_provider.py](llm_provider.py)
- **Tests**: [tests/](tests/)

## Technical Details

- Category: `inference`
- Requires: User role or higher
