"""
Who may create, list and revoke personal access tokens (see ``fastapi_app/lib/core/access_tokens.py``).

| Creator | May create tokens for | May list / revoke |
| --- | --- | --- |
| admin | any user | all tokens |
| reviewer | themselves, and users whose roles are a subset of the reviewer's own | tokens they created, and tokens for themselves |
| any other role | no one | tokens for themselves |

A token authenticates as its user, so a reviewer who could create a token for a user with more
rights could act with those rights; hence the subset rule.
"""

from typing import Any

from fastapi_app.lib.core.access_tokens import AccessTokenDict

UserDict = dict[str, Any]

PRIVILEGED_ROLES = frozenset({"*", "admin", "restore", "backup"})
"""Roles a reviewer can only hand on through a token if they have them too."""


def user_roles(user: UserDict) -> set[str]:
    """The roles of a user, including the legacy single ``role`` field."""
    roles = user.get("roles")
    if roles is None:
        role = user.get("role")
        return {role} if role else set()
    return set(roles)


def is_admin(user: UserDict) -> bool:
    roles = user_roles(user)
    return "admin" in roles or "*" in roles


def can_create_tokens(user: UserDict) -> bool:
    """Whether the user may create tokens at all (reviewers and admins)."""
    return is_admin(user) or "reviewer" in user_roles(user)


def can_create_token_for(creator: UserDict, target: UserDict) -> bool:
    """
    Whether ``creator`` may create a token that authenticates as ``target``.

    Args:
        creator: The current user
        target: The user the token would authenticate as
    """
    if not can_create_tokens(creator):
        return False
    if is_admin(creator) or creator.get("username") == target.get("username"):
        return True
    creator_roles = user_roles(creator)
    target_roles = user_roles(target)
    if any(role in PRIVILEGED_ROLES and role not in creator_roles for role in target_roles):
        return False
    return target_roles <= creator_roles


def can_manage_token(user: UserDict, token: AccessTokenDict) -> bool:
    """Whether the user may see and revoke a token."""
    username = user.get("username")
    return is_admin(user) or token["username"] == username or token["created_by"] == username
