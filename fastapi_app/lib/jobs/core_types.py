"""Job types of the core. `test.progress` is a job for E2E tests of the job UI."""

from __future__ import annotations

import asyncio

from fastapi_jobqueue import JobContext
from pydantic import BaseModel

from .registry import job_type


class ProgressTestParams(BaseModel):
    steps: int = 5
    delay_ms: int = 500
    fail: bool = False


@job_type("test.progress", title="Progress test", params_model=ProgressTestParams)
async def run_progress_test(ctx: JobContext, params: ProgressTestParams) -> dict[str, int]:
    """Counts `steps` steps of `delay_ms` each, reporting each one; fails at the end if `fail`."""
    for i in range(1, params.steps + 1):
        await asyncio.sleep(params.delay_ms / 1000)
        await ctx.report(done=i, total=params.steps, unit="steps", phase="Testing")
    if params.fail:
        raise RuntimeError("Test failure")
    return {"steps": params.steps}
