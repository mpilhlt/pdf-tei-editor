"""
Projects management API router.

Implements:
- GET /api/v1/projects - List projects visible to the current user
- GET /api/v1/projects/{project_id} - Get project detail
- POST /api/v1/projects - Create project (admin)
- PUT /api/v1/projects/{project_id} - Update project (admin)
- DELETE /api/v1/projects/{project_id} - Delete project (admin)
- GET /api/v1/projects/{project_id}/config - List project config overrides (admin)
- POST /api/v1/projects/{project_id}/config - Set config override (admin)
- DELETE /api/v1/projects/{project_id}/config/{key} - Delete config override (admin)
"""

from typing import Any, Optional
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from ..lib.utils.project_utils import (
    find_project,
    project_exists,
    create_project,
    get_projects_with_details,
    project_config_get_all,
    project_config_set,
    project_config_delete,
)
from ..lib.utils.data_utils import save_entity_data
from ..lib.core.dependencies import get_current_user
from ..lib.utils.logging_utils import get_logger
from ..config import get_settings

logger = get_logger(__name__)
router = APIRouter(prefix="/projects", tags=["projects"])


class Project(BaseModel):
    id: str = Field(..., description="Unique project identifier")
    name: str = Field(..., description="Project display name")
    description: Optional[str] = Field(default="", description="Project description")
    members: list[str] = Field(default_factory=list, description="List of member usernames")
    collections: list[str] = Field(default_factory=list, description="List of collection IDs")


class CreateProjectRequest(BaseModel):
    id: str
    name: str
    description: Optional[str] = ""
    members: Optional[list[str]] = None
    collections: Optional[list[str]] = None


class UpdateProjectRequest(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    members: Optional[list[str]] = None
    collections: Optional[list[str]] = None


class ProjectConfigItem(BaseModel):
    key: str
    value: Any


class ProjectConfigSetRequest(BaseModel):
    key: str
    value: Any


class ProjectConfigResponse(BaseModel):
    project_id: str
    config: dict[str, Any]


def require_authenticated(current_user: Optional[dict] = Depends(get_current_user)) -> dict:
    """Dependency that requires authentication."""
    if not current_user:
        raise HTTPException(status_code=401, detail="Authentication required")
    return current_user


def require_admin(current_user: Optional[dict] = Depends(get_current_user)) -> dict:
    """Verify user is authenticated and has admin role."""
    if not current_user:
        raise HTTPException(status_code=401, detail="Authentication required")
    user_roles = current_user.get('roles', [])
    if '*' not in user_roles and 'admin' not in user_roles:
        raise HTTPException(status_code=403, detail="Insufficient permissions. Admin role required.")
    return current_user


def _is_admin(user: dict) -> bool:
    roles = user.get('roles', [])
    return '*' in roles or 'admin' in roles


def _project_to_model(p: dict) -> Project:
    return Project(
        id=p['id'],
        name=p.get('name', ''),
        description=p.get('description', ''),
        members=p.get('members', []),
        collections=p.get('collections', []),
    )


@router.get("", response_model=list[Project])
def list_projects(current_user: dict = Depends(require_authenticated)):
    """List projects. Admin sees all; regular users see only projects they are members of."""
    settings = get_settings()
    all_projects = get_projects_with_details(settings.db_dir)
    if _is_admin(current_user):
        return [_project_to_model(p) for p in all_projects]
    username = current_user.get('username', '')
    return [_project_to_model(p) for p in all_projects if username in p.get('members', [])]


@router.get("/{project_id}", response_model=Project)
def get_project(project_id: str, current_user: dict = Depends(require_authenticated)):
    """Get project. Returns 404 if not found or if non-admin user is not a member."""
    settings = get_settings()
    all_projects = get_projects_with_details(settings.db_dir)
    project = find_project(project_id, all_projects)
    if not project:
        raise HTTPException(status_code=404, detail=f"Project '{project_id}' not found")
    if not _is_admin(current_user):
        username = current_user.get('username', '')
        if username not in project.get('members', []):
            raise HTTPException(status_code=404, detail=f"Project '{project_id}' not found")
    return _project_to_model(project)


@router.post("", response_model=Project, status_code=201)
def create_project_endpoint(body: CreateProjectRequest, current_user: dict = Depends(require_admin)):
    settings = get_settings()
    all_projects = get_projects_with_details(settings.db_dir)
    if project_exists(body.id, all_projects):
        raise HTTPException(status_code=400, detail=f"Project '{body.id}' already exists")
    new_project = create_project(
        project_id=body.id, name=body.name, description=body.description or "",
        members=body.members or [], collections=body.collections or []
    )
    all_projects.append(new_project)
    save_entity_data(settings.db_dir, 'projects', all_projects)
    logger.info(f"Project '{body.id}' created by '{current_user.get('username')}'")
    return _project_to_model(new_project)


@router.put("/{project_id}", response_model=Project)
def update_project_endpoint(project_id: str, body: UpdateProjectRequest,
                             current_user: dict = Depends(require_admin)):
    settings = get_settings()
    all_projects = get_projects_with_details(settings.db_dir)
    project = find_project(project_id, all_projects)
    if not project:
        raise HTTPException(status_code=404, detail=f"Project '{project_id}' not found")
    if body.name is not None:
        project['name'] = body.name
    if body.description is not None:
        project['description'] = body.description
    if body.members is not None:
        project['members'] = body.members
    if body.collections is not None:
        project['collections'] = body.collections
    save_entity_data(settings.db_dir, 'projects', all_projects)
    logger.info(f"Project '{project_id}' updated by '{current_user.get('username')}'")
    return _project_to_model(project)


@router.delete("/{project_id}")
def delete_project_endpoint(project_id: str, current_user: dict = Depends(require_admin)):
    settings = get_settings()
    all_projects = get_projects_with_details(settings.db_dir)
    if not project_exists(project_id, all_projects):
        raise HTTPException(status_code=404, detail=f"Project '{project_id}' not found")
    remaining = [p for p in all_projects if p.get('id') != project_id]
    save_entity_data(settings.db_dir, 'projects', remaining)
    logger.info(f"Project '{project_id}' deleted by '{current_user.get('username')}'")
    return {"success": True, "message": f"Project '{project_id}' deleted"}


@router.get("/{project_id}/config", response_model=ProjectConfigResponse)
def get_project_config(project_id: str, current_user: dict = Depends(require_admin)):
    settings = get_settings()
    all_projects = get_projects_with_details(settings.db_dir)
    if not find_project(project_id, all_projects):
        raise HTTPException(status_code=404, detail=f"Project '{project_id}' not found")
    overrides = project_config_get_all(settings.db_dir, project_id)
    return ProjectConfigResponse(project_id=project_id, config=overrides)


@router.post("/{project_id}/config", response_model=ProjectConfigItem)
def set_project_config(project_id: str, request_data: ProjectConfigSetRequest,
                       current_user: dict = Depends(require_admin)):
    settings = get_settings()
    all_projects = get_projects_with_details(settings.db_dir)
    if not find_project(project_id, all_projects):
        raise HTTPException(status_code=404, detail=f"Project '{project_id}' not found")
    ok, msg = project_config_set(settings.db_dir, project_id, request_data.key, request_data.value)
    if not ok:
        raise HTTPException(status_code=400, detail=msg)
    logger.info(f"'{current_user.get('username')}' set project '{project_id}' config '{request_data.key}'")
    return ProjectConfigItem(key=request_data.key, value=request_data.value)


@router.delete("/{project_id}/config/{key}")
def delete_project_config(project_id: str, key: str, current_user: dict = Depends(require_admin)):
    settings = get_settings()
    all_projects = get_projects_with_details(settings.db_dir)
    if not find_project(project_id, all_projects):
        raise HTTPException(status_code=404, detail=f"Project '{project_id}' not found")
    ok, msg = project_config_delete(settings.db_dir, project_id, key)
    if not ok:
        raise HTTPException(status_code=404, detail=msg)
    logger.info(f"'{current_user.get('username')}' deleted project '{project_id}' config '{key}'")
    return {"success": True, "project_id": project_id, "key": key}
