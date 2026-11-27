# Long-Running Jobs

Long-running work (text recognition, LLM passes, extraction, backups) runs as a **job** on [fastapi-jobqueue](https://github.com/cboulanger/fastapi-jobqueue). Its README documents the library: statuses, leases, steps, the REST API and the event streams. This page covers what the editor adds in `fastapi_app/lib/jobs/`. Design and decisions: issue #961.

## When to Use a Job

Use a job when a request can take longer than a reverse proxy waits for a response (about a minute), when the user should see progress or be able to cancel, or when the work should survive a page reload. A job is not needed for work that finishes within a few seconds.

- **Server job**: a handler runs in one of the workers. Progress, cancel and the result go through the job.
- **Client job**: the browser drives the work step by step (e.g. a sequence of requests of a frontend plugin); the job records the steps so that a reload can resume them.

## The Manager

`fastapi_app/main.py` creates the manager of each worker at module level, mounts its routes under `/api/v1/jobs` and runs it in the app's lifespan after the plugins are initialized, so that every job type is registered before the worker claims queued jobs. All workers share the store `data/db/jobs.db`. Finished jobs are kept for 1 hour (`retention=3600`), interrupted ones can be resumed for 15 minutes (`resume_window=900`).

```python
from fastapi_app.lib.jobs import get_job_manager

job = await get_job_manager().submit("my-plugin.import", {"collection": "c1"}, owner=user["username"], resources=[f"file:{stable_id}"])
```

`get_job_manager()` is also a FastAPI dependency. Everything below is importable from `fastapi_app.lib.jobs`.

## Registering a Job Type

Server jobs register their handler with the `job_type` decorator, at import time of the module (a plugin's `plugin.py` or `routes.py`). Names are namespaced by plugin. Registering a name again replaces the type and its handler (jobs that already run keep theirs), so a plugin that is initialized again at runtime can register its types again.

```python
from pydantic import BaseModel
from fastapi_jobqueue import JobContext
from fastapi_app.lib.jobs import job_type, job_user


class ImportParams(BaseModel):
    collection: str


@job_type("my-plugin.import", title="Import documents", roles=["admin"], params_model=ImportParams, max_concurrent=1)
async def run_import(ctx: JobContext, params: ImportParams) -> dict:
    user = job_user(ctx.job)  # the owner's user dict; PermissionError if the user was deleted
    for i, item in enumerate(items, 1):
        if not ctx.has_step(item.id):
            await ctx.save_step(item.id, await import_item(item, user))
        await ctx.report(done=i, total=len(items), unit="documents", phase="Importing")
    return {"imported": len(items)}
```

- `title` is shown in the jobs list (`GET /api/v1/jobs/types` returns `JobTypeInfo` with `name`, `title`, `driver`, `roles`).
- `roles`: a user needs one of them to submit the type through the REST API (403 otherwise); `None` allows all users. Server code that calls `submit()` directly is not checked.
- `max_concurrent` limits the active jobs of the type across all workers; further jobs wait as `queued`.
- `resumable=True` runs the handler again after a worker restart, with the steps saved so far; steps must therefore be idempotent. Without it, an interrupted job fails.
- Client jobs: `register_client_type("my-plugin.review", title="Review", roles=None, resume_window=600)`.

### The Handler

- `await ctx.report(done=, total=, unit=, phase=, message=)` updates the progress; omitted fields keep their value. Writes are coalesced to one per second, a new phase or message is written at once.
- `ctx.report()`, `ctx.save_step()` and `ctx.check_cancelled()` raise `JobCancelled` when the user cancelled the job. It is a `BaseException`, so `except Exception` blocks do not swallow it; never catch it with `except BaseException` without re-raising.
- Blocking work belongs in `asyncio.to_thread()`; from the thread, report with `ctx.report_threadsafe(...)` and check `ctx.check_cancelled()`.
- An exception fails the job with its message (status 500, or the exception's integer `status_code`). The result must be JSON-serializable.

## Resources and Locks

A job lists the files it works on as resources `file:<stable_id>`. `EditorJobHooks` maps them to the editor's file locks (`fastapi_app/lib/core/locking.py`) under the holder id `job:<job id>`:

- On submit, it locks each file; if one is locked by a user or another job, it gives back the locks already taken and the submit fails with 409 (`ResourceBusy`).
- The locks of an active job are refreshed with its lease (every few seconds). Jobs that wait (`queued`, e.g. behind `max_concurrent`, or `interrupted`) have no lease; the lock refresher (`job_lock_refresher`, started with the manager in the app lifespan) refreshes their locks every 30 s. So the locks do not become stale before the job finishes, expires or is deleted, when they are released.
- If another holder took a file's lock anyway (e.g. after a server pause made it stale), the next renewal of an active job finds it and cancels the job, so that the handler does not write a document someone else edits.
- A user who opens a locked file sees "This document is locked while a background job runs on it." (registered with `register_lock_holder("job:", ...)`).
- The user's own editing lock also blocks the job; release it before submitting a job on the open document, or let the job work on a new version.
- Input check: a job submitted with `input_hash=files_input_hash(resources)` (sha256 over the current content hashes of its files) is not resumed if a file changed in the meantime. Jobs without `file:` resources are never refused this way; a client job checks for changes on the client.

## Files a Job Produces

A job writes downloadable output to `job_output_dir(job_id)` (`data/jobs/<job id>`, created on demand; not in `data/tmp`, which the garbage collection empties) and returns their URLs, made with `job_file_url(job_id, name)` (`/api/v1/jobs/{job_id}/files/{name}`). The route serves a file to the users who may view the job and 404 otherwise. The directory is removed when the job is deleted, by the user or after the retention time.

## Jobs Driven by a Request

A route that needs the user's session (e.g. OCR text corrections) cannot run as a server job. The client registers a client type (`register_client_type`), submits a job of it, and passes the job id to the route. The route runs its work inside `run_request_job`:

```python
async with run_request_job(job_id, principal) as job:  # principal: Depends(current_principal)
    await job.report(done=1, total=10, phase="Correcting")  # raises RequestJobCancelled after a cancel
    await asyncio.to_thread(work, *thread_callbacks(job.report_threadsafe, job.check_cancelled))
    job.set_result({"pages": 10})
```

- It claims the job (holder `request:<uuid>`; 404 if it does not exist or is not visible, 409 if it cannot be claimed), renews the lease every `lease_ttl / 3` and records a requested cancel.
- Normal exit finishes the job `done` with the result; `RequestJobCancelled` finishes it `cancelled` and is re-raised; any other exception finishes it `error` with `{"message", "status"}` (the exception's `status_code`, else 500) and is re-raised.
- `check_cancelled()` is sync and thread-safe; `report_threadsafe(**fields)` writes on the event loop without waiting.
- `thread_callbacks(report, check_cancelled)` returns `(progress_callback(current, total, label), cancellation_check() -> bool)` for code with such callbacks (e.g. `update_tei_metadata`). It also works with `ctx.report_threadsafe` / `ctx.check_cancelled` of a server job.

## Frontend: `JobClient`

`app/src/modules/job-client.js` has no plugin imports; the `jobs` plugin constructs it with `{ api, eventSourceFactory, sessionStorage, eventsUrl }` (`eventsUrl` = `/api/v1/jobs/events?mine=true&sessionId=<id>`). `api` is the `ApiClientV1`, whose `jobs*` methods mirror `/api/v1/jobs` (`jobsSubmit` takes an `idempotencyKey` option, sent as `Idempotency-Key` through the `headers` argument of `callApi`).

- `submit(type, params, {resources, inputHash, idempotencyKey})`, `get`, `list`, `cancel`, `types()` (cached).
- `subscribe(listener)`: one shared EventSource (event `job`), opened for the first listener, closed after the last. After an error it reconnects with `last_event_id` after 1, 2, 4 ... max 30 s.
- `wait(jobId, {signal})`: resolves `job.result`; rejects `JobFailedError` (`.status`, `.message`) for `error`/`expired` and `JobCancelledError` for `cancelled`. It polls every 2 s while the stream is in error. Aborting the signal only stops waiting.
- `runClientJob(type, params, body, {resources, inputHash, jobId})`: submits (or resumes `jobId`), claims with the tab's holder (`sessionStorage['job-holder']`), heartbeats every 10 s and calls `body({job, step, report})`. `step(key, fn)` returns a saved result instead of running `fn`; `report(progress)` throws `JobCancelledError` after a cancel request, which finishes the job as cancelled. Other errors finish it `error` with status 500.
- `formatJobProgress(job, heading?)`: "Recognizing text, pages 12 of 71, about 2 minutes left".

## Testing

```python
from fastapi_jobqueue import MemoryJobStore
from fastapi_app.lib.jobs import create_job_manager, set_job_manager
from fastapi_app.lib.jobs.routes import include_job_routes

manager = create_job_manager(MemoryJobStore())  # registers all known job types
set_job_manager(manager)
app = FastAPI(lifespan=manager.lifespan)  # add job_lock_refresher(interval=...) to test waiting jobs' locks
api_v1 = APIRouter(prefix="/api/v1")
include_job_routes(api_v1)
app.include_router(api_v1)
with TestClient(app) as client:  # the context runs the lifespan, which starts the manager
    ...
```

Use `client.portal.call(manager.cancel, job_id)` to call async manager methods from the test. `tests/unit/fastapi/test_jobs_infrastructure.py` is the reference. The core job type `test.progress` (params `steps`, `delay_ms`, `fail`) is meant for E2E tests of the job UI.
