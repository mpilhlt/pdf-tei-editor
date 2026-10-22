# Inference endpoints plugin (issue #583)

Goal: use any OpenAI-compatible inference endpoint, in particular a model served by Ollama on the user's own computer, as LLM provider. Administrators add and remove any number of endpoints; API keys go to the encrypted secret store.

## Where the requests are made, and CORS

All LLM consumers (LLamore and metadata extraction, annotation review, archival edition) run in the backend and call `LLMProviderRegistry`. The endpoint is therefore called by the server:

- CORS does not apply, since CORS is enforced by browsers only. `OLLAMA_ORIGINS` is not needed.
- The endpoint must be reachable from the server. `localhost` is the machine (or container) the editor runs on.

Consequences for a model on the user's computer:

| Editor runs | Base URL |
| --- | --- |
| Locally | `http://localhost:11434/v1` |
| Locally in Docker | `http://host.docker.internal:11434/v1` (Linux: `--add-host=host.docker.internal:host-gateway`, `OLLAMA_HOST=0.0.0.0`) |
| On a server | Not reachable directly. VPN (Tailscale address), SSH reverse tunnel (`ssh -N -R 11434:localhost:11434 server`), or a tunnel service with an authenticating proxy in front of Ollama |

A browser-direct mode (the browser calls `http://localhost:11434` with `OLLAMA_ORIGINS` set to the editor's origin) was rejected: every consumer would need a browser-side relay that receives prompts from the server and returns the completions, the server would depend on the browser tab staying open during long extractions, and Chrome's local network access restrictions prompt for or block requests from a public origin to `localhost`. It is the only option that avoids a tunnel when the editor runs remotely; it can be revisited if that case becomes common.

## Design

New package `pte-plugin-inference-endpoints` in mpilhlt/pte-plugins (`plugins/inference-endpoints/`).

- **Storage**: `data/db/inference-endpoints.json` (name, base URL, key mode, models, vision, free, timeout). Every worker polls the file's mtime every 5 seconds and re-registers its providers, since production runs several workers with separate registries.
- **Providers**: one `EndpointLLMProvider` per endpoint, id `endpoint-<slug>`. `POST /chat/completions` (non-streaming), `GET /models` when no models are configured. Images as `image_url` data URLs when "vision" is set. Errors become `LLMProviderError`. Model listing has no retries and a 10 s timeout so that an offline laptop does not stall the model picker; completions use the endpoint's timeout (default 600 s) without read retries.
- **Keys**: key mode `none` (Ollama), `shared` (stored in the secret store under the pseudo user `:inference-endpoints`, read on every request so that all workers see a change), or `user` (each endpoint registers the secret service `inference-endpoint-<slug>`; users store their keys in the API Keys dialog). Keys are never returned by the API.
- **Free flag**: models of an endpoint can be marked free, so that non-admin users may use them (otherwise the core's model access rules restrict them to admins unless one is the default model).
- **UI and API**: admin-only plugin menu entry "Inference endpoints" opening `/api/plugins/inference-endpoints/manage` (list, add, test, delete). No edit; delete and add again.

## Server-side request forgery

Endpoint URLs make the server send requests, so management is admin-only, and:

- `http`/`https` only, no credentials, query or fragment in the URL
- loopback and private addresses allowed (needed for Ollama, VPNs); link-local (incl. `169.254.169.254` cloud metadata), multicast and unspecified addresses always rejected
- optional operator allowlist `INFERENCE_ENDPOINTS_ALLOWED_HOSTS` (host names, `*.domain`, CIDR networks), read from the environment only so that admins cannot widen it through the config editor
- check on save and before every request; redirects are not followed. DNS rebinding between the check and the request is not prevented.

## Core change

`SecretServiceRegistry.unregister()` / `unregister_secret_service()` in `fastapi_app/lib/secrets/`, so that a deleted endpoint disappears from the API Keys dialog. The plugin calls it only if present, so it also works with core 0.76.0.

## Follow-up

After the pte-plugins PR is merged: add the `inference-endpoints` extra (and the `all` extra entry) to `pyproject.toml`, bump the pinned pte-plugins rev and `uv lock`, so the package is installable with the editor's extras.
