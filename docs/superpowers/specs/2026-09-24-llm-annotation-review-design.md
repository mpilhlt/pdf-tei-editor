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
| D | Tools-menu trigger, "Annotation" category |
| E | Diagnostics + scoped "Propose fix" diff UI |
| F | Default-model selection plugin, "Inference" category |

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
- Any change to the xmleditor "validate" toolbar button. Direction reversed
  mid-design: it's left exactly as-is (still `tei-validation`'s manual
  re-check + toast). Removing it entirely is a possible separate, later,
  unrelated task — not part of this design.
- A per-call provider/model override UI in the review action itself. The
  backend API (Part C) accepts an optional override, but no frontend control
  is built for it in this round — the review action always uses Part F's
  shared default.

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
class ModelStatus(TypedDict):
    availability: Literal["available", "busy", "very_busy"]
    detail: str  # human-readable elaboration for a warning tooltip, e.g. "demand: 5"

class LLMModel(TypedDict):
    id: str
    label: str
    capabilities: frozenset[str]  # extensible tags, e.g. {"chat", "json_mode"}
    status: ModelStatus | None  # None when the provider exposes no live status

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

`ModelStatus` is deliberately provider-agnostic: `availability` is a fixed
3-tier enum any provider can normalize its own live-load signal onto (this
codebase's only current example, Kisski's numeric "demand", is one such
signal — a future provider with a different raw busy-indicator maps onto
the same three values rather than inventing its own vocabulary the frontend
would need to special-case). `detail` carries whatever provider-specific
elaboration is useful in a tooltip (e.g. Kisski's raw demand number as
text). `list_models()` returns `status: None` per model for any provider
that doesn't expose this (most commercial APIs) — absence of data, not an
implicit "available". Don't confuse this with `LLMProvider.is_available()`:
that's whether the *provider* is configured/usable at all (API key present);
`ModelStatus.availability` is a *model's* live load state, queried only for
providers that support it.

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

Consumers (Part C's review plugin, Part F's default-model picker) never
declare a plugin `dependencies` relationship on any specific provider
plugin. HTTP routes only start receiving requests after every plugin's
`initialize()` has completed (`PluginManager.initialize_plugins()`
finishes, then routes are mounted), so querying
`LLMProviderRegistry.get_instance().list_providers()` lazily inside a route
handler is always safe regardless of provider/consumer plugin ordering —
this is what gives the "switch providers without hardcoded coupling"
property asked for.

### Core listing route

The registry itself is a bare library module, not a `Plugin` — nothing
"owns" it the way `annotation_review` will own its own routes. Precedent:
`ExtractorRegistry` (`fastapi_app/lib/extraction/registry.py`) is exposed
generically via a core router, `fastapi_app/routers/extraction.py`'s `GET
/extract/list`, not by any single extractor plugin. A new core router,
`fastapi_app/routers/llm.py`, follows the same shape: `GET
/api/v1/llm/providers` → `LLMProviderRegistry.get_instance().list_providers(available_only=True)`,
each with `list_models()`, shaped for consumption by both Part C's review
action and Part F's default-model picker — neither needs its own
provider-listing endpoint. Registered in `fastapi_app/main.py` alongside
the other core routers; regenerating `app/src/modules/api-client-v1.js`
(auto-generated from the OpenAPI schema) picks it up automatically.

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

### Live model status (demand/busy warning)

Kisski's `/models` endpoint reports a per-model `demand` integer, letting a
caller avoid picking an over-loaded model that's likely to time out. A
sibling project (`/Users/cboulanger/Code/zotero-rag/backend/utils/kisski.py`)
already implements this classification — reused here as the canonical
thresholds rather than inventing new ones:

```python
def _demand_to_availability(demand: int) -> Literal["available", "busy", "very_busy"]:
    if demand == 0:
        return "available"
    if demand <= 5:
        return "busy"
    return "very_busy"
```

Kisski's provider's `list_models()` populates each `LLMModel.status` with
`ModelStatus(availability=_demand_to_availability(demand), detail=f"demand: {demand}")`.
This is Kisski-specific logic, not part of `OpenAICompatibleProvider` — that
base class always returns `status: None`, since a live demand signal isn't
part of the standard OpenAI wire format; only Kisski's concrete provider
class overrides model listing to populate it. A future provider with its
own busy-signal (if one ever exposes one) would write its own analogous
mapping onto the same `ModelStatus.availability` vocabulary.

**Verify during implementation**: the sibling project's backend fetches
this via `POST {base_url}/models` specifically to get the demand-augmented
response, while this codebase's existing `KisskiExtractor._fetch_models_from_api`
does a plain `GET {base_url}/models` (per earlier research,
`fastapi_app/plugins/kisski/extractor.py:60-82`) — confirm whether GET also
returns `demand`, or whether the new provider's `list_models()` genuinely
needs the POST variant, before assuming either shape.

## Part C — `annotation_review` backend plugin

New plugin `fastapi_app/plugins/annotation_review/` (directory name
underscored per convention; URL/dependency name `annotation-review`),
following the `tei_annotator` template (`fastapi_app/plugins/tei_annotator/`)
for the backend-plugin-registers-a-frontend-extension shape.

**Routes** (`routes.py`):

- `POST /api/plugins/annotation-review/review` → body `{xml, provider_id?,
  model_id?}` (the **current, possibly-unsaved editor content** is sent
  directly, not a file reference — the review must reflect what's on screen,
  not the last-saved revision). `provider_id`/`model_id` are an explicit
  per-call override; when omitted, the frontend extension fills them from
  Part F's shared default before calling this route — the backend route
  itself has no notion of "default", it just requires a resolved
  provider+model on every call. Returns `{findings: [{id, old, new,
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

- `review()` — resolves provider/model from `getDependency('inference-settings').getDefaultModel()`
  (Part F) unless called with an explicit override, calls the `review` route
  via `callPluginApi()`, drives the diagnostics (Part E).
- `hasReviewableRules(xmlDoc)` — `true` if `getEditorialDeclGuides(xmlDoc)`
  finds at least one category with a `subtype="machine"` ref. Drives the
  Tools-menu item's disabled state (Part D).

### Chunked review

Reviewing a long document in one call is slow and can exceed the model's
output limit, and most of the document is irrelevant to judging any single
annotation. The route therefore reviews one chunk per call: the request takes
an optional `chunk_index` (default 0) and the response adds `chunk_count`.
`chunking.split_into_chunks()` splits the raw `<text>` string at element
boundaries (shallowest depth at which every unit fits `CHUNK_MAX_CHARS`), so
chunks are exact substrings and a finding's `old` still matches the editor
text. Findings are validated for uniqueness against the whole `<text>`, not
the chunk. The rule excerpts are re-sent with every chunk (cheap with
provider prompt caching). The extension's `review()` requests chunks
sequentially; `runReview()` shows them behind the shared progress widget
(minimizable, cancellable via `onCancel`), displays findings as each chunk
completes, and keeps partial results on cancel or on a failed chunk.

## Part D — Tools-menu trigger

The xmleditor "validate" toolbar button is left untouched (see "Out of
scope" — this direction was reversed mid-design). Instead, `annotation-review.js`
adds its own entry to the Tools menu, following the exact pattern already
proven by `fastapi_app/plugins/tei_annotator/extensions/tei-annotator.js:59-78`
(a plain `sl-menu-item`, not a submenu, since there's only one action):

```js
const item = document.createElement('sl-menu-item');
item.textContent = 'Review Annotations';
item.disabled = true; // refreshed via hasReviewableRules(), see below
item.addEventListener('click', () => this.runReview());
this.getDependency('tools').addMenuItems([item], 'annotation');
```

- `'annotation'` is an existing category (already used by `tei_annotator`,
  `fastapi_app/plugins/tei_annotator/plugin.py:33`) — the item groups under
  the Tools menu's existing "Annotation" heading, no new category needed.
- The item is added in `start()`. `disabled` starts `true` and is refreshed
  from `hasReviewableRules()` on the `editorReady` event and on document
  change (`onXmlChange`). It is not disabled for malformed XML (`getXmlTree()`
  returns the last good tree); the backend answers 422 and the user gets the
  "Annotation review failed" notice,
  mirroring how `tei-annotator.js` keeps a reference to its own
  menu item(s) and toggles them post-construction.
- `tools.addMenuItems(elements, category)` (`app/src/plugins/tools.js:94`)
  is the generic imperative Tools-menu API; both core `app/src/plugins/*.js`
  plugins and backend-plugin frontend extensions call the identical method
  — no template or `tools.js` change needed for this part.

## Part E — diagnostics + scoped "Propose fix" diff

Findings are merged into CodeMirror's single global diagnostic set through
the `lint-utils` module (`app/src/modules/lint-utils.js`, reachable via
`getDependency('lint-utils')`). A second `linter()` source is not viable:
`setDiagnostics` replaces the whole set, so it would overwrite (or be
overwritten by) `tei-validation`'s results. The extension stores its findings,
tags its diagnostics with `source: 'annotation-review'`, and merges them with
the foreign diagnostics currently in the editor. An `xmleditor` update listener
re-merges the stored findings (deferred with `setTimeout`) whenever another
source replaces the set.

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

## Part F — default-model selection plugin

New **core** frontend plugin, `app/src/plugins/inference-settings.js`
(dependency name `inference-settings`) — not a backend-plugin extension,
since it isn't owned by any single backend plugin; it's generic
infrastructure any current/future LLM-consuming plugin can use. Confirmed
no such "shared default, per-call overridable" pattern exists anywhere in
the codebase today (closest precedent, `ConfigPlugin.get(key, defaultValue)`,
is a per-call fallback, not a settable shared default) — this is genuinely
new, not an extension of existing scaffolding.

**Menu contribution**: a new `"inference"` Tools-menu category (does not
exist yet, unlike `"annotation"`), containing one entry, "Default Model",
that opens a nested submenu grouped by provider — the exact structural
pattern already proven by `tei-annotator.js:59-78` (parent `sl-menu-item` +
child `<sl-menu slot="submenu">`), extended with a `<small>` provider-label
row before each provider's model items (mirroring the visual convention
`tools.js` itself uses for its own top-level category labels, reimplemented
locally since this inner grouping is inside a manually-built submenu, not
`tools.addMenuItems`'s own category mechanism):

```js
const submenu = document.createElement('sl-menu');
submenu.slot = 'submenu';
for (const provider of providers) {
  const label = document.createElement('small');
  label.textContent = provider.label;
  submenu.appendChild(label);
  for (const model of provider.models) {
    const item = document.createElement('sl-menu-item');
    item.type = 'checkbox'; // single-select via manual toggle, see below
    item.textContent = model.label;
    item.addEventListener('click', () => this.setDefaultModel(provider.id, model.id));
    if (model.status && model.status.availability !== 'available') {
      const tooltip = document.createElement('sl-tooltip');
      tooltip.content = `This model is currently ${model.status.availability.replace('_', ' ')}` +
        (model.status.detail ? ` (${model.status.detail})` : '') + ' and may time out.';
      const icon = document.createElement('sl-icon');
      icon.name = 'exclamation-triangle';
      icon.slot = 'suffix';
      tooltip.appendChild(icon);
      item.appendChild(tooltip);
    }
    submenu.appendChild(item);
  }
}
```

Single-select-via-checkbox is an existing, proven pattern (not invented
here) — `xmleditor.js:336-360`'s theme picker and `prompt-editor.js:173-179`
both use `sl-menu-item[type=checkbox]` with manual check/uncheck toggling
across a dynamic list to implement single-selection; this plugin follows
the same approach rather than introducing a different selection widget.

**Busy warning**: a model's `status` (Part A/B) is `None` for providers
that don't expose live load data (most commercial APIs) — no icon is shown
for those, silence rather than a false "available" signal. When present and
not `"available"`, a warning icon + `sl-tooltip` is attached to that
model's menu item (shown above), explaining why — this is purely
informational, it doesn't block selecting a busy model; the goal is to let
the user *avoid* picking one that's likely to time out, not prevent it.
Re-checking status at actual review-call time (Part C) is out of scope for
this round — only the picker shows it, at whatever staleness the last
submenu-open fetch left it at.

**Data source**: `GET /api/v1/llm/providers` (Part A's core route) — one
fetch, used both to populate this submenu and to validate that a previously
stored default is still available.

**Persistence & API**: the selected `{providerId, modelId}` is stored via
`UIStorage` (`docs/code-assistant/ui-storage.md`'s existing
localStorage-wrapper pattern — per-browser, consistent with how other
"remembered choice" UI state already works in this app). The plugin exposes:

- `getDefaultModel()` → `{providerId, modelId} | null` (`null` if nothing
  has been selected yet, or the stored value no longer matches an available
  provider/model).
- `setDefaultModel(providerId, modelId)` → persists and updates the
  submenu's checked state.

Any plugin (starting with `annotation_review`, Part C) calls
`getDependency('inference-settings').getDefaultModel()` and falls back to
it unless it has its own explicit override — "the model selected here is
the default one used by plugins unless they specifically override via the
API", per direction.

## Error handling

- No `editorialDecl` machine-subtype rules present → Tools-menu item stays
  disabled (`hasReviewableRules()`).
- No default model selected yet (Part F never configured, or the stored
  default no longer matches an available provider/model) → `review()`
  surfaces a toast directing the user to Tools → Inference → Default Model,
  rather than silently failing or guessing a provider.
- LLM/network failure calling the chosen provider → toast error, menu item
  re-enabled, no partial diagnostics left behind.
- Malformed/non-JSON LLM response → treated as zero findings, plus a toast
  noting the response couldn't be parsed (logged for debugging).
- Zero findings → toast "No issues found".
- A finding whose `old` doesn't occur exactly once in the source sent to the
  LLM → dropped server-side, logged, never reaches the frontend.
- A finding whose `old` no longer matches the live editor text by the time
  the response arrives (document edited meanwhile) → dropped client-side,
  silently.
- Provider/model becomes unavailable between Part F's listing and actual use
  (e.g. config removed mid-session) → the `POST .../review` call fails with
  a clear error surfaced as a toast; Part F re-fetches `GET
  /api/v1/llm/providers` on next submenu open so it self-corrects.

## Testing

- Part A: unit tests for `LLMProviderRegistry` (register/list/get,
  `available_only` filtering) and `OpenAICompatibleProvider` (mocked HTTP,
  `chat_completion`/`list_models`).
- Part B: unit test confirming `KisskiExtractor._call_llm` delegates to the
  shared connector and existing Kisski extractor tests still pass unchanged
  (behavioral BC check); unit tests for `_demand_to_availability` boundary
  values (0, 1, 5, 6) and for `list_models()` populating `status` from a
  mocked demand-augmented response.
- Part C: unit tests for prompt construction from multiple `editorialDecl`
  categories, and for finding validation (the exactly-once `old`-match
  check: absent, unique, and ambiguous/duplicate cases).
- Part D: JS unit test that the Tools-menu item's disabled state tracks
  `hasReviewableRules()` across a document-change fixture.
- Part E: JS unit tests building diagnostics from fixture findings
  (including the stale-match-drop case), and the single-hunk modified-doc
  construction for "Propose fix".
- Part F: JS unit tests for `getDefaultModel()`/`setDefaultModel()` against
  a mocked `UIStorage`, including the "stored default no longer available"
  fallback-to-`null` case; a test that the busy-warning icon/tooltip is
  only attached when `status.availability !== 'available'`, and not at all
  when `status` is `null`.
- Test locations follow existing conventions: plugin-specific tests in
  `fastapi_app/plugins/annotation_review/tests/` and
  `fastapi_app/plugins/kisski/tests/`, generic core-utility tests in
  `tests/unit/fastapi/`, frontend tests in `tests/unit/js/`.

## Open verification items for implementation

- Confirm `KisskiService`'s existing `ServiceRegistry` role doesn't overlap
  with the new registration (Part B).
- Confirm the exact merge-view accept/reject command names already used by
  `tei-wizard.js` (Part E), rather than assuming an API shape.
- Confirm `sl-menu-item[type=checkbox]`'s manual check/uncheck toggling
  (Part F) behaves correctly when nested two levels deep (category label +
  provider label + item), since the existing precedents
  (`xmleditor.js`/`prompt-editor.js`) only nest one level.
- Confirm whether Kisski's `GET {base_url}/models` (already used by
  `KisskiExtractor._fetch_models_from_api`) returns a `demand` field, or
  whether populating `ModelStatus` genuinely requires the `POST` variant
  the sibling zotero-rag project uses (Part B).
- Confirm a `sl-tooltip` wrapping an `sl-icon` renders/positions correctly
  as a suffix inside a nested `sl-menu-item[type=checkbox]` (Part F) — no
  existing precedent in this codebase combines a tooltip with a menu-item
  checkbox.
