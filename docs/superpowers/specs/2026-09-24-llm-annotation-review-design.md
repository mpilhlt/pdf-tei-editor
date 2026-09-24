# Design: LLM-based annotation review against `editorialDecl` rules

Date: 2026-09-24
Status: approved (pending spec review)

## Problem

`encodingDesc/editorialDecl` already lets a document carry machine-readable
pointers to the annotation rules that governed its extraction/correction
(see [2026-09-22-editorial-decl-annotation-rules-design.md](./2026-09-22-editorial-decl-annotation-rules-design.md)
and [tei-header-integrations.md](../../development/tei-header-integrations.md#encodingdesceditorialdecl-annotation-rules)).
No consumer of the `machine`-subtype rule excerpts exists yet — that spec
explicitly stops at the plumbing. This design adds the first real consumer:
an in-editor LLM-based review that checks a document's annotations against
its own linked rules and surfaces suggested fixes with rationale.

Separately, the codebase has no unified way to call an OpenAI-API-compatible
inference endpoint. `kisski/extractor.py` has its own ad hoc HTTP client and
env-var-by-convention config; `tei_annotator`'s "provider"/"model" config
only forwards those as parameters to an *external* webservice, it doesn't
call an inference endpoint directly. A second, hardcoded integration for
this review feature would entrench that duplication further. This design
generalizes the pattern into a core registry so future providers (openai,
ollama, a direct Gemini/Anthropic client, ...) plug in without touching
consumer code.

## Scope

Modular, independently implementable/deferrable parts:

| Part | What |
| --- | --- |
| A | Core LLM Provider Registry (`fastapi_app/lib/llm/`) |
| B | Kisski migration onto the registry (BC-preserving) |
| C | `annotation_review` backend plugin (rule reading, prompting, review endpoint) |
| D | Frontend trigger wiring (repurpose the xmleditor "validate" button) |
| E | Diagnostics + scoped "Propose fix" diff UI |
| F | Endpoint/model selection UI |

Out of scope, not built in this round:

- Any provider plugin beyond Kisski (openai, ollama, direct Gemini/Anthropic,
  ...) — Part A's registry is built to make adding these a self-contained
  follow-up, not a prerequisite.
- Persisting review findings or rationale into the document (e.g. as
  `<!-- review: ... -->` comments) — the accepted design (Part E) never
  writes anything but the accepted replacement text itself, so there is
  nothing to strip later and no "enhancement" plugin is needed for this.
- Automatic/background review (e.g. on save, or on a schedule) — this is a
  manually triggered, single-document, single-run action only.

## Part A — Core LLM Provider Registry

New module `fastapi_app/lib/llm/`, modeled directly on the existing
`ExtractorRegistry` pattern (`fastapi_app/lib/extraction/registry.py`:
singleton `get_instance()`, `register()`/`list_x()`/`get_x()`, class-based
entries) rather than the generic capability-keyed `ServiceRegistry`
(`fastapi_app/lib/services/service_registry.py`) — the registry needs to
enumerate and list multiple simultaneously-registered providers for the
caller to pick from, not resolve a single active implementation per
capability the way `ServiceRegistry` does.

`fastapi_app/lib/llm/base.py`:

```python
class LLMModel(TypedDict):
    id: str
    label: str
    capabilities: frozenset[str]  # extensible tags, e.g. {"chat", "json_mode"}

class LLMProvider(ABC):
    id: str
    label: str

    @classmethod
    def is_available(cls) -> bool: ...

    def list_models(self) -> list[LLMModel]: ...

    async def chat_completion(
        self, model_id: str, system_prompt: str, user_prompt: str,
        temperature: float = 0.2,
    ) -> str: ...
```

`capabilities` is a loose, extensible set of string tags rather than fixed
typed fields (`context_window: int`, `supports_vision: bool`, ...) —
simplest thing that lets a future consumer filter on a tag it cares about
(e.g. `"json_mode"`) without the registry needing to know every provider's
feature matrix up front.

`fastapi_app/lib/llm/openai_compatible.py`:

```python
class OpenAICompatibleProvider(LLMProvider):
    """Concrete base for providers speaking the OpenAI chat/completions wire format."""

    def __init__(self, id: str, label: str, base_url: str, api_key: str): ...
    # implements chat_completion() via POST {base_url}/chat/completions
    # implements list_models() via GET {base_url}/models when available
```

Providers that speak a different native API (a hypothetical direct Gemini or
Anthropic connector, as opposed to Kisski — which *hosts* Gemma models
behind an OpenAI-compatible endpoint, it isn't Google's own Gemini API)
implement `LLMProvider` directly instead of subclassing this.

`fastapi_app/lib/llm/registry.py`:

```python
class LLMProviderRegistry:
    @classmethod
    def get_instance(cls) -> "LLMProviderRegistry": ...
    def register(self, provider: LLMProvider) -> None: ...
    def unregister(self, provider_id: str) -> None: ...
    def list_providers(self, available_only: bool = True) -> list[LLMProvider]: ...
    def get_provider(self, provider_id: str) -> LLMProvider: ...
```

### Registration lifecycle

Following the confirmed plugin lifecycle (`PluginRegistry`/`PluginManager`,
`fastapi_app/lib/plugins/plugin_registry.py`): each provider plugin's
`__init__()` registers its own config keys (env vars, following the existing
`get_plugin_config()` convention — every provider plugin decides its own
variable names, nothing hardcoded in core) and its `is_available()`
classmethod reflects whether that config resolved to a usable value, exactly
like `LLMBaseExtractor.is_available()` does today. Actual registration into
`LLMProviderRegistry` happens in the plugin's `initialize()` method (not
`__init__`), mirroring how `KisskiPlugin.initialize()` already registers
into both `ExtractorRegistry` and `ServiceRegistry` — guarded by an
availability check so a missing API key results in a skipped registration
and a logged warning, never a startup failure.

Consumers (Part C's review plugin) never declare a plugin `dependencies`
relationship on any specific provider plugin. HTTP routes only start
receiving requests after every plugin's `initialize()` has completed
(`PluginManager.initialize_plugins()` finishes, then routes are mounted), so
querying `LLMProviderRegistry.get_instance().list_providers()` lazily inside
a route handler is always safe regardless of provider/consumer plugin
ordering — this is what gives the "switch providers without hardcoded
coupling" property asked for.

## Part B — Kisski migration

`KisskiPlugin.initialize()` gains one more registration call, alongside its
existing `ExtractorRegistry`/`ServiceRegistry` registrations:
`LLMProviderRegistry.get_instance().register(OpenAICompatibleProvider(id="kisski", ..., base_url=..., api_key=...))`,
guarded by `is_available()` the same way its existing `ServiceRegistry`
registration already is.

`KisskiExtractor._call_llm` becomes a thin call into that same connector
object instead of doing its own `requests.post` — the extractor's public
API and behavior are unchanged (backward compatible), only the internal HTTP
call is unified with the shared client. Kisski's config keys
(`KISSKI_API_KEY`/`KISSKI_API_URL`) are unchanged.

**Verify during implementation** (not assumed by this design): what
`KisskiService` (already registered in the generic `ServiceRegistry`,
`fastapi_app/plugins/kisski/plugin.py`) actually does, to confirm it's
unrelated to chat completion and there's no overlap to reconcile.

## Part C — `annotation_review` backend plugin

New plugin `fastapi_app/plugins/annotation_review/` (directory name
underscored per convention; URL/dependency name `annotation-review`),
following the `tei_annotator` template (`fastapi_app/plugins/tei_annotator/`)
for the backend-plugin-registers-a-frontend-extension shape.

**Routes** (`routes.py`):

- `GET /api/plugins/annotation-review/providers` → `LLMProviderRegistry.get_instance().list_providers(available_only=True)`,
  each with its `list_models()`, shaped for the frontend's endpoint/model
  picker (Part F).
- `POST /api/plugins/annotation-review/review` → body `{xml, provider_id,
  model_id}` (the **current, possibly-unsaved editor content** is sent
  directly, not a file reference — the review must reflect what's on screen,
  not the last-saved revision). Returns `{findings: [{id, old, new,
  rationale}]}`.

**Review logic**: reads the document's `editorialDecl` via
`extract_annotation_rule_refs()` (already exists,
`fastapi_app/lib/utils/annotation_rules_utils.py`) — **every** category
present is checked, not just `primary` (per earlier confirmation). For each
category, resolves its `machine`-subtype ref via the existing
`fetch_rule_excerpt()` and builds one combined prompt containing all
category excerpts plus the document's `<text>` content. Calls
`LLMProviderRegistry.get_provider(provider_id).chat_completion(model_id,
system_prompt, user_prompt)`.

**Response contract**: the LLM is instructed (system prompt + a JSON schema
in the prompt) to return a JSON array:

```json
[{ "old": "<verbatim original XML snippet>", "new": "<suggested replacement>", "rationale": "<why>" }]
```

The backend validates every finding before returning it: `old` must occur
**exactly once** in the source text that was sent to the LLM. A finding
whose `old` is absent or ambiguous (appears more than once) is dropped and
logged — this is the primary defense against hallucinated or
under-specified findings, enforced server-side before the frontend ever sees
them. The prompt instructs the model to include enough surrounding context
in `old` to make it uniquely identifying.

**Frontend extension** (`extensions/annotation-review.js`): extends
`FrontendExtensionPlugin` (`app/src/modules/frontend-extension-plugin.js`),
registered via `FrontendExtensionRegistry` in the plugin's `initialize()`
(matching `tei_annotator/plugin.py`). Confirmed:
`FrontendExtensionPlugin extends Plugin`, so it participates in the same
`deps`/`getDependency()` system as every core `app/src/plugins/*` plugin —
other plugins can depend on and call it exactly like any built-in plugin.
Exposes:

- `review()` — calls the two routes above via `callPluginApi()`, drives the
  diagnostics (Part E).
- `hasReviewableRules(xmlDoc)` — `true` if `getEditorialDeclGuides(xmlDoc)`
  finds at least one category with a `subtype="machine"` ref. Drives the
  toolbar button's disabled state (Part D).

## Part D — frontend trigger wiring

`app/src/plugins/xmleditor.js`'s existing `#validateBtn` click handler
currently calls `getDependency('tei-validation').validate()`
(`xmleditor.js:488-491`) — confirmed this is a real, working manual
re-check + toast, not dead code, but it duplicates the always-on
`tei-validation` linter's coverage. Per direction, it's repurposed anyway:

- Click handler is changed to call `getDependency('annotation-review').review()`.
- The button's disabled state is driven by `hasReviewableRules()` on the
  currently loaded document, re-evaluated on document load/change. This is
  new gating behavior for this button — the research done for this design
  didn't establish that `tei-validation` currently disables/enables it
  conditionally, so this isn't a case of mirroring existing logic; verify
  during implementation how `#validateBtn`'s enabled/disabled state is
  currently wired in `xmleditor.js` before changing it.
- `tei-validation.js`'s linter (the always-on gutter/diagnostics source)
  is untouched — only the toolbar button's manual-trigger role moves.

## Part E — diagnostics + scoped "Propose fix" diff

Findings become a **second `linter()` source** composed alongside
`tei-validation`'s existing one (CodeMirror supports multiple simultaneous
lint sources) — verify during implementation that both sources' diagnostics
render coherently together in the same gutter/panel.

- Each finding becomes a `severity: "info"` `Diagnostic`, positioned at
  wherever `old` is found in the **current** editor text (re-verified
  client-side, since the document may have changed between the request
  being sent and the response arriving — a finding whose `old` no longer
  matches is silently dropped, not shown as an error).
- The diagnostic's message is the rationale. Its `actions` array has one
  entry, `"Propose fix"`, whose `apply(view, from, to)`:
  1. builds a single-finding modified copy of the document text (`old` →
     `new`, applied once, at that specific `from`/`to`);
  2. calls the existing `showMergeView()` (`app/src/modules/xmleditor.js`,
     already used by `tei-wizard.js` to preview enhancement transforms) on
     that modified copy.
- Because only one span differs between the live document and the modified
  copy, the resulting diff has exactly **one hunk** — accepting "all
  changes" in the existing merge view is equivalent to accepting just this
  one finding. This reuses `showMergeView`/`hideMergeView` as-is; no new
  diff-rendering or accept/reject UI code is needed. Verify during
  implementation the exact accept/reject command names already used by
  `tei-wizard.js`'s merge-view flow.
- This also means no document mutation happens until the user explicitly
  invokes "Propose fix" and accepts the resulting single-hunk diff — matches
  the "proposal view, explicit accept/reject" direction. Rejected or
  never-actioned findings leave the document untouched; nothing needs
  cleaning up afterward.

## Part F — endpoint/model selection UI

A small dropdown/popover, opened from the (repurposed) toolbar button,
listing `GET .../providers` results (provider → its models). Last choice is
remembered via `UIStorage` (`docs/code-assistant/ui-storage.md`'s existing
localStorage-wrapper pattern), so a reviewer doesn't re-pick every time.

## Error handling

- No `editorialDecl` machine-subtype rules present → button stays disabled
  (existing disabled-button pattern, just repointed to
  `hasReviewableRules()`).
- LLM/network failure calling the chosen provider → toast error, button
  re-enabled, no partial diagnostics left behind.
- Malformed/non-JSON LLM response → treated as zero findings, plus a toast
  noting the response couldn't be parsed (logged for debugging).
- Zero findings → toast "No issues found".
- A finding whose `old` doesn't occur exactly once in the source sent to the
  LLM → dropped server-side, logged, never reaches the frontend.
- A finding whose `old` no longer matches the live editor text by the time
  the response arrives (document edited meanwhile) → dropped client-side,
  silently.
- Provider/model becomes unavailable between listing and use (e.g. config
  removed mid-session) → the `POST .../review` call fails with a clear
  error surfaced as a toast; the picker (Part F) re-fetches `GET
  .../providers` on next open so it self-corrects.

## Testing

- Part A: unit tests for `LLMProviderRegistry` (register/list/get,
  `available_only` filtering) and `OpenAICompatibleProvider` (mocked HTTP,
  `chat_completion`/`list_models`).
- Part B: unit test confirming `KisskiExtractor._call_llm` delegates to the
  shared connector and existing Kisski extractor tests still pass unchanged
  (behavioral BC check).
- Part C: unit tests for prompt construction from multiple `editorialDecl`
  categories, and for finding validation (the exactly-once `old`-match
  check: absent, unique, and ambiguous/duplicate cases).
- Part D/E: JS unit tests building diagnostics from fixture findings
  (including the stale-match-drop case), and the single-hunk modified-doc
  construction for "Propose fix".
- Test locations follow existing conventions: plugin-specific tests in
  `fastapi_app/plugins/annotation_review/tests/` and
  `fastapi_app/plugins/kisski/tests/`, generic core-utility tests in
  `tests/unit/fastapi/`, frontend tests in `tests/unit/js/`.

## Open verification items for implementation

- Confirm `KisskiService`'s existing `ServiceRegistry` role doesn't overlap
  with the new registration (Part B).
- Confirm multiple simultaneous `linter()` sources compose visibly/correctly
  in the CodeMirror lint panel and gutter (Part E).
- Confirm the exact merge-view accept/reject command names already used by
  `tei-wizard.js` (Part E), rather than assuming an API shape.
