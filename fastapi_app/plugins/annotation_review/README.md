# Annotation Review Plugin

Reviews the annotations in the open TEI document against the annotation rules the document itself links to, using a large language model (LLM). Suggestions appear as highlighted passages in the XML editor; each has a "Propose fix" action that shows the change in the merge view. Nothing is changed unless the user accepts a fix.

## For site admins and maintainers

### What it contributes

- A **Review Annotations** item in the Tools menu (under "Annotation"). It is enabled only when the open document's `teiHeader/encodingDesc/editorialDecl` contains a rule reference with `subtype="machine"` (a link to a machine-readable rules file, usually raw Markdown). Otherwise it is disabled and a tooltip explains why.
- A confirmation dialog naming the provider/model that will be used, then a progress widget (minimizable, with a cancel button) that shows "part i of n" while the document is reviewed piece by piece.
- Suggestions as info-level diagnostics in the editor's lint panel and gutter, merged with the TEI validation diagnostics. Each carries the model's rationale and a "Propose fix" button.

The rules to review against are taken from the document, not from server configuration: every `editorialDecl` category with a machine-readable ref is fetched (via the shared rule cache in `data/annotation-rules/cache`) and included in the prompt.

### Requirements

- At least one LLM provider must be configured. Providers are separate plugins that register with the core LLM registry:

  | Provider | Plugin | Secret |
  | --- | --- | --- |
  | KISSKI Academic Cloud | `kisski` | `KISSKI_API_KEY` |
  | Anthropic Claude | `anthropic_llm` | `ANTHROPIC_API_KEY` |
  | Google Gemini | `google_llm` | `GEMINI_API_KEY` |

- The server must be able to reach the URLs of the rule files (see [Security](#security)).

### Choosing and restricting models

The model used is chosen in the **Tools > Inference** menu (provided by the core `inference-settings` plugin):

- **Admins** set the installation-wide default, stored in the config as `llm.default-model.provider` and `llm.default-model.model`.
- **Other users** can pick a model for their own browser session, for example when the default is busy. It overrides the default until the session ends.
- Providers flag each model as **free** or not (KISSKI: free; Anthropic, Google: not). Non-admins can only select free models, plus the configured default even if it is not free. The `/review` route enforces this on the server, not just in the menu.
- Models a provider reports as busy are marked with a warning icon.

Config keys (all under `config.json`, editable in the Configuration Editor):

| Key | Env var | Meaning |
| --- | --- | --- |
| `llm.default-model.provider` / `.model` | `LLM_DEFAULT_PROVIDER` / `LLM_DEFAULT_MODEL` | Default model for everyone |
| `llm.model-filter.include` | `LLM_MODEL_FILTER_INCLUDE` | If set, only matching models are listed and usable |
| `llm.model-filter.exclude` | `LLM_MODEL_FILTER_EXCLUDE` | Matching models are never listed or usable; wins over include |

Filter values are comma-separated, double-quoted regular expressions matched (substring search) against the label shown in the menu, `"<Provider>/<Model>"`, for example `"Flash", "^KISSKI/"`. A value without quotes is treated as one single pattern.

### Cost and duration

Long documents are reviewed in chunks of about 8000 characters, one LLM call per chunk, sequentially. The rule excerpts are sent with every chunk, so the token cost is roughly the excerpt size times the number of chunks plus the document once. Reviews of a full paper can take minutes, and paid models cost money per review; use the include/exclude filter and the free-model rule to control this.

### Security

The rule URLs come from the (client-supplied) document, so the server fetches them defensively: only `http`/`https`, the host must resolve to a globally routable address (no loopback, private, link-local or CGNAT ranges), and redirects are not followed. A known residual risk is DNS rebinding (the address is checked at request time, not pinned at connect time).

### Failure behavior

- The provider is unreachable or rejects the request (overload, rate limit, invalid model): the review stops with an error naming the failing part; suggestions from earlier parts stay visible. The user can simply run the review again.
- The model returns something that is not a JSON list: the review fails with an error showing the start of the response. A response cut off mid-list keeps the complete suggestions and logs a warning.
- Suggestions whose quoted text does not occur exactly once in the document are dropped (logged as a warning, with the count of kept versus returned suggestions per chunk in `app.log`).

### Tests

```bash
uv run python tests/unit-test-runner.py fastapi_app/plugins/annotation_review
node --test fastapi_app/plugins/annotation_review/tests/annotation-review.test.js
```

The extension tests are not picked up by `npm run test:unit:js` and therefore not run in CI.

## For developers

### Layout

```text
annotation_review/
  plugin.py                    Plugin class; registers the frontend extension
  routes.py                    POST /plan and POST /review
  review_logic.py              text extraction, rule gathering, review orchestration
  chunking.py                  splits <text> into review-sized raw substrings
  prompts.py                   prompt building, response parsing and validation
  extensions/annotation-review.js   frontend extension (menu, progress, diagnostics)
  tests/                       Python unit tests and the extension's node tests
```

The design rationale is in `docs/superpowers/specs/2026-09-24-llm-annotation-review-design.md` (Parts C to F).

### Request flow

```text
Tools > Review Annotations
  -> confirm dialog (model label)
  -> POST /plan {xml}                       -> {chunk_count}
  -> for i in 0..n-1:
       POST /review {xml, provider_id, model_id, chunk_index: i}
         check_model_access()               (filter, free/default rule)
         extract_text_content(xml)          raw <text>...</text> substring
         split_into_chunks() -> chunk i
         gather_rule_excerpts(xml)          one excerpt per category
         provider.chat_completion(...)
         parse_and_validate_findings(raw, whole <text>)
       -> {findings, chunk_count}
       extension merges diagnostics after each chunk
```

The frontend drives the loop and sends the full (possibly unsaved) editor content with every call, so the backend is stateless. `/plan` only counts chunks, which lets the progress bar be determinate from the start.

### Key design points

- **Raw substrings, not re-serialization.** `extract_text_content()` validates the XML with lxml but returns the `<text>` element exactly as it appears in the request string, and `split_into_chunks()` only cuts that string. A finding's `old` snippet therefore matches the editor's text byte for byte, which the frontend relies on to place highlights.
- **Chunking.** `split_into_chunks()` tokenizes tags with a regex, computes the element depth at every closing tag, and picks the shallowest depth at which every unit fits `CHUNK_MAX_CHARS`; units are then packed greedily. Concatenating the chunks yields the input. An oversized unit stays whole. Chunks may start or end with unbalanced tags, which the prompt mentions.
- **Anti-hallucination validation.** A finding is kept only if it is an object with string `old`, `new` and `rationale`, and `old` occurs exactly once in the whole `<text>` (not only in the chunk, because the editor needs a unique location). Everything else is dropped and logged. The system prompt asks for the smallest unique snippet, verbatim, and one non-overlapping finding per problem.
- **Tolerant parsing.** `_extract_json_list()` finds a JSON list anywhere in the response (markdown fences, prose), and `_salvage_truncated_list()` recovers complete objects from a list cut off by the output token limit. No list at all raises `UnusableResponseError`, which is a failed review, not "no issues".
- **Error mapping** (`routes.py`): 404 unknown provider, 403 model not permitted, 422 malformed XML or no machine rules or bad `chunk_index`, 502 for provider failures (`LLMProviderError`, `requests` errors, unusable response).
- **Blocking work off the event loop.** Rule fetching (`requests`, DNS) runs in `asyncio.to_thread`.

### Frontend extension

`extensions/annotation-review.js` is transformed into an IIFE by the frontend-extension mechanism (imports are stripped, only the default class is registered; see `docs/development/frontend-extensions.md`), and it extends `FrontendExtensionPlugin`. Dependencies it uses through `getDependency()`: `xmleditor`, `tools`, `lint-utils`, `tei-utils`, `sl-utils`, `dialog`, `progress`, `inference-settings`.

- `review(override, hooks)` runs `/plan` and the chunk loop and returns all findings (or null after a notified failure); `hooks.onStart`, `hooks.onProgress` and `hooks.isCancelled` let `runReview()` drive the progress widget.
- `runReview()` shows the confirmation, creates the progress widget with an `onCancel` callback, displays findings incrementally, and reports the result.
- **Diagnostics merging.** CodeMirror keeps a single global diagnostic set that each `setDiagnostics` replaces. The extension tags its diagnostics `source: 'annotation-review'` and merges them with the foreign ones through `app/src/modules/lint-utils.js` (`applyMergedDiagnostics`). When another source (TEI validation) replaces the set, the extension re-merges from an update listener, deferred with `setTimeout` because dispatching inside a listener is illegal. The lint panel is opened only for the first batch of findings.
- **Stale findings.** After document edits (debounced 300 ms), findings whose `old` no longer occurs exactly once, for example after an accepted fix, are dropped.
- **Propose fix.** `buildModifiedText()` builds the document text with only that finding applied and passes it to `xmleditor.showMergeView()`.
- Exported helpers `locateFinding`, `buildModifiedText` and `findingsToDiagnostics` are pure and unit-tested without a DOM.

### Related core pieces

- `fastapi_app/lib/llm/` - provider registry, `LLMModel` (with `free`), `LLMProviderError`, model filter, default model, `check_model_access()`.
- `fastapi_app/routers/llm.py` - `GET /api/v1/llm/providers`, `GET`/`PUT /api/v1/llm/default-model`.
- `app/src/plugins/inference-settings.js` - the Tools > Inference menu, default vs. session model, `getDefaultModel()` and `getModelLabel()`.
- `app/src/plugins/progress.js` - the progress widget (`show`, `setValue`, `setLabel`, `hide`, `onCancel`).
- `fastapi_app/lib/utils/annotation_rules_utils.py` - `extract_annotation_rule_refs()` and `fetch_rule_excerpt()`.

### Extending

- **New provider:** implement `LLMProvider` in its own plugin and register it in the registry; set `free` on each `LLMModel`. No change is needed here.
- **Chunk size:** `CHUNK_MAX_CHARS` in `chunking.py`. Smaller chunks give faster, shorter responses and more calls.
- **Prompt changes:** `build_system_prompt()` in `prompts.py`; keep the "verbatim and unique" contract, because the validation depends on it.
