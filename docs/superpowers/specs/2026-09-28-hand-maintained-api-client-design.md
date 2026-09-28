# Hand-Maintained API Client — Design

Status: draft for review. Date: 2026-09-28.

## Goal

Retire the OpenAPI-codegen step for `app/src/modules/api-client-v1.js` in favor of hand-maintaining the same file, and close the two remaining gaps where frontend code bypasses it: raw `callApi()` calls that duplicate an existing proxy method, and the build/commit gates that exist only to keep the generator honest.

## Current state

- `api-client-v1.js` (2156 lines, 81 methods) is produced by [generate-api-client.js](../../../scripts/build/generate-api-client.js), which **boots a temporary FastAPI/uvicorn server**, fetches `/openapi.json`, and emits one method per operation.
- `npm run build`'s `prebuild` script runs `generate-client` unconditionally (`package.json`), so every production build pays the server-boot cost even when no router changed.
- `.husky/pre-commit.py` blocks a commit that touches `fastapi_app/routers/*.py` unless `api-client-v1.js`'s mtime is newer than every router file's mtime. This is a heuristic, not a content check: it can pass on a client that's stale in substance (e.g. after a rebase touches timestamps) and can be bypassed with `--no-verify`. No CI workflow re-checks this (`.github/workflows/*.yml` has no reference to `generate-client`), so the mtime hook is the only enforcement, and only at commit time.
- No `tsc --checkJs` or JSDoc-lint step exists anywhere in the repo; the client's JSDoc is consumed only by editor tooling, never gated in CI.
- The client is consumed almost entirely through one facade, `app/src/plugins/client.js`, which does `const apiClient = new ApiClientV1(callApi)` and re-exports `apiClient`. Only 5 files import `api-client-v1.js`/`ApiClientV1` directly; call sites elsewhere use `apiClient.<method>(...)` — 50 call sites across 13 files.
- Three call sites bypass the proxy and call the injected transport (`callApi`) directly:
  - [client.js:730](../../../app/src/plugins/client.js) — `callApi('/plugins', 'GET', params)`, duplicating the already-generated `apiClient.plugins(params)` (`PluginListResponse`, same `{plugins: [...]}` shape).
  - [client.js:742](../../../app/src/plugins/client.js) — `callApi('/plugins/${pluginId}/execute', 'POST', {endpoint, params})`, duplicating the already-generated `apiClient.pluginsExecute(plugin_id, requestBody)` (`ExecuteRequest` → `ExecuteResponse`, identical body shape).
  - [progress.js:210](../../../app/src/plugins/progress.js) — `client.callApi(cancelUrl, 'POST')`, where `cancelUrl` is an arbitrary URL string emitted by whichever backend plugin started the progress (e.g. `fastapi_app/plugins/grobid/routes.py`, `fastapi_app/plugins/update_metadata/routes.py`), delivered over SSE at `sse_utils.py:136`. This is not one fixed OpenAPI operation — it is server-chosen URL dispatch across an open set of plugin routes — so it cannot be expressed as a single generated method. It is the same kind of exception the client already documents for uploads and SSE subscriptions.
- `docs/code-assistant/api-client.md` documents the generate/regenerate workflow and links to `fastapi_app/prompts/api-client-usage.md` as "the full guide" — that target file does not exist in the repo (broken link, predates this spec).

## Design

### 1. Remove the code-generation step

- Delete [scripts/build/generate-api-client.js](../../../scripts/build/generate-api-client.js) and [scripts/build/check-client-outdated.js](../../../scripts/build/check-client-outdated.js).
- `package.json`: remove the `generate-client` and `generate-client:check` scripts, and remove `prebuild` (or point it at whatever else, if anything, legitimately needs to run before `build`; today it does nothing else).
- Delete `.husky/pre-commit.py` and the `.husky/pre-commit` hook that invokes it. No replacement gate is added in this version (see [Deferred](#deferred) for a cheaper alternative considered and set aside).
- `api-client-v1.js` itself is **not touched**: its current content stays, byte-for-byte, as the hand-maintained baseline. Only its header changes (below).

### 2. Convert the file to hand-maintained

Replace the file's header:

```diff
-/**
- * Auto-generated API client for PDF-TEI Editor API v1
- *
- * Generated from OpenAPI schema at 2026-09-26T16:23:57.358Z
- *
- * DO NOT EDIT MANUALLY - regenerate using: npm run generate-client
- */
+/**
+ * Hand-maintained API client for PDF-TEI Editor API v1.
+ *
+ * One method per `/api/v1/...` operation, mirroring the FastAPI router's path,
+ * request body, and response model. When you add, remove, or change a route in
+ * `fastapi_app/routers/*.py`, add or update the matching method here in the same
+ * change — read the route and its Pydantic models directly, do not guess.
+ *
+ * Upload (multipart/form-data) and SSE (text/event-stream) endpoints are
+ * intentionally excluded; call `callApi`/`EventSource` directly for those, as
+ * documented in docs/code-assistant/api-client.md.
+ */
```

No method bodies change. This is purely a maintenance-model change: the source of truth for "does this method exist and match the route" moves from "was it regenerated recently" to "was it updated in the same commit as the route," which is the discipline the project already requires everywhere else for hand-written code.

### 3. Replace the two redundant raw `callApi` calls

In `app/src/plugins/client.js`:

```diff
 async function getBackendPlugins(category = null) {
   const params = category ? { category } : {};
-  const response = await callApi('/plugins', 'GET', params);
+  const response = await apiClient.plugins(params);
   return response.plugins;
 }
 
 async function executeBackendPlugin(pluginId, endpoint, params) {
-  const response = await callApi(`/plugins/${pluginId}/execute`, 'POST', {
-    endpoint,
-    params
-  });
+  const response = await apiClient.pluginsExecute(pluginId, { endpoint, params });
   if (response.success) {
     return response.result;
   }
   throw new ApiError(`Plugin execution failed: ${response.error || 'Unknown error'}`);
 }
```

`apiClient` is already in module scope at this point in the file (`const apiClient = new ApiClientV1(callApi)` runs earlier), so this is a like-for-like swap with no behavior change — same endpoint, method, body, and response shape, verified above against the generated `plugins()`/`pluginsExecute()` methods.

### 4. Document the one legitimate exception

`progress.js`'s `callApi(cancelUrl, 'POST')` stays as-is. Add a line to `docs/code-assistant/api-client.md`'s "Excluded Endpoints" section naming this case explicitly — a server-supplied, plugin-chosen cancel URL — so a future pass doesn't try to "fix" it into a named method it cannot express, and so it isn't mistaken for drift when auditing raw `callApi` usage.

### 5. Update documentation

- `docs/code-assistant/api-client.md`: replace the "Regenerating the Client" section with a "Maintaining the Client" section: when you change a router, update the matching method by hand in the same change; there is no regeneration command anymore. Remove the `npm run generate-client`/`:check` references throughout (Quick Start note, Troubleshooting, Best Practices DO/DON'T list — "Don't modify generated client" and "Don't skip pre-commit checks" both no longer apply and should be replaced with "Do update the client in the same commit as the router change"). Fix or remove the dead link to `fastapi_app/prompts/api-client-usage.md`.
- Root `CLAUDE.md`'s Key Files/Detailed Documentation list needs no change (still points at the same doc path).

## Testing

- `npm run build` completes without booting a FastAPI server and without a `prebuild` step.
- `git commit` touching a file under `fastapi_app/routers/` no longer runs any client-freshness check.
- Existing unit/E2E coverage that already exercises the plugin list/execute path (backend-plugins UI, plugin-admin E2E test) continues to pass unchanged after the `client.js` edit — this is the regression check for step 3, since no new test is needed for a like-for-like call swap.
- Run the full suite (`npm run test:unit`, `npm run test:e2e`) before finishing, per project rules.

## Migration

None. No stored data, no API behavior, and no generated content changes — only how `api-client-v1.js` is produced and kept current, plus two internal call sites in `client.js` that now go through the proxy they were duplicating.

## Deferred

- A lightweight, no-server-boot drift check (e.g. a script that statically greps `@router.<method>(...)` decorators in `fastapi_app/routers/*.py` against path strings in `api-client-v1.js`, without booting uvicorn) was considered as a replacement for the removed mtime hook. Set aside for this version since it adds new tooling for a gap that's currently zero-cost to close by discipline (13 files touch the client's call sites; the file itself is small enough to review in a PR diff); revisit if drift actually occurs in practice.
- Applying the same hand-maintained-facade treatment to any other generated frontend artifact, if one is added later, is out of scope here.
