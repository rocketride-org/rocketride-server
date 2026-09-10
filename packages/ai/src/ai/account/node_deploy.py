# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Node deployments — the node branch of the generic ``rrext_deploy add`` rail.

Nodes ride the SAME registry apps and pipes use (``deployment_backend``:
immutable versioned artifacts under ``orgs/<org>/files/.deployments/<key>/``).
Nothing here is a parallel mechanism; this module is the ``kind:'node'``
adapter, the way ``app_deploy`` is the ``kind:'app'`` one.

What a node deployment is:

- The ARTIFACT is a small ``kind:'node'`` JSON record — node id, display name,
  version, runtime, and the digest of the bundle. The registry pins metadata
  and treats the record as opaque, exactly as it pins pipeline JSON.
- The CONTENT is the node directory as a zip, retained at
  ``<artifact sibling>/bundle/`` for provenance and unpacked into
  ``.../source/`` — the tree the engine materializes from at run time.

Unlike an app, a Python node needs no server-side build: the source IS what
runs. The lifecycle field is still recorded, because native nodes (#1577) will
ship compiled libraries built against one engine toolchain and will need one.
``runtime`` is carried from the first version for the same reason — a native
node's content is per-platform, so the schema has to admit more than one
artifact per version before such a node exists, not after.

Shared platform infrastructure: works on the OSS local engine (single implicit
org/user 'local') and SaaS alike.
"""

from __future__ import annotations

import hashlib
import time
from typing import Any, Dict, List

from rocketlib import debug

# The zip guards live with the app rail and are shared verbatim: the threat is
# the archive, not what it carries, and one implementation is one place to fix.
from ai.account.app_deploy import _ZIP_MAX_ZIPPED, _actor_of, _org_of, _zip_guard
from ai.account.deployment_backend import artifact_content_dir

#: Node runtimes. 'python' is a source tree the engine imports as-is. 'native'
#: is reserved for the compiled nodes of #1577, whose content is per-platform
#: and tied to the engine build it was compiled against.
RUNTIME_PYTHON = 'python'
RUNTIME_NATIVE = 'native'

#: The manifest a node zip must carry at its root — the node's own declaration,
#: read for the id and name rather than trusting what the caller says it sent.
NODE_MANIFEST = 'services.json'

#: Cap on the manifest read before the archive guard has run.
_MANIFEST_MAX = 512 * 1024


def _safe_node_id(value: str) -> str:
    """A node id is a path segment in the store, so it is validated like one."""
    node_id = str(value or '').strip()
    if not node_id:
        raise ValueError('the node manifest carries no id')
    if len(node_id) > 128:
        raise ValueError(f'node id is too long: {node_id[:32]!r}...')
    for bad in ('/', '\\', ':', '..'):
        if bad in node_id:
            raise ValueError(f'node id has an unsafe character ({bad!r}): {node_id!r}')
    if node_id.startswith('.'):
        raise ValueError(f'node id may not start with a dot: {node_id!r}')
    return node_id


def _manifest_of_zip(archive: Any) -> Dict[str, Any]:
    """Read the node's own ``services.json`` from the zip root.

    The declaration inside the archive is the truth: taking the id from the
    request would let a caller publish under a name the zip does not carry.
    """
    import json

    names = [n for n in archive.namelist() if n.replace('\\', '/') == NODE_MANIFEST]
    if not names:
        raise ValueError(f'the zip has no {NODE_MANIFEST} at its root')
    try:
        with archive.open(names[0]) as handle:
            raw = handle.read(_MANIFEST_MAX + 1)
    except Exception:
        raise ValueError(f'{NODE_MANIFEST} could not be read')
    if len(raw) > _MANIFEST_MAX:
        raise ValueError(f'{NODE_MANIFEST} exceeds the {_MANIFEST_MAX}-byte cap')
    try:
        manifest = json.loads(raw)
    except Exception as exc:
        raise ValueError(f'{NODE_MANIFEST} is not valid JSON: {exc}')
    if not isinstance(manifest, dict):
        raise ValueError(f'{NODE_MANIFEST} must be an object')
    return manifest


async def handle_node_add(conn: Any, request: Dict[str, Any]) -> Dict[str, Any]:
    """The node branch of ``rrext_deploy add``: publish a node version.

    Receives ONE zip of the node directory via the binary ``arguments.data``
    frame, checks it, registers an immutable version, and lays the content
    down beside the artifact:

        <artifact sibling>/bundle/<nodeId>-v<NNNNNN>.zip   retained transport
        <artifact sibling>/source/...                      unpacked tree

    Publishing does NOT make the node reachable: the version is inert until a
    rung is pinned to it, the same rule apps follow.
    """
    from ai.account import account

    info = getattr(conn, '_account_info', None)
    if not info or not getattr(info, 'userId', None):
        return conn.build_error(request, 'deploying a node requires an authenticated connection')

    args = request.get('arguments', {}) or {}
    org_id = _org_of(conn)
    comment = str(args.get('comment', '') or '')

    data = args.get('data')
    if not data:
        return conn.build_error(request, 'data (the node directory zip) is required')
    # A str here would make zipfile raise TypeError and escape as a 500 rather
    # than a clean DAP error, so bytes-like inputs are normalised and the rest
    # refused outright.
    if isinstance(data, (bytearray, memoryview)):
        data = bytes(data)
    elif not isinstance(data, bytes):
        return conn.build_error(request, 'data must be a binary zip frame (bytes), not text')
    # Measured on the zipped bytes and refused before any parsing: a node
    # directory is small, and the unpacked guard below still applies.
    if len(data) > _ZIP_MAX_ZIPPED:
        return conn.build_error(
            request,
            f'node zip is {len(data) // (1024 * 1024)} MB — the upload cap is '
            f'{_ZIP_MAX_ZIPPED // (1024 * 1024)} MB zipped',
        )

    import io
    import zipfile

    try:
        archive = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile:
        return conn.build_error(request, 'data is not a valid zip archive')

    try:
        manifest = _manifest_of_zip(archive)
        node_id = _safe_node_id(manifest.get('protocol', '').replace('://', '') or manifest.get('id', ''))
    except ValueError as exc:
        return conn.build_error(request, str(exc))

    # Traversal and bombs are refused BEFORE a registry row exists, so a bad
    # archive never leaves a version behind.
    guard_error = _zip_guard(archive)
    if guard_error:
        return conn.build_error(request, guard_error)

    node_version = str(manifest.get('version') or '0.0.0')
    artifact = {
        'kind': 'node',
        'nodeId': node_id,
        'name': str(manifest.get('title') or node_id),
        'nodeVersion': node_version,
        # Carried from the first version: a native node's content is
        # per-platform, and a resolver has to know what it is fetching before
        # it fetches it.
        'runtime': RUNTIME_PYTHON,
        'bundleSha256': hashlib.sha256(data).hexdigest(),
    }
    caller_meta = args.get('metadata') if isinstance(args.get('metadata'), dict) else {}
    metadata = {
        **caller_meta,
        'manifest': manifest,
        # A python node's source IS what runs, so it is born ready. The field
        # exists because native nodes will not be.
        'build': {'status': 'ready', 'readyAt': time.time()},
    }

    entry = await account.deployments_publish(
        org_id, node_id, artifact, _actor_of(conn), comment=comment, metadata=metadata
    )
    version = int(entry.get('version', 0))

    # ── Content beside the artifact, through the Store interface ──────────
    from ai.account.models import RequestContext
    from ai.account.store import Store

    fs = Store.file_store(RequestContext.internal('node-deploy'), client_id=info.userId)
    written: List[str] = []
    try:
        content_root = artifact_content_dir(str(entry.get('artifactPath') or ''))
        org_prefix = f'orgs/{org_id}/files/'
        if not content_root.startswith(org_prefix):
            raise ValueError(f'registry entry carries no usable artifactPath ({content_root!r})')
        home = f'@/Org/={org_id}/{content_root[len(org_prefix) :]}'

        path = f'{home}/bundle/{node_id}-v{version:06d}.zip'
        # Recorded BEFORE the write: a write that fails partway still leaves
        # bytes behind, and the compensation loop only deletes what it knows.
        written.append(path)
        await fs.write(path, bytes(data))

        for item in archive.infolist():
            if item.is_dir():
                continue
            path = f'{home}/source/{item.filename}'
            written.append(path)
            await fs.write(path, archive.read(item))
    except Exception as exc:
        # The registry row is allocated before the content writes, because
        # version allocation is what names these paths. A failure here would
        # otherwise strand a version with no bytes behind it.
        for path in written:
            try:
                await fs.delete(path)
            except Exception:
                pass  # best-effort; the 'failed' state is what gates serving
        try:
            await account.set_artifact_state(org_id, node_id, version, 'failed', _actor_of(conn))
        except Exception:
            pass
        return conn.build_error(request, f'node content could not be stored: {exc}')

    debug(f'[node_deploy] published {node_id} v{node_version} as registry v{version}')
    await account.audit(
        info.userId,
        'deploy',
        'node_add',
        request_data={'nodeId': node_id, 'version': version},
        org_id=org_id,
    )
    return conn.build_response(request, body={'artifact': entry, 'orgId': org_id})


# =============================================================================
# CONTROL — the rail for a published node: see it, pin it, find it
# =============================================================================
#
# Publishing leaves an inert version. These are the verbs that make one
# reachable, and they mirror the app control surface: targets are '@me',
# '@team/<name-or-id>' and '@public'. There is no org rung — org is the
# governance container, and org-wide distribution is a team an org admin
# maintains.


def _node_rail_entry(entry: Dict[str, Any], artifact: Dict[str, Any] | None) -> Dict[str, Any]:
    """One row of a node's version rail: registry facts plus the node's own version."""
    who = entry.get('publishedBy') or {}
    return {
        'registryVersion': entry.get('version'),
        'nodeVersion': (artifact or {}).get('nodeVersion') or '',
        'runtime': (artifact or {}).get('runtime') or RUNTIME_PYTHON,
        'state': entry.get('state') or '',
        'sha256': entry.get('sha256', ''),
        'publishedAt': entry.get('publishedAt'),
        'author': who.get('display') or who.get('email') or who.get('userId') or '',
        'message': entry.get('comment', ''),
    }


async def handle_node_deploy(conn: Any, request: Dict[str, Any]) -> Dict[str, Any]:
    """Handle ``rrext_deploy_node`` — node publish control on the registry.

    Subcommands:

    - ``versions`` — the version rail for one node, newest first, with the
      audiences currently pinned to each.
    - ``deploy``   — pin an audience to a registry version. First release,
      update, and rollback are all this one verb; pinning is what makes a
      published version reachable at all.
    - ``where``    — the reverse index: which audience holds which version.

    Requires an authenticated connection; the org comes from the session.
    """
    from ai.account import account

    info = getattr(conn, '_account_info', None)
    if not info or not getattr(info, 'userId', None):
        return conn.build_error(request, 'rrext_deploy_node requires an authenticated connection')

    args = request.get('arguments', {}) or {}
    sub = str(args.get('subcommand') or '')
    node_id = str(args.get('nodeId') or '')
    if not node_id:
        return conn.build_error(request, 'nodeId is required')
    org_id = _org_of(conn)

    if sub == 'versions':
        entries = await account.deployments_versions(org_id, node_id)
        rail: List[Dict[str, Any]] = []
        for entry in sorted(entries or [], key=lambda e: -int(e.get('version', 0))):
            artifact = await account.deployments_artifact(org_id, node_id, int(entry.get('version', 0)))
            rail.append(_node_rail_entry(entry, artifact))
        return conn.build_response(request, body={'versions': rail})

    if sub == 'deploy':
        version = args.get('version')
        # The registry version, not the node's own semver: two published
        # versions can carry the same nodeVersion, and only one is this row.
        if not isinstance(version, int):
            return conn.build_error(request, 'version (the registry version number) is required')
        try:
            from ai.account.app_deploy import _resolve_target

            audience = _resolve_target(conn, str(args.get('target') or '@me'))
        except ValueError as exc:
            return conn.build_error(request, str(exc))
        record = await account.deployments_deploy(org_id, audience['id'], node_id, version, _actor_of(conn))
        debug(f'[node_deploy] pinned {node_id} v{version} to {audience.get("type")}:{audience.get("id")}')
        return conn.build_response(request, body={'deployment': record, 'audience': audience})

    if sub == 'where':
        deployments = await account.deployments_list(org_id, '')
        pins = [
            {'audience': dep.get('teamId') or dep.get('team_id') or '', 'version': dep.get('version')}
            for dep in deployments or []
            if (dep.get('projectId') or dep.get('project_id')) == node_id
        ]
        return conn.build_response(request, body={'pins': pins})

    return conn.build_error(request, f'Unknown subcommand: {sub!r}')
