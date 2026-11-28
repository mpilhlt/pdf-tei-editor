"""
Routes of the job API under `/api/v1/jobs`: the editor's own routes (job types, files of jobs),
followed by the REST API of fastapi-jobqueue (see its README).
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse
from fastapi_jobqueue import JobManager, JobNotFound, Principal

from .auth import current_principal
from .files import job_output_path
from .manager import get_job_manager
from .registry import JobTypeInfo, job_types

router = APIRouter(prefix="/jobs", tags=["jobs"])


@router.get("/types", response_model=list[JobTypeInfo], summary="List the registered job types")
def list_job_types(principal: Principal = Depends(current_principal)) -> list[JobTypeInfo]:
    return job_types()


@router.get("/{job_id}/files/{name}", response_class=FileResponse, summary="Download a file that a job produced")
async def get_job_file(
    job_id: str,
    name: str,
    principal: Principal = Depends(current_principal),
    manager: JobManager = Depends(get_job_manager),
) -> FileResponse:
    if not name or "/" in name or "\\" in name or name in (".", ".."):
        raise HTTPException(status_code=404, detail="File not found")
    try:
        job = await manager.get(job_id, viewer=principal)
    except JobNotFound:
        raise HTTPException(status_code=404, detail="File not found")
    path = job_output_path(job.id) / name
    if not path.is_file():
        raise HTTPException(status_code=404, detail="File not found")
    return FileResponse(path, filename=name)


def include_job_routes(parent: APIRouter) -> None:
    """Mount the job API on the v1 router: the editor's routes first, then the library's, both under `/jobs`."""
    parent.include_router(router)
    parent.include_router(get_job_manager().router(tags=["jobs"]), prefix="/jobs")
