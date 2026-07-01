# MIT License
#
# Copyright (c) 2026 Aparavi Software AG
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in all
# copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.

# =============================================================================
# ACCOUNT MODELS
# Shared internal types used by both the account layer and the task layer.
# Placed here to avoid circular imports between account/auth and modules/task.
# =============================================================================

import time
from typing import Literal, Optional, TypedDict

from pydantic import BaseModel, Field

from rocketride.types.client import AppManifestEntry


# =============================================================================
# NESTED SHAPES
# Lightweight TypedDicts documenting the shape of AccountInfo's
# ``organization`` and ``apps`` fields. Mirrors the public
# ``OrgInfo`` / ``TeamInfo`` defined in ``rocketride.types.client`` but kept
# local to avoid a server→client cross-package import.
# =============================================================================


class TeamInfo(TypedDict):
    """Shape of an entry inside ``OrgInfo['teams']``."""

    id: str
    name: str
    permissions: list[str]


class OrgInfo(TypedDict):
    """Shape of the ``AccountInfo.organization`` field (single org per user)."""

    id: str
    name: str
    permissions: list[str]
    teams: list[TeamInfo]


# =============================================================================
# ACCOUNT INFO
# =============================================================================


class AccountInfo(BaseModel):
    """Internal representation of an authenticated session."""

    # Raw credential that was used to authenticate (pk_/tk_ for task-scoped)
    auth: str = ''

    # Persistent per-user credential (rr_<user_token>)
    userToken: str = ''

    # Stable user identifier
    userId: str = ''

    # Human-readable identity
    displayName: str = ''
    givenName: str = ''
    familyName: str = ''
    preferredUsername: str = ''
    email: str = ''
    emailVerified: bool = False
    phoneNumber: str = ''
    phoneNumberVerified: bool = False
    locale: str = ''

    # Default team ID for this session (pre-resolved server-side)
    defaultTeam: str = ''

    # Single org/team/permissions structure — all permission checks resolve through this.
    # None when the user has no org membership (e.g. freshly invited, not yet provisioned).
    organization: Optional[OrgInfo] = None

    # Apps on the user's desktop — full manifest entries with appStatus + onDesktop.
    # OSS: all apps with appStatus="free", onDesktop=True.
    # SaaS: populated from app_users table, enriched with full manifest + billing info.
    apps: list[AppManifestEntry] = []

    # Server capability tags — 'oss' or 'saas' depending on the account provider
    capabilities: list[str] = []

    # Platform-level permission strings (e.g. ['sys.admin', 'sys.view']).
    # Set manually in the database, never via API.
    sysPermissions: list[str] = []

    # Credit wallet balance snapshot — dict of resource→balance pairs.
    # Populated from the credit_wallets table for the user's primary org.
    credits: dict = {}

    # True when the user is authenticated but not yet granted app access
    # (email did not match any allowed pattern in the user_grants table)
    waitlisted: bool = False

    def to_connect_result(self) -> dict:
        """
        Serialize to ConnectResult dict sent to the client (excludes auth).

        The ``auth`` field is intentionally excluded so that the raw credential
        is never echoed back over the wire to a connecting client.

        Returns:
            dict: All AccountInfo fields except ``auth``, suitable for sending
                  as the body of a DAP connect response.
        """
        # Use pydantic's model_dump with an explicit exclusion set so that the
        # raw authentication credential is never returned to the client.
        return self.model_dump(exclude={'auth'})


# =============================================================================
# DEPLOYMENT RECORD
# =============================================================================


class DeploymentRecord(BaseModel):
    """Persistent deployment control record — single source of truth on disk."""

    pipeline: dict

    # Cron expression (e.g. "*/15 * * * *") or "manual" for on-demand only.
    schedule: str = 'manual'

    state: Literal['active', 'paused', 'errored'] = 'active'

    userId: str
    userToken: str

    createdAt: float = Field(default_factory=time.time)
    updatedAt: float = Field(default_factory=time.time)

    def to_client_record(self) -> dict:
        return self.model_dump(exclude={'userToken'})


# =============================================================================
# PERMISSION HELPERS
# =============================================================================

# The complete set of permissions that an org admin implicitly possesses for
# every team within their organisation.  Used to expand the 'org.admin' role
# without storing redundant data in the database.
_FULL_TEAM_PERMISSIONS = [
    'team.admin',
    'task.control',
    'task.data',
    'task.monitor',
    'task.debug',
    'task.store',
]


def resolve_task_permissions(account_info: AccountInfo, task_team_id: str) -> list[str]:
    """
    Return the caller's effective permissions for a task owned by the given team.

    Unlike ``resolve_team_permissions`` this does **not** raise when the caller
    has no relationship to the team — it returns an empty list instead,
    signalling "no access".

    Resolution order:
      1. Check ``account_info.organization``.
      2. Walk its teams looking for *task_team_id*.
      3. If found and org has ``org.admin`` → full permissions.
      4. If found → that team's stored permissions.
      5. Not found → ``[]`` (no access).

    Args:
        account_info: The authenticated caller's session.
        task_team_id: The ``teamId`` from the task's TASK_CONTROL.

    Returns:
        Effective permission list, or empty list if the caller has no
        membership in the task's team.
    """
    org = account_info.organization
    if not org:
        return []
    for team in org.get('teams', []):
        if team['id'] == task_team_id:
            if 'org.admin' in org.get('permissions', []):
                return list(_FULL_TEAM_PERMISSIONS)
            return list(team.get('permissions', []))
    return []


def resolve_team_permissions(account_info: AccountInfo, team_id: str) -> list[str]:
    """
    Return caller's permissions for a specific team.
    Expands org.admin to the full permission set.

    Raises PermissionError if the user has no membership in the given team.

    Args:
        account_info (AccountInfo): The authenticated session whose
            ``organization`` field is inspected.
        team_id (str): The team whose permission list should be resolved.

    Returns:
        list[str]: The effective permission strings for the caller within
            the given team.  If the caller has ``org.admin`` on the
            containing organisation, all permissions in
            ``_FULL_TEAM_PERMISSIONS`` are returned regardless of the
            per-team record.

    Raises:
        PermissionError: If ``team_id`` is not found in the user's org.
    """
    org = account_info.organization
    if org:
        for team in org.get('teams', []):
            if team['id'] == team_id:
                # Org admins get the full permission set regardless of what is
                # stored against the individual team record.
                if 'org.admin' in org.get('permissions', []):
                    return list(_FULL_TEAM_PERMISSIONS)
                # Otherwise return the permissions explicitly stored on the team.
                return list(team.get('permissions', []))
    raise PermissionError(f'No membership in team {team_id!r}')
