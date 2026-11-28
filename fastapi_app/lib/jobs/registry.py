"""
Registry of the editor's job types.

Core code and plugins register their types here with `job_type` (server jobs, as a decorator of
the handler) or `register_client_type` (jobs that a client drives). The registry keeps the
registrations independently of a `JobManager`: they are registered on the current manager at
once and on every manager that `create_job_manager` creates later. Registering a name again
replaces the type, e.g. when a plugin is initialized again at runtime.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import TYPE_CHECKING, Literal

from fastapi_jobqueue.manager import Handler
from pydantic import BaseModel

if TYPE_CHECKING:
    from fastapi_jobqueue import JobManager


class JobTypeInfo(BaseModel):
    """A registered job type, as listed by `GET /api/v1/jobs/types`."""

    name: str
    title: str
    driver: Literal["server", "client"]
    roles: list[str] | None


@dataclass
class _Registration:
    info: JobTypeInfo
    handler: Handler | None = None
    params_model: type[BaseModel] | None = None
    max_concurrent: int | None = None
    resumable: bool = False
    resume_window: int | None = None


_registrations: dict[str, _Registration] = {}


def _register(registration: _Registration) -> None:
    # Registering a name again replaces the registration, so that plugins that are initialized
    # again at runtime (enabled, installed, reloaded) can register their types again
    _registrations[registration.info.name] = registration
    from .manager import current_job_manager
    manager = current_job_manager()
    if manager is not None:
        register_on_manager(manager, registration)


def register_on_manager(manager: JobManager, registration: _Registration) -> None:
    """Register a job type on a manager, replacing a type of the same name. Running jobs keep their handler."""
    info = registration.info
    manager.types.pop(info.name, None)
    if info.driver == "server":
        assert registration.handler is not None
        manager.handler(
            info.name,
            max_concurrent=registration.max_concurrent,
            resumable=registration.resumable,
            params_model=registration.params_model,
            resume_window=registration.resume_window,
        )(registration.handler)
    else:
        manager.register_type(info.name, driver="client", resume_window=registration.resume_window)


def register_all_on_manager(manager: JobManager) -> None:
    """Register all known job types on a manager."""
    for registration in _registrations.values():
        register_on_manager(manager, registration)


def job_type(
    name: str,
    *,
    title: str,
    roles: list[str] | None = None,
    driver: Literal["server", "client"] = "server",
    params_model: type[BaseModel] | None = None,
    max_concurrent: int | None = None,
    resumable: bool = False,
    resume_window: int | None = None,
) -> Callable[[Handler], Handler]:
    """
    Register a job type with its handler (decorator).

    Args:
        name: Job type, namespaced by plugin (e.g. "ocr", "my-plugin.import")
        title: Human-readable name shown in the jobs list
        roles: Roles of which a user needs one to submit the type through the REST API; None for all users
        driver: "server" runs the decorated handler in a worker; "client" registers a type that a
            client drives (prefer `register_client_type`)
        params_model: Validates the parameters; the handler gets an instance of it
        max_concurrent: Maximum number of active jobs of the type across all workers
        resumable: Run the handler again with the saved steps after a worker restart
        resume_window: Seconds an interrupted job can be resumed; the manager's default if None
    """
    def register(handler: Handler) -> Handler:
        _register(_Registration(
            info=JobTypeInfo(name=name, title=title, driver=driver, roles=roles),
            handler=handler if driver == "server" else None,
            params_model=params_model,
            max_concurrent=max_concurrent,
            resumable=resumable,
            resume_window=resume_window,
        ))
        return handler
    return register


def register_client_type(name: str, *, title: str, roles: list[str] | None = None, resume_window: int | None = None) -> None:
    """
    Register a job type that a client (a browser tab, a frontend plugin) drives through the REST API.

    Args:
        name: Job type, namespaced by plugin
        title: Human-readable name shown in the jobs list
        roles: Roles of which a user needs one to submit the type; None for all users
        resume_window: Seconds an interrupted job can be resumed; the manager's default if None
    """
    _register(_Registration(
        info=JobTypeInfo(name=name, title=title, driver="client", roles=roles),
        resume_window=resume_window,
    ))


def job_types() -> list[JobTypeInfo]:
    """All registered job types, in registration order."""
    return [registration.info for registration in _registrations.values()]


def get_job_type_info(name: str) -> JobTypeInfo | None:
    """The registered job type of this name, or None."""
    registration = _registrations.get(name)
    return registration.info if registration else None
