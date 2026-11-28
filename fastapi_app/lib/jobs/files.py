"""
Files of jobs: the `file:<stable_id>` resources a job holds, and the output directory whose
files the job route serves.
"""

from __future__ import annotations

import hashlib
from pathlib import Path

from fastapi_app.config import get_settings
from fastapi_app.lib.core.dependencies import get_db
from fastapi_app.lib.repository.file_repository import FileRepository

FILE_RESOURCE_PREFIX = "file:"
"""Prefix of the resources that lock a file: `file:<stable_id>`."""


def file_resource_ids(resources: list[str]) -> list[str]:
    """The stable ids of the `file:` resources."""
    return [resource[len(FILE_RESOURCE_PREFIX):] for resource in resources if resource.startswith(FILE_RESOURCE_PREFIX)]


def files_input_hash(resources: list[str]) -> str:
    """
    Hash of the current content of the files a job holds: sha256 over the sorted file ids
    (content hashes) of its `file:` resources. A file that no longer exists counts as `missing:<stable_id>`.
    """
    repo = FileRepository(get_db())
    ids: list[str] = []
    for stable_id in file_resource_ids(resources):
        file = repo.get_file_by_stable_id(stable_id)
        ids.append(file.id if file is not None else f"missing:{stable_id}")
    return hashlib.sha256("\n".join(sorted(ids)).encode("utf-8")).hexdigest()


def job_output_path(job_id: str) -> Path:
    """The output directory of a job, without creating it."""
    return get_settings().data_root / "jobs" / job_id


def job_output_dir(job_id: str) -> Path:
    """
    The output directory of a job (created on demand): `data/jobs/<job id>`, outside the tmp dir
    that the garbage collection empties; removed when the job is deleted.
    """
    path = job_output_path(job_id)
    path.mkdir(parents=True, exist_ok=True)
    return path


def job_file_url(job_id: str, name: str) -> str:
    """URL of a file in a job's output directory."""
    return f"/api/v1/jobs/{job_id}/files/{name}"
