"""
Long-running jobs on fastapi-jobqueue: the manager, the editor's authentication and file-lock
hooks, the job type registry and the files of jobs. See docs/code-assistant/jobs.md.
"""

from .auth import current_principal, job_user, may_submit
from .files import files_input_hash, job_file_url, job_output_dir
from .hooks import EditorJobHooks
from .manager import create_job_manager, get_job_manager, set_job_manager
from .registry import JobTypeInfo, job_type, job_types, register_client_type

__all__ = [
    "EditorJobHooks",
    "JobTypeInfo",
    "create_job_manager",
    "current_principal",
    "files_input_hash",
    "get_job_manager",
    "job_file_url",
    "job_output_dir",
    "job_type",
    "job_types",
    "job_user",
    "may_submit",
    "register_client_type",
    "set_job_manager",
]
