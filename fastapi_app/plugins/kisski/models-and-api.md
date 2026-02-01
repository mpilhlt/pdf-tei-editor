# KISSKI SAIA API - Models and API Reference

Source: <https://docs.hpc.gwdg.de/services/saia/index.html>

## API Access

**Base URL:** `https://chat-ai.academiccloud.de/v1`

**Authentication:** Bearer token API key obtained through the KISSKI LLM Service booking page.

**Compatibility:** OpenAI API standard - can use OpenAI client libraries.

## Available Endpoints

| Endpoint | Purpose |
|----------|---------|
| `/chat/completions` | Chat interactions |
| `/completions` | Text completion |
| `/embeddings` | Vector embeddings |
| `/models` | List available models |
| `/documents` | Document processing |
| `/images/generations` | Text-to-image |
| `/edit-image/` | Image-to-image editing |
| `/audio/transcriptions` | Speech-to-text |
| `/audio/translations` | Speech translation |

## Available Models

### Text Models

- `meta-llama-3.1-8b-instruct`
- `llama-3.3-70b-instruct`
- `mistral-large-instruct`
- `apertus-70b-instruct-2509`
- `qwen3-30b-a3b-instruct-2507`
- `glm-4.7`
- `teuken-7b-instruct-research`

### Reasoning Models

- `deepseek-r1-0528`
- `deepseek-r1-distill-llama-70b`
- `qwen3-235b-a22b`

### Multimodal Models (Text + Image)

- `internvl3.5-30b-a3b`
- `gemma-3-27b-it`
- `qwen3-vl-30b-a3b-instruct`
- `medgemma-27b-it`

### Specialized Models

- `qwen3-coder-30b-a3b-instruct` (code)
- `qwen3-omni-30b-a3b-instruct` (omni)
- `llama-3.1-sauerkrautlm-70b-instruct` (German-optimized)

### Embedding Models

- `e5-mistral-7b-instruct`
- `multilingual-e5-large-instruct`
- `qwen3-embedding-4b`

### Image Generation

- `flux` (Flux.1-schnell backend)

### Image Editing

- `Qwen-Image-Edit`

### Audio

- `whisper-large-v2` (transcription/translation)

## Rate Limits

| Period | Limit |
|--------|-------|
| Per minute | 1,000 requests |
| Per hour | 10,000 requests |
| Per day | 50,002 requests |

Rate limit status available via response headers: `x-ratelimit-remaining-*` and `ratelimit-reset`.

## Code Examples

### List Available Models (curl)

```bash
curl https://chat-ai.academiccloud.de/v1/models \
  -H "Authorization: Bearer <api_key>"
```

Typed response:

```typescript
type InputModality = "text" | "image" | "video" | "audio" | "arcana";
type OutputModality = "text" | "thought";

interface Model {
  id: string;
  name: string;
  object: "model";
  owned_by: string;
  status: "ready" | string;
  created: number;
  demand: number;
  input: InputModality[];
  output: OutputModality[];
}

interface ModelsResponse {
  object: "list";
  data: Model[];
}
```

### List Available Models (Python)

```python
from openai import OpenAI

client = OpenAI(
    api_key='<api_key>',
    base_url="https://chat-ai.academiccloud.de/v1"
)

models = client.models.list()
for model in models.data:
    print(model.id)
```

### Chat Completion (Python)

```python
from openai import OpenAI

client = OpenAI(
    api_key='<api_key>',
    base_url="https://chat-ai.academiccloud.de/v1"
)

stream = client.chat.completions.create(
    messages=[{"role": "user", "content": "Your query"}],
    model="meta-llama-3.1-8b-instruct",
    stream=True
)

for chunk in stream:
    print(chunk.choices[0].delta.content or "", end="")
```

### Embeddings (curl)

```bash
curl https://chat-ai.academiccloud.de/v1/embeddings \
  -H "Authorization: Bearer <api_key>" \
  -H "Content-Type: application/json" \
  -d '{"input": "text to embed", "model": "e5-mistral-7b-instruct"}'
```

### Image Analysis (Python)

```python
import base64

with open("image.jpg", "rb") as f:
    base64_image = base64.standard_b64encode(f.read()).decode("utf-8")

response = client.chat.completions.create(
    model="gemma-3-27b-it",
    messages=[{
        "role": "user",
        "content": [
            {"type": "text", "text": "Describe this image"},
            {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{base64_image}"}}
        ]
    }]
)
```

### Document Conversion

POST to `/v1/documents/convert` with multipart form data. Supports output formats: markdown, HTML, JSON, tokens. Configurable table and image handling.
