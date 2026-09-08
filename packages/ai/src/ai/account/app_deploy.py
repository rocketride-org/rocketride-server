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
App deployments — the publish ladder on the deployments registry (kind:'app').

Apps ride the SAME teams-as-environments registry pipelines use
(deployment_backend: immutable versioned artifacts + per-pointer records in
``orgs/<org>/files/.deployments/<key>/``), with two adaptations:

- The ARTIFACT is a small ``kind:'app'`` JSON record — app id, moduleId,
  display name, semver, and the store path of the published bundle
  directory. The bundle bytes live at a platform path written at publish
  time; the registry pins metadata, exactly as it pins pipeline JSON.
- The pointer keys encode the RUNG LADDER on top of team pointers:
      ``user~<userId>``   personal rung (audience of one)
      ``<teamId>``        team rung (a real team)
      ``~org``            org rung (everyone in the org)
  The public/store rung is NOT here — it lives in the marketplace DB with
  its per-version review gate.

Verbs (DAP command ``rrext_app_deploy``): ``publish`` (snapshot an
immutable version — no auto-activation anywhere), ``versions`` (the rail),
``deploy`` (pin a rung; first publish, update, promote, and rollback are
all this one verb), ``where`` (the reverse index).

Shared platform infrastructure: works on the OSS local engine (single
implicit org/user 'local') and SaaS alike — no marketplace dependency.
"""

from typing import Any, Dict, List, Optional

from rocketlib import debug

# Rung encoding on the registry's team-pointer keys (see module docstring).
_ORG_KEY = '~org'
_USER_PREFIX = 'user~'


# Published bundle bytes live at a flat platform path (like marketplace
# bundles) — org-scoped, keyed by app + registry sha so re-publishes of
# identical bytes coexist safely.
def _bundle_dir(org_id: str, app_id: str, semver: str) -> str:
    """Platform store directory for one published app bundle."""
    return f'appbundles/{org_id}/{app_id}/{semver}'


def _actor_of(conn: Any) -> Dict[str, str]:
    """Builds the registry's denormalized actor record from the session."""
    info = conn._account_info
    return {
        'userId': info.userId,
        'display': getattr(info, 'displayName', '') or '',
        'email': getattr(info, 'email', '') or '',
    }


def _org_of(conn: Any) -> str:
    """The caller's org id ('local' on OSS)."""
    info = conn._account_info
    org = getattr(info, 'organization', None)
    if isinstance(org, dict):
        return org.get('id') or 'local'
    return getattr(org, 'id', None) or 'local'


def _team_ids_of(conn: Any) -> Dict[str, str]:
    """The caller's team name -> id map (names ride the wire)."""
    info = conn._account_info
    org = getattr(info, 'organization', None)
    teams = (org.get('teams') if isinstance(org, dict) else getattr(org, 'teams', None)) or []
    out: Dict[str, str] = {}
    for team in teams:
        tid = team.get('id') if isinstance(team, dict) else getattr(team, 'id', None)
        name = team.get('name') if isinstance(team, dict) else getattr(team, 'name', None)
        if tid:
            out[str(name or tid)] = str(tid)
            out[str(tid)] = str(tid)
    return out


def _resolve_target(conn: Any, target: str) -> Dict[str, str]:
    """
    Resolves a wire target ('@user' | '@team/<name-or-id>' | '@org') to the
    registry pointer key + the rung word.

    Raises:
        ValueError: Unknown/malformed target, or a team the caller is not in.
    """
    user_id = conn._account_info.userId
    if target in ('@user', '@me'):
        return {'key': f'{_USER_PREFIX}{user_id}', 'rung': 'personal'}
    if target == '@org':
        return {'key': _ORG_KEY, 'rung': 'org'}
    if target.startswith('@team/'):
        ref = target[len('@team/') :]
        teams = _team_ids_of(conn)
        if ref not in teams:
            raise ValueError(f'Unknown team: {ref!r} (you are not a member, or it does not exist)')
        return {'key': teams[ref], 'rung': 'team'}
    raise ValueError(f'Unknown deploy target: {target!r} (use @user, @team/<name>, or @org)')


# =============================================================================
# DAP HANDLER
# =============================================================================


async def handle_app_deploy(conn: Any, request: Dict[str, Any]) -> Dict[str, Any]:
    """
    Handle the ``rrext_app_deploy`` command for both platform flavours.

    Subcommands: publish / versions / deploy / where (see module docstring).
    Requires an authenticated connection; org scoping comes from the session.
    """
    from ai.account import account

    info = getattr(conn, '_account_info', None)
    if not info or not getattr(info, 'userId', None):
        return conn.build_error(request, 'rrext_app_deploy requires an authenticated connection')

    args = request.get('arguments', {}) or {}
    sub = args.get('subcommand', '')
    app_id = args.get('appId', '')
    if not app_id:
        return conn.build_error(request, 'appId is required')
    org_id = _org_of(conn)

    # ── publish — snapshot an immutable version (never auto-activates) ────
    if sub == 'publish':
        semver = args.get('version', '')
        message = str(args.get('message', '') or '')
        bundle = args.get('data')
        module_id = args.get('moduleId') or app_id.replace('.', '_').replace('-', '_')
        name = args.get('name') or app_id
        if not semver:
            return conn.build_error(request, 'version is required')
        if not bundle:
            return conn.build_error(request, 'data (bundle bytes) is required')

        # v1 transport limitation: one binary frame = the remoteEntry.js.
        # Multi-file bundles (async chunks) arrive with the zip upload (M5);
        # until then single-file bundles cover template-scale apps.
        bundle_dir = _bundle_dir(org_id, app_id, semver)
        await conn._server.store.write_bytes(f'{bundle_dir}/remoteEntry.js', bundle)

        artifact = {
            'kind': 'app',
            'appId': app_id,
            'moduleId': module_id,
            'name': name,
            'appVersion': semver,
            'bundleDir': bundle_dir,
        }
        entry = await account.deployments_publish(org_id, app_id, artifact, _actor_of(conn), comment=message)
        debug(f'[app_deploy] published {app_id} v{semver} as registry v{entry.get("version")}')
        return conn.build_response(request, body={'entry': _rail_entry(entry, artifact)})

    # ── versions — the rail, newest first ─────────────────────────────────
    if sub == 'versions':
        entries = await account.deployments_versions(org_id, app_id)
        rail: List[Dict[str, Any]] = []
        for entry in sorted(entries, key=lambda e: -int(e.get('version', 0))):
            artifact = await _artifact_of(account, org_id, app_id, entry)
            rail.append(_rail_entry(entry, artifact))
        # Rung chips: which rungs currently pin which registry version
        pins = await _pins_of(conn, account, org_id, app_id)
        by_version: Dict[int, List[str]] = {}
        for pin in pins:
            by_version.setdefault(int(pin['version']), []).append(pin['rung'])
        for row in rail:
            row['rungs'] = by_version.get(int(row['registryVersion']), [])
        return conn.build_response(request, body={'versions': rail})

    # ── deploy — pin a rung (update / promote / rollback are all this) ────
    if sub == 'deploy':
        version = args.get('version')
        target = args.get('target', '')
        if not isinstance(version, int):
            return conn.build_error(request, 'version (registry version number) is required')
        resolved = _resolve_target(conn, target)
        record = await account.deployments_deploy(org_id, resolved['key'], app_id, version, _actor_of(conn))

        # Personal deploys land on the desktop automatically: the pin itself
        # resolves into the user's manifest with onDesktop=True through the
        # scope walk (resolve_app_pins) — no marketplace row required.

        # Refresh the acting user's manifest (data + signal); other audience
        # members pick the pin up on their next account rebuild/login.
        try:
            from ai.account.dev_overlay import push_refresh

            await push_refresh(conn._server, conn._account_info.userId, source='app-deploy')
        except Exception as exc:
            debug(f'[app_deploy] refresh push failed: {exc}')

        return conn.build_response(request, body={'deployment': record, 'rung': resolved['rung']})

    # ── where — the reverse index (rung → pinned version) ─────────────────
    if sub == 'where':
        pins = await _pins_of(conn, account, org_id, app_id)
        return conn.build_response(request, body={'pins': pins})

    return conn.build_error(request, f'Unknown subcommand: {sub!r}')


# =============================================================================
# HELPERS
# =============================================================================


def _rail_entry(entry: Dict[str, Any], artifact: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    """One version-rail row: registry facts + the app artifact's semver."""
    who = entry.get('publishedBy') or {}
    return {
        'registryVersion': entry.get('version'),
        'appVersion': (artifact or {}).get('appVersion') or '',
        'sha256': entry.get('sha256', ''),
        'publishedAt': entry.get('publishedAt'),
        'author': who.get('display') or who.get('email') or who.get('userId') or '',
        'message': entry.get('comment', ''),
        'bundleDir': (artifact or {}).get('bundleDir') or '',
    }


async def _artifact_of(account: Any, org_id: str, app_id: str, entry: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """Reads one registry entry's app artifact (None on any failure)."""
    try:
        return await account.deployments_artifact(org_id, app_id, int(entry.get('version', 0)))
    except Exception:
        return None


async def _pins_of(conn: Any, account: Any, org_id: str, app_id: str) -> List[Dict[str, Any]]:
    """
    The caller-visible reverse index for one app: their personal pin, each
    of their teams' pins, and the org pin (rows absent where nothing is
    deployed or the pointer is removed).
    """
    user_id = conn._account_info.userId
    teams = _team_ids_of(conn)
    # Unique team ids with a display handle (prefer the name spelling)
    handles: Dict[str, str] = {}
    for ref, tid in teams.items():
        if ref != tid or tid not in handles:
            handles[tid] = ref if ref != tid else handles.get(tid, tid)

    probes: List[Dict[str, str]] = [{'key': f'{_USER_PREFIX}{user_id}', 'rung': 'personal', 'handle': '@user'}]
    for tid, name in handles.items():
        probes.append({'key': tid, 'rung': 'team', 'handle': f'@team/{name}'})
    probes.append({'key': _ORG_KEY, 'rung': 'org', 'handle': '@org'})

    pins: List[Dict[str, Any]] = []
    for probe in probes:
        try:
            dep = await account.deployments_get(org_id, probe['key'], app_id)
        except Exception:
            dep = None
        if not dep or dep.get('state') == 'removed':
            continue
        artifact = await _artifact_of(account, org_id, app_id, {'version': dep.get('version')})
        pins.append(
            {
                'rung': probe['rung'],
                'handle': probe['handle'],
                'version': dep.get('version'),
                'appVersion': (artifact or {}).get('appVersion') or '',
                'state': dep.get('state', 'enabled'),
                'deployedAt': dep.get('deployedAt'),
            }
        )
    return pins


# =============================================================================
# MANIFEST RESOLUTION — the scope walk
# =============================================================================


async def resolve_app_pins(org_id: str, user_id: str, team_ids: List[str]) -> List[Dict[str, Any]]:
    """
    Resolves the caller's deployed apps via the scope walk: org rung first,
    then each team, then the personal rung — most specific WINS on id
    collisions (user > team > org). Returns manifest-shaped entries with
    fs_geturl-signed bundle URLs (decision D10), ready to merge into the
    account's app list. Pure additive input to the assembly — the dev
    overlay still overrides on top.
    """
    from ai.account import account
    from ai.account.file_store import mint_directory_url

    resolved: Dict[str, Dict[str, Any]] = {}

    # Walk least → most specific so later rungs overwrite by app id
    walk: List[Dict[str, str]] = [{'key': _ORG_KEY, 'rung': 'org'}]
    walk += [{'key': tid, 'rung': 'team'} for tid in team_ids]
    walk.append({'key': f'{_USER_PREFIX}{user_id}', 'rung': 'personal'})

    for step in walk:
        try:
            deployments = await account.deployments_list(org_id, step['key'])
        except Exception:
            continue
        for dep in deployments or []:
            if dep.get('state') not in (None, 'enabled'):
                continue
            project_id = dep.get('projectId') or dep.get('project_id') or ''
            version = dep.get('version')
            if not project_id or not isinstance(version, int):
                continue
            try:
                artifact = await account.deployments_artifact(org_id, project_id, version)
            except Exception:
                continue
            if not isinstance(artifact, dict) or artifact.get('kind') != 'app':
                continue  # pipeline deployments share the registry — skip them
            try:
                entry_url = mint_directory_url(artifact['bundleDir'], 'remoteEntry.js', sub='app-deploy')
            except Exception as exc:
                debug(f'[app_deploy] signed entry mint failed for {project_id}: {exc}')
                continue
            resolved[artifact['appId']] = {
                'id': artifact['appId'],
                'moduleId': artifact.get('moduleId') or artifact['appId'].replace('.', '_'),
                'name': artifact.get('name') or artifact['appId'],
                'description': f'Deployed v{artifact.get("appVersion", "")} ({step["rung"]})',
                'entry': entry_url,
                'version': artifact.get('appVersion', ''),
                'authenticated': True,
                'public': False,
                'appStatus': 'deployed',
                'onDesktop': True,
            }
    return list(resolved.values())
