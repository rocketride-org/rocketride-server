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
Nodes on the deploy rail.

A developer uploads a ``.rrnode`` (``rrext_deploy add`` with ``kind: 'node'``),
publishes a version of it to ``@me`` or a team (``rrext_deploy_node``), and a
run gets the version its caller is entitled to. A published node's id is
``<developerId>.<name>``; it imports as ``nodes.<developerId>__<name>``.
"""

import hashlib
import io
import os
import re
import stat
import zipfile
from typing import Any, Dict, List, Optional

import json5
from rocketlib import debug, warning

from ai.common.node_packages import (
    NodeNotEntitled,
    NodeNotFound,
    NodePackageInvalid,
    NodeRegistryUnavailable,
    NodeVersionMismatch,
    module_of,
    node_of,
)
from ai.constants import CONST_NODES_CONTRACT

from .app_deploy import _ZIP_MAX_ZIPPED, _actor_of, _developer_id_of, _org_of, _resolve_target, _team_ids_of, _zip_guard
from .deployment_backend import artifact_content_dir

PACKAGE_FILE = 'package.rrnode'

# A requirement line that names an index, a URL or a local path, instead of a package
_UNSAFE_REQUIREMENT = re.compile(r'^\s*-|://|^\s*[./~\\]|\bfile:', re.IGNORECASE)

# What a browser could run from an icon the canvas inlines: a script, foreign HTML, a handler, a javascript: URL
_UNSAFE_SVG = re.compile(r'<\s*(script|foreignObject)\b|\son[a-z]+\s*=|javascript:', re.IGNORECASE)

_RUNG_RANK = {'team': 1, 'user': 2}


def rail_enabled() -> bool:
    """RR_NODE_RAIL_ENABLED=0 turns published nodes off: only the release's nodes serve."""
    return os.environ.get('RR_NODE_RAIL_ENABLED', '1') != '0'


# =============================================================================
# UPLOAD
# =============================================================================


def inspect_package(data: bytes, developer_id: Optional[str]) -> Dict[str, Any]:
    """
    Check an uploaded ``.rrnode`` and return what the rail records about it.

    Args:
        data: The package bytes.
        developer_id: The caller org's developer id; a node id must start with it.

    Returns:
        dict: ``nodeId``, ``module``, ``sha256``, ``services`` ({file: definition})
        and ``icons`` ({file: svg}).

    Raises:
        NodePackageInvalid: The package breaks a rule; the message names it.
        NodeVersionMismatch: The package was built for another node contract.
    """
    if len(data) > _ZIP_MAX_ZIPPED:
        raise NodePackageInvalid(f'The package is over the {_ZIP_MAX_ZIPPED // (1024 * 1024)} MB limit')
    try:
        archive = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile:
        raise NodePackageInvalid('The package is not a zip') from None
    problem = _zip_guard(archive)
    if problem:
        raise NodePackageInvalid(problem)

    entries = archive.infolist()
    if any(stat.S_ISLNK(entry.external_attr >> 16) for entry in entries):
        raise NodePackageInvalid('The package holds a symlink')
    roots = {entry.filename.split('/')[0] for entry in entries}
    if len(roots) != 1:
        raise NodePackageInvalid('The package must hold one folder, the node')
    module = roots.pop()
    node_id = node_of(module)

    if not developer_id:
        raise NodePackageInvalid('Uploading a node requires a registered developer id')
    if not module.isidentifier() or module_of(node_id) != module or not node_id.startswith(f'{developer_id}.'):
        raise NodePackageInvalid(f'The node id {node_id!r} must be {developer_id}.<name>')

    try:
        marker = json5.loads(archive.read(f'{module}/.rrnode'))
    except KeyError:
        raise NodePackageInvalid('The package has no .rrnode marker') from None
    if marker.get('contract') != CONST_NODES_CONTRACT:
        raise NodeVersionMismatch(f'The package was built for node contract {marker.get("contract")!r}')

    files = {entry.filename[len(module) + 1 :]: entry for entry in entries if not entry.is_dir()}
    services = {name: json5.loads(archive.read(entry)) for name, entry in files.items() if _is_services(name)}
    if not services:
        raise NodePackageInvalid('The package has no services.json')

    icons = {}
    for name, definition in services.items():
        _check_definition(name, definition, node_id, module)
        icon = definition.get('icon')
        if icon:
            if icon not in files:
                raise NodePackageInvalid(f'{name}: icon {icon!r} is not in the package')
            icons[icon] = archive.read(files[icon]).decode('utf-8')
            if _UNSAFE_SVG.search(icons[icon]):
                raise NodePackageInvalid(f'{name}: icon {icon!r} carries script')

    for name, entry in files.items():
        if re.fullmatch(r'requirement[^/]*\.txt', name):
            for line in archive.read(entry).decode('utf-8').splitlines():
                if line.strip() and not line.lstrip().startswith('#') and _UNSAFE_REQUIREMENT.search(line):
                    raise NodePackageInvalid(f'{name}: {line.strip()!r} is not a package name')

    return {
        'nodeId': node_id,
        'module': module,
        'sha256': hashlib.sha256(data).hexdigest(),
        'services': services,
        'icons': icons,
    }


def _is_services(name: str) -> bool:
    """A services*.json at the top of the node folder."""
    return '/' not in name and re.fullmatch(r'services.*\.json', name) is not None


def _check_definition(name: str, definition: Dict[str, Any], node_id: str, module: str) -> None:
    """One definition must be a Python node that names itself."""
    if definition.get('node') == 'cpp':
        raise NodePackageInvalid(f'{name}: a C++ node cannot be uploaded')
    if str(definition.get('protocol', '')).split(':')[0] != node_id:
        raise NodePackageInvalid(f'{name}: protocol must be {node_id}://')
    if definition.get('path') != f'nodes.{module}':
        raise NodePackageInvalid(f'{name}: path must be nodes.{module}')
    icon = definition.get('icon')
    if icon and (os.path.isabs(icon) or '..' in re.split(r'[\\/]', icon)):
        raise NodePackageInvalid(f'{name}: icon {icon!r} must be a file inside the node')


def _not_owner(conn: Any, node_id: str, versions: List[Dict[str, Any]]) -> Optional[str]:
    """Why the caller may not change a node: it belongs to whoever uploaded its first version."""
    first = min(versions, key=lambda v: v.get('version', 0), default=None)
    owner = (first or {}).get('publishedBy') or {}
    if first is None or owner.get('userId') == conn._account_info.userId:
        return None
    return f'{node_id} belongs to {owner.get("display") or owner.get("userId")}; only they can change it'


def _home_of(org_id: str, entry: Dict[str, Any]) -> str:
    """The file-store folder that holds one version's package."""
    content = artifact_content_dir(str(entry.get('artifactPath') or ''))
    return f'@/Org/={org_id}/{content[len(f"orgs/{org_id}/files/") :]}'


def _file_store(user_id: str):
    """The internal file store the rail keeps packages in."""
    from ai.account.models import RequestContext
    from ai.account.store import Store

    return Store.file_store(RequestContext.internal('node-deploy'), client_id=user_id)


async def handle_node_add(conn: Any, request: Dict[str, Any]) -> Dict[str, Any]:
    """The node branch of ``rrext_deploy add``: check the package and add it to the rail as a new version."""
    from ai.account import account

    args = request.get('arguments', {}) or {}
    data = args.get('data')
    if not isinstance(data, (bytes, bytearray, memoryview)) or not data:
        return conn.build_error(request, 'data (the .rrnode) is required as a binary frame')
    data = bytes(data)
    node = inspect_package(data, _developer_id_of(conn))

    org_id = _org_of(conn)
    actor = _actor_of(conn)
    refusal = _not_owner(conn, node['nodeId'], await account.deployments_versions(org_id, node['nodeId']))
    if refusal:
        return conn.build_error(request, refusal)
    artifact = {'kind': 'node', 'nodeId': node['nodeId'], 'module': node['module'], 'sha256': node['sha256']}
    metadata = {'node': node, 'build': {'status': 'ok'}}
    entry = await account.deployments_publish(
        org_id,
        node['nodeId'],
        artifact,
        actor,
        comment=str(args.get('comment') or ''),
        metadata=metadata,
        state='private',
    )
    try:
        await _file_store(actor['userId']).write(f'{_home_of(org_id, entry)}/{PACKAGE_FILE}', data)
    except Exception as e:
        # No package behind the version: it can never be published
        await account.set_artifact_state(org_id, node['nodeId'], entry['version'], 'failed', actor)
        return conn.build_error(request, f'The package could not be stored (version {entry["version"]} failed): {e}')
    return conn.build_response(request, body={'artifact': {**artifact, 'version': entry['version']}})


# =============================================================================
# PUBLISH
# =============================================================================


async def handle_deploy_node(conn: Any, request: Dict[str, Any]) -> Dict[str, Any]:
    """
    Handle ``rrext_deploy_node``: ``versions``, ``publish`` and ``unpublish`` of one node.

    Arguments: ``nodeId``; ``publish`` takes ``version`` and ``target``
    (``@me`` or ``@team/<name>``), ``unpublish`` takes ``target``.
    """
    from ai.account import account

    args = request.get('arguments', {}) or {}
    node_id = str(args.get('nodeId') or '')
    developer_id = _developer_id_of(conn)
    if not developer_id or not node_id.startswith(f'{developer_id}.'):
        return conn.build_error(request, f'{node_id!r} is not in your developer namespace')
    org_id = _org_of(conn)
    sub = args.get('subcommand')

    if sub == 'versions':
        versions = await account.deployments_versions(org_id, node_id)
        rows = await account.publish_of_app(org_id, 'node', node_id)
        return conn.build_response(request, body={'versions': versions, 'publishes': rows})

    if sub not in ('publish', 'unpublish'):
        return conn.build_error(request, f'Unknown subcommand {sub!r} (use versions, publish or unpublish)')
    versions = await account.deployments_versions(org_id, node_id)
    refusal = _not_owner(conn, node_id, versions)
    if refusal:
        return conn.build_error(request, refusal)
    target = str(args.get('target') or '')
    if target == '@public':
        return conn.build_error(request, 'A node cannot be published to @public yet; use @me or @team/<name>')
    audience = _resolve_target(conn, target)

    if sub == 'unpublish':
        row = await account.publish_set_state(org_id, 'node', node_id, audience, 'removed', _actor_of(conn))
        return conn.build_response(request, body={'publish': row})

    version = args.get('version')
    entry = next((v for v in versions if v.get('version') == version), None)
    if entry is None or entry.get('kind') != 'node':
        return conn.build_error(request, f'{node_id} has no node version {version!r}')
    if entry.get('state') == 'failed':
        return conn.build_error(request, f'Version {version} of {node_id} failed and cannot be published')
    node = entry['metadata']['node']
    snapshot = {key: node[key] for key in ('module', 'sha256', 'services', 'icons')}
    row = await account.publish_set(org_id, 'node', node_id, audience, version, snapshot, _actor_of(conn))
    return conn.build_response(request, body={'publish': row})


# =============================================================================
# RESOLVE
# =============================================================================


def audiences(user_id: str, team_ids: List[str]) -> List[Dict[str, str]]:
    """The rungs a caller reaches: their own and each of their teams."""
    return [{'type': 'team', 'id': team} for team in sorted(set(team_ids))] + [{'type': 'user', 'id': user_id}]


async def entitled_nodes(org_id: str, user_id: str, team_ids: List[str]) -> Dict[str, Dict[str, Any]]:
    """
    Every published node the caller is entitled to, with the version their most specific rung binds.

    Returns:
        dict: node id -> the publish row (``version``, ``artifactPath``, ``snapshot``).

    Raises:
        NodeRegistryUnavailable: The rail could not be read.
    """
    from ai.account import account

    if not rail_enabled():
        return {}
    try:
        rows = await account.publish_list(org_id, 'node', audiences(user_id, team_ids))
    except Exception as e:
        raise NodeRegistryUnavailable(f'The node registry did not answer: {e}') from None
    best: Dict[str, Dict[str, Any]] = {}
    for row in rows:
        if row.get('state') != 'enabled' or row.get('artifactState') == 'failed':
            continue
        current = best.get(row['appId'])
        rank = _RUNG_RANK.get(row['audience']['type'], 0)
        if current is None or rank > _RUNG_RANK.get(current['audience']['type'], 0):
            best[row['appId']] = row
    return best


async def resolve_nodes(org_id: str, user_id: str, team_ids: List[str], names: List[str]) -> Dict[str, Dict[str, Any]]:
    """
    The publish row of each published node a pipeline names, refusing the ones the caller cannot run.

    Names without a dot are the release's own nodes and are left out.

    Raises:
        NodeNotEntitled: A node exists in the org but is not published to the caller.
        NodeNotFound: No such node anywhere.
        NodeRegistryUnavailable: The rail could not be read.
    """
    from ai.account import account

    wanted = sorted({name for name in names if '.' in name})
    if not wanted:
        return {}
    entitled = await entitled_nodes(org_id, user_id, team_ids)
    for name in wanted:
        if name in entitled:
            continue
        if rail_enabled() and await account.deployments_versions(org_id, name):
            raise NodeNotEntitled(f'{name} is not published to you or any of your teams')
        raise NodeNotFound(f'There is no node {name}')
    return {name: entitled[name] for name in wanted}


def _identity(conn: Any) -> tuple:
    """(org, user, team ids) of an authenticated connection."""
    return _org_of(conn), conn._account_info.userId, list(_team_ids_of(conn).values())


async def visible_nodes(conn: Any) -> Dict[str, Dict[str, Any]]:
    """The published nodes the catalogue shows this caller; none when the rail does not answer."""
    if not getattr(conn, '_account_info', None):
        return {}
    try:
        return await entitled_nodes(*_identity(conn))
    except NodeRegistryUnavailable as e:
        warning(f'NODE_REGISTRY_UNAVAILABLE: {e}; the catalogue shows only the release nodes')
        return {}


async def nodes_for(conn: Any, components: List[Dict[str, Any]]) -> Dict[str, Dict[str, Any]]:
    """The published nodes a pipeline names, resolved for this caller; refuses one they cannot run."""
    names = [component.get('provider', '') for component in components]
    if not getattr(conn, '_account_info', None):
        return await resolve_nodes('local', '', [], names)
    return await resolve_nodes(*_identity(conn), names)


async def read_package(org_id: str, user_id: str, row: Dict[str, Any]) -> bytes:
    """The bytes of the version a publish row binds, read for the run's caller and checked against its digest."""
    data = await _file_store(user_id).read(f'{_home_of(org_id, row)}/{PACKAGE_FILE}')
    if hashlib.sha256(data).hexdigest() != row['snapshot']['sha256']:
        raise NodePackageInvalid(f'The stored package of {row["appId"]} does not match its digest')
    debug(f'[node_deploy] serving {row["appId"]} v{row["version"]}')
    return data
