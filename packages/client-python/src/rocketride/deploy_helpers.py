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
        id: What a deploy verb's ``team_id`` takes for this target, passed
            unchanged: ``'@me'`` for the caller's personal space, or the
            team's audience as the server composed it (``=team/<tid>``).
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
    - Each team of the roster is addressed by the ``audience`` the server
      stamped on it; a team without one is not addressable and is skipped.
    - The org rung follows the teams, addressed by the organisation's
      ``audience``; only org admins (and ``sys.admin``) control it.
    - ``org.admin`` (and ``sys.admin``) implies the full team permission set.
    - Rosterless identities (the OSS single-team server) derive refs from the
      deployment rows the server marked ``rung: 'team'``, named by their
      ``handle``, with control assumed — the server enforces the real
      permission on every call. No audience string is parsed here.

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
    org_rung: List[DeployTeamRef] = (
        [{'id': org['audience'], 'name': 'Org', 'canControl': is_admin}] if org.get('audience') else []
    )

    # step: prefer the identity's team roster when one exists
    org_teams = org.get('teams')
    if isinstance(org_teams, list) and org_teams:
        roster: List[DeployTeamRef] = [
            {
                'id': t['audience'],
                'name': t.get('name') or t['audience'],
                'canControl': is_admin or 'task.control' in (t.get('permissions') or []),
            }
            for t in org_teams
            if t.get('audience')
        ]
        return me + roster + org_rung

    # step: rosterless — derive refs from the team rows so hosts still render
    seen: dict = {}
    for dep in deployments:
        team_id = dep.get('teamId')
        if team_id and dep.get('rung') == 'team' and team_id not in seen:
            seen[team_id] = {'id': team_id, 'name': dep.get('handle') or team_id, 'canControl': True}
    return me + list(seen.values()) + org_rung


def team_name_of(teams: List[DeployTeamRef], team_id: str, own_user_id: str = '') -> str:
    """
    The name of the team ref whose ``id`` is ``team_id``, else ``team_id`` unchanged.

    .. deprecated::
        Show a row's ``handle`` instead: the server composes it for the
        reader (plan 2.5). Kept for the frozen contract; it parses nothing.

    Args:
        teams: The resolved team refs.
        team_id: A ref id or a row's ``teamId``, matched exactly.
        own_user_id: Unused; kept for the frozen signature.

    Returns:
        The matching ref's name, or ``team_id``.
    """
    return next((t['name'] for t in teams if t['id'] == team_id), team_id)


def wire_team_id_of(team_id: str, own_user_id: str) -> str:
    """
    The value to put on the wire for a row's ``teamId``: the value itself.

    .. deprecated::
        A row's ``teamId`` is its audience and every deploy verb takes it
        back unchanged (plan 2.5); there is nothing to translate. Kept for
        the frozen contract.

    Args:
        team_id: The row's ``teamId``.
        own_user_id: Unused; kept for the frozen signature.

    Returns:
        ``team_id``, unchanged.
    """
    return team_id


def resolve_team_arg(value: str, teams: List[DeployTeamRef]) -> str:
    """
    What a person typed as a team, passed through for the server to resolve.

    The server reads every spelling (``@me``, ``@public``, ``@<team>`` by
    name ignoring case, ``=team/<tid>``, a row's audience) and refuses an
    unknown one; the SDK matches nothing (plan 2.5).

    Args:
        value: The typed team ('' = unscoped/default).
        teams: Unused; kept for the frozen signature.

    Returns:
        The typed value, trimmed.
    """
    return value.strip()


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
        The basename without its ``.pipe`` extension.
    """
    base = re.split(r'[\\/]', file_path)[-1] or file_path
    return re.sub(r'\.pipe$', '', base) or base


# =============================================================================
# REGISTRY NAMES
# =============================================================================

# The developer id a build names itself under when its organization has none yet.
LOCAL_DEVELOPER_ID = 'local'


def registry_id_of(slug: str, developer_id: Optional[str]) -> str:
    """
    The registry name a deploy row carries for a short id.

    The server composes ``<developerId>.<slug>`` from the deploying
    organization; this is the value to MATCH rows and events against.

    Args:
        slug: The short id the file carries.
        developer_id: The caller organization's developer id, if known.

    Returns:
        The registry name, or ``''`` when the developer id is unknown (no row
        can match: nothing deploys without one).
    """
    if not slug or not developer_id:
        return ''
    return slug if '.' in slug else f'{developer_id}.{slug}'
