# Lock notice: who holds the lock (#742)

`services.load()` showed "This document is being edited by another user" for every 423 of `POST /api/v1/files/acquire_lock`, whoever held the lock. Issue #742 describes two misleading cases: a document locked by a background job (`auto-annotation:<job id>`), and a document that reports the notice after the user reloaded the page.

## Investigation of the reload case

An E2E probe logged the lock requests and their `X-Session-ID` around six reloads of an open document (testreviewer, standard fixture):

```text
7860 REQ  release_lock sid=113c2018      <- unloading page (3x: authentication.shutdown, 2x heartbeat beforeunload)
8631 REQ  acquire_lock sid=113c2018      <- reloaded page, services.load()
8682 RES  200 acquire_lock
9843 REQ  release_lock sid=113c2018      <- reloaded page, HeartbeatPlugin.stop()
9886 RES  200 release_lock
STATE {"xml":"w6bpdw","ro":false}        <- editable, but the server holds no lock
```

Findings:

- The session id survives a reload (it is restored from sessionStorage), so a reload alone does not produce a 423. The suspected race (old page releases late, new page acquires with another session id) does not occur with an unchanged session.
- `HeartbeatPlugin.start()` doubled as the plugin lifecycle method: `Application.start()` called it with no arguments (60 s interval), then `StartPlugin` called it again with the configured interval as the first argument, which the method ignored as `_state`. The second call restarted the heartbeat through `stop()`, and `stop()` released the lock of the open document. After every reload the editor was therefore editable without a lock, until the next heartbeat re-acquired it. Each start also added another `beforeunload` listener that released the lock.
- A 423 for one's own document needs a different session id, i.e. the document is still locked by another session of the same user: another tab, or a session from before a new login. The old lock stays fresh as long as the old page sends heartbeats. When that page releases the lock, the server broadcasts `lockReleased` and the waiting page re-acquires it ("You can now edit this document"), which matches the report.

## Changes

- `HeartbeatPlugin.startHeartbeat(intervalSeconds)` replaces the overloaded `start()`; restarting no longer releases the lock, and `stop()` only stops the interval. The configured `heartbeat.interval` (30 s) now takes effect. The services and authentication plugins still release the lock on unload.
- The 423 of `acquire_lock` carries a `LockedDetail` (`code: "locked"`, `holder`, `username`, `message`):
  - `holder: "process"`: the holder id starts with a prefix registered with `register_lock_holder(prefix, notice)` (plugin API 1.4), message is that notice.
  - `holder: "own_session"`: a session of the requesting user, "You have this document open for editing in another window or session, so it opens read-only here".
  - `holder: "user"`: "This document is being edited by <username>", or "by another user" if the holding session is unknown.
- `LockedError` keeps the detail; `services.load()` shows its message.

## Tests

- `tests/e2e/tests/document-lock-reload.spec.js`: after a reload the session still holds the lock and the reloaded page sends no release. Fails without the heartbeat fix (`locked_files` is empty).
- `tests/api/v1/files_locks.test.js`: 423 detail for a second session of the same user and for another user.
- `tests/unit/fastapi/test_lock_holder.py`: holder registry and `describe_lock_holder()`.

## Follow-up

- The auto-annotation correction job (pte-plugins, `correction_routes.py`) should call `register_lock_holder("auto-annotation:", "This document is locked while its annotations are corrected automatically")` in `initialize()` and `unregister_lock_holder()` in `cleanup()`, and require plugin API `^1.4`.
- `POST /files/heartbeat` and `POST /files/release_lock` do not validate the session, so a page whose session expired keeps its lock fresh.
