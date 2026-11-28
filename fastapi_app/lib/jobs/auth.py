"""
Authentication of the job API: the principal from the editor's session, who may submit which
job type, and the user who owns a job.
"""

from __future__ import annotations

from typing import Any

from fastapi import Depends, HTTPException
from fastapi_jobqueue import Job, Principal

from fastapi_app.lib.core.dependencies import get_auth_manager, require_authenticated_user
from fastapi_app.lib.permissions.acl_utils import user_has_role, user_is_admin

from .registry import get_job_type_info


def current_principal(user: dict[str, Any] = Depends(require_authenticated_user)) -> Principal:
    """The caller of the job API (FastAPI dependency)."""
    return Principal(id=user["username"], is_admin=user_is_admin(user))


def may_submit(principal: Principal, job_type: str) -> bool:
    """Whether the principal may submit the job type: it is registered and needs no role, or the user has one of its roles."""
    info = get_job_type_info(job_type)
    if info is None:
        return False
    if info.roles is None:
        return True
    return user_has_role(get_auth_manager().get_user_by_username(principal.id), info.roles)


def may_submit_or_forbid(principal: Principal, job_type: str) -> bool:
    """
    `JobAuth.may_submit` of the editor: like `may_submit`, but answers a registered type that the
    user lacks the roles for with 403 instead of the library's 400 for types that cannot be submitted.
    """
    if may_submit(principal, job_type):
        return True
    if get_job_type_info(job_type) is not None:
        raise HTTPException(status_code=403, detail=f"Not allowed to submit jobs of type {job_type}")
    return False


def job_user(job: Job) -> dict[str, Any]:
    """
    The user dict of the job's owner, for handlers that act on the owner's behalf.

    Raises:
        PermissionError: if the user no longer exists
    """
    user = get_auth_manager().get_user_by_username(job.owner)
    if user is None:
        raise PermissionError(f"The owner of job {job.id} no longer exists")
    return user
