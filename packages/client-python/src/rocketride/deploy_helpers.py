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

"""
Pure helpers shared by every deploy/publish host, so team naming, version
validation, and version picking have one implementation. Twin of the
TypeScript SDK's ``deploy-helpers`` — keep the two in sync.
"""

import math
import re
from typing import Any, Iterable, List, Optional, TypedDict, TypeVar

# =============================================================================
# REGISTRY VERSIONS
# =============================================================================


def parse_registry_version(value: Any) -> int:
    """
    Parse a registry version argument, rejecting anything that is not a positive integer.

    A missing or non-numeric value would otherwise silently change deployment
    state against an unspecified version. Accepts ``3``, ``'3'`` and ``'v3'``.

    Args:
        value: The raw version (int or numeric string).

    Returns:
        The validated registry version (v1 is the first).

    Raises:
        ValueError: When the value is not a positive integer.
    """
    # bool is an int subclass; True must not read as version 1
    if isinstance(value, bool) or not isinstance(value, (int, float, str)):
        raise ValueError(f'Invalid registry version: {value!r}')
    if isinstance(value, str):
        text = re.sub(r'^v', '', value.strip(), flags=re.IGNORECASE)
        if not re.fullmatch(r'\d+', text):
            raise ValueError(f'Invalid registry version: {value!r}')
        version = int(text)
    elif isinstance(value, float):
        if not math.isfinite(value) or not value.is_integer():
            raise ValueError(f'Invalid registry version: {value!r}')
        version = int(value)
    else:
        version = value
    if version <= 0:
        raise ValueError(f'Invalid registry version: {value!r}')
    return version


_Row = TypeVar('_Row', bound=dict)


def pick_publish_version(rows: Iterable[_Row]) -> Optional[_Row]:
    """
    Pick the version a bare "publish this app" means: the newest version that has not failed.

    A failed review state or a failed build disqualifies a row. A newer
    version that is still building is the pick — callers wait for its build
    rather than silently publishing an older one.

    Args:
        rows: The app's version rail (``list_deployments``), any order.

    Returns:
        The picked row, or None when every version failed or none exist.
    """
    picked: Optional[_Row] = None
    for row in rows:
        if row.get('state') == 'failed' or row.get('buildStatus') == 'failed':
            continue
        if picked is None or row.get('registryVersion', 0) > picked.get('registryVersion', 0):
            picked = row
    return picked


# =============================================================================
# TEAMS
# =============================================================================


class DeployTeamRef(TypedDict):
    """
    One deploy target the caller can address.

    Attributes:
        id: Team id, or ``'@me'`` for the caller's personal space.
        name: Display name.
        canControl: The caller holds ``task.control`` on this team.
    """

    id: str
    name: str
    canControl: bool


def resolve_deploy_teams(client: Any, deployments: Iterable[dict]) -> List[DeployTeamRef]:
    """
    Resolve the caller's deploy targets (names + control rights) from the authenticated identity.

    - ``'@me'`` (the personal space) comes first for any signed-in user.
    - ``org.admin`` (and ``sys.admin``) implies the full team permission set.
    - Rosterless identities (the OSS single-team server) derive refs from the
      deployment rows with control assumed — the server enforces the real
      permission on every call. Personal (``user~``) rows never become targets.

    Args:
        client: A connected client (its cached login result is read), or None.
        deployments: Deployment rows used as the rosterless fallback.

    Returns:
        The addressable team refs.
    """
    info = (client.get_account_info() if client is not None else None) or {}
    org = info.get('organization') or {}
    me: List[DeployTeamRef] = [{'id': '@me', 'name': 'Me', 'canControl': True}] if info.get('userId') else []
    is_admin = 'org.admin' in (org.get('permissions') or []) or 'sys.admin' in (info.get('sysPermissions') or [])

    # step: prefer the identity's team roster when one exists
    org_teams = org.get('teams')
    if isinstance(org_teams, list) and org_teams:
        return me + [
            {
                'id': t['id'],
                'name': t.get('name') or t['id'],
                'canControl': is_admin or 'task.control' in (t.get('permissions') or []),
            }
            for t in org_teams
            if t.get('id')
        ]

    # step: rosterless — derive refs from the rows so hosts still render
    seen: dict = {}
    for dep in deployments:
        team_id = dep.get('teamId')
        if team_id and not team_id.startswith('user~') and team_id not in seen:
            seen[team_id] = {'id': team_id, 'name': team_id, 'canControl': True}
    return me + list(seen.values())


def team_name_of(teams: List[DeployTeamRef], team_id: str, own_user_id: str = '') -> str:
    """
    Resolve a team id to its display name, falling back to the id.

    Personal (``user~``) owner keys render as "Me" for the caller's own space
    and "Personal" for another user's — the raw guid never reaches a label.

    Args:
        teams: The resolved team refs.
        team_id: The team id (or owner key) to resolve.
        own_user_id: The caller's user id ('' when unknown).

    Returns:
        The display name, or the id when unknown.
    """
    if team_id.startswith('user~'):
        return 'Me' if own_user_id and team_id == f'user~{own_user_id}' else 'Personal'
    return next((t['name'] for t in teams if t['id'] == team_id), team_id)


def wire_team_id_of(team_id: str, own_user_id: str) -> str:
    """
    Translate a row's owner key into the addressable team ref for API calls.

    The caller's own ``user~{uid}`` row is addressed as ``'@me'`` (the server
    never accepts raw owner keys); everything else passes through.

    Args:
        team_id: The row's team id / owner key.
        own_user_id: The caller's user id ('' when unknown).

    Returns:
        The team id to put on the wire.
    """
    return '@me' if own_user_id and team_id == f'user~{own_user_id}' else team_id


def resolve_team_arg(value: str, teams: List[DeployTeamRef]) -> str:
    """
    Resolve what a person typed as a team — ``'@me'``, a team id, or a display name — to the id to send.

    Names match case-insensitively. An unknown value passes through unchanged
    (the server validates it; an admin may address a team outside their own
    roster).

    Args:
        value: The typed team ('' = unscoped/default).
        teams: The caller's resolved team refs.

    Returns:
        The team id to put on the wire.

    Raises:
        ValueError: When a name matches more than one team.
    """
    typed = value.strip()
    if not typed or typed == '@me' or any(t['id'] == typed for t in teams):
        return typed
    by_name = [t for t in teams if t['name'].lower() == typed.lower()]
    if len(by_name) > 1:
        ids = ', '.join(t['id'] for t in by_name)
        raise ValueError(f'Team name "{typed}" is ambiguous — use one of the ids: {ids}')
    return by_name[0]['id'] if by_name else typed


# =============================================================================
# PIPELINES
# =============================================================================


def pipeline_name_from_path(file_path: str) -> str:
    """
    The registry name for a pipeline file whose JSON carries none.

    ``.pipe`` names live in filenames, and every deploy surface renders the
    pipeline name.

    Args:
        file_path: The pipeline file path (either separator).

    Returns:
        The basename without its ``.pipe`` / ``.pipe.json`` extension.
    """
    base = re.split(r'[\\/]', file_path)[-1] or file_path
    return re.sub(r'\.pipe(?:\.json)?$', '', base) or base
