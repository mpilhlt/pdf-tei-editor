"""
Job types of the core. `test.progress` is a job for E2E tests of the job UI; with `result`,
`phase` and `unit` it also stands in for the jobs of features whose real run the E2E environment
cannot do (e.g. text recognition without an OCR engine).
"""

from __future__ import annotations

import asyncio

from fastapi_jobqueue import JobContext
from fastapi_jobqueue.errors import JobCancelled
from pydantic import BaseModel, JsonValue

from .registry import job_type


class ProgressTestParams(BaseModel):
    steps: int = 5
    delay_ms: int = 500
    fail: bool = False
    phase: str = "Testing"
    unit: str = "steps"
    result: dict[str, JsonValue] | None = None
    """Returned instead of `{"steps": steps}`."""
    cancel_result: dict[str, JsonValue] | None = None
    """If set, a cancelled job ends `done` with this result, like a job that keeps a partial result."""


@job_type("test.progress", title="Progress test", params_model=ProgressTestParams)
async def run_progress_test(ctx: JobContext, params: ProgressTestParams) -> dict[str, JsonValue]:
    """Counts `steps` steps of `delay_ms` each, reporting each one; fails at the end if `fail`."""
    try:
        for i in range(1, params.steps + 1):
            await asyncio.sleep(params.delay_ms / 1000)
            await ctx.report(done=i, total=params.steps, unit=params.unit, phase=params.phase)
    except JobCancelled:
        if params.cancel_result is None:
            raise
        return params.cancel_result
    if params.fail:
        raise RuntimeError("Test failure")
    return params.result if params.result is not None else {"steps": params.steps}
