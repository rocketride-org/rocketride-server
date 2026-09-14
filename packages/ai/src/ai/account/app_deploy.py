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
App deployments — the app publish ladder on the deployments registry (kind:'app').

Apps ride the SAME teams-as-environments registry pipelines use
(deployment_backend: immutable versioned artifacts recorded in the org
registry), with two adaptations:

- The ARTIFACT is a small ``kind:'app'`` JSON record — app id, moduleId,
  display name, semver, and ``metadata.manifest`` (the full appManifest). The
  app's SOURCE is uploaded as a zip, retained at
  ``.deployments/<app_id>/v<N>-<sha8>/bundle/`` and unpacked into
  ``.../source/``; the BUILD WORKER (app_build) compiles it into the
  servable ``.../dist/`` tree, and ``metadata.build`` tracks that
  lifecycle (queued -> building -> ok | failed). A version serves, submits,
  or publishes only once its build is ok.
- The REVIEW STATE lives on the DEPLOYMENT (``deployment_artifacts.state``:
  private → submit → ready | rejected). An app is born ``private`` (internally
  publishable); the developer submits it for review; admin approval to
  ``ready`` gates the public store track. A publish binding is a pure pointer.

Audiences: ``@me`` (a user), ``@team``, and ``@public``. An @me/@team binding
serves any non-``failed`` deployment; a @public binding serves only a ``ready``
deployment. Every app id is ``<developerId>.<name>`` and an org may deploy or
publish ONLY within its own developer namespace (the anti-impersonation
guarantee).

Verbs: uploading is the generic ``rrext_deploy add`` verb (kind-dispatched;
``handle_app_add`` here is its app branch — zip transport, unpacked at
receipt). The ``rrext_deploy_app`` command carries the audience/publish
concerns: ``versions`` (the rail + the caller's rungs), ``submit`` (flip the
deployment private → submit for review), ``withdraw`` (the developer's own
cancel: submit → private), ``publish`` (bind @me/@team/@public —
update, promote, and rollback are all this one pointer move), ``where`` (the
reverse index), and ``disable``/``remove`` (binding lifecycle). SERVING is
not a verb: versions load from stable ``/apps/<appId>/v<N>/`` URLs
(entitlement enforced per request by the shell route via
``entitled_version_dirs``); the retired ``entry`` verb's minted bundle URLs
are gone.

Shared platform infrastructure: works on the OSS local engine (single implicit
org/user 'local') and SaaS alike — no marketplace dependency.
"""

import hashlib
import time
from typing import Any, Dict, List, Optional

from rocketlib import debug

from ai.account.deployment_backend import DEFAULT_REVIEW_STATE, artifact_content_dir


def build_of(entry: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    """One registry entry's ``metadata.build`` blob ({} when never stamped)."""
    metadata = (entry or {}).get('metadata')
    metadata = metadata if isinstance(metadata, dict) else {}
    build = metadata.get('build')
    return build if isinstance(build, dict) else {}


def _is_built(entry: Optional[Dict[str, Any]]) -> bool:
    """Whether a version's servable bytes exist (THE built gate).

    True only for a completed build (``metadata.build.status == 'ok'``,
    stamped by the build worker and by the seeder — one gate, no legacy
    arms). A version with no ok build has an EMPTY ``dist/``, so serving,
    submit, and publish all gate on this.
    """
    return build_of(entry).get('status') == 'ok'


def _not_built_error(app_id: str, version: int, entry: Optional[Dict[str, Any]]) -> str:
    """The reasoned message for a gate refusing an unbuilt version."""
    status = str(build_of(entry).get('status') or '')
    if status in ('queued', 'building'):
        return f'Version {version} of {app_id} is still building — wait for the build to finish'
    if status == 'failed':
        return f'Version {version} of {app_id} failed its server build — fix the source and deploy a new version'
    return f'Version {version} of {app_id} has no server build — it cannot serve'


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


def _enrich_audience(conn: Any, audience: Dict[str, str]) -> Dict[str, str]:
    """Stamps display facts onto a resolved audience dict.

    deployment_history rows are rendered without a second lookup, so the
    audience that reaches the backends — and is stored verbatim into each
    row's data — carries the dereferenced display name and wire handle
    beside the raw id. The id stays the storage key (audience keys ignore
    the extra fields); the display keys are additive payload, resolved
    HERE because only the session holds the team-name map.
    """
    out = dict(audience)
    out['handle'] = _audience_handle(conn, audience)
    if audience['type'] == 'user':
        out['name'] = _actor_of(conn)['display']
    elif audience['type'] == 'team':
        tid = audience.get('id', '')
        out['name'] = next((ref for ref, t in _team_ids_of(conn).items() if t == tid and ref != tid), tid)
    else:
        out['name'] = ''
    return out


def _resolve_target(conn: Any, target: str) -> Dict[str, str]:
    """
    Resolves a wire target ('@me' | '@team/<name-or-id>' | '@public') to
    an audience dict ({'type', 'id'} plus the 'name'/'handle' display facts
    every history row must carry). '@user' is a legacy alias for '@me',
    accepted on input, never displayed.

    The org rung does not exist: org = the governance container; "org-wide"
    distribution is an org-admin-maintained team. @public requires the
    caller's org to hold a registered developer id (SaaS store track).

    Raises:
        ValueError: Unknown/malformed target, a team the caller is not in,
                    or @public without a registered developer org.
    """
    user_id = conn._account_info.userId
    if target in ('@user', '@me'):
        return _enrich_audience(conn, {'type': 'user', 'id': user_id})
    if target == '@public':
        org = getattr(conn._account_info, 'organization', None)
        developer_id = (
            (org.get('developerId') if isinstance(org, dict) else getattr(org, 'developerId', None)) if org else None
        )
        if not developer_id:
            raise ValueError('Public publishing requires the organization to be registered as a developer')
        return _enrich_audience(conn, {'type': 'public', 'id': ''})
    if target == '@org':
        raise ValueError(
            'The org audience does not exist — publish to a team instead '
            '(an org-admin-maintained "All members" team covers org-wide distribution)'
        )
    if target.startswith('@team/'):
        ref = target[len('@team/') :]
        teams = _team_ids_of(conn)
        if ref not in teams:
            raise ValueError(f'Unknown team: {ref!r} (you are not a member, or it does not exist)')
        return _enrich_audience(conn, {'type': 'team', 'id': teams[ref]})
    raise ValueError(f'Unknown publish target: {target!r} (use @me, @team/<name>, or @public)')


def _audiences_of(conn: Any) -> List[Dict[str, str]]:
    """The caller's scope-walk audiences: public, member teams, self."""
    user_id = conn._account_info.userId
    audiences: List[Dict[str, str]] = [{'type': 'public', 'id': ''}]
    audiences += [{'type': 'team', 'id': tid} for tid in sorted(set(_team_ids_of(conn).values()))]
    if user_id:
        audiences.append({'type': 'user', 'id': user_id})
    return audiences


async def _visible_rows_of(conn: Any, account: Any, org_id: str, app_id: Optional[str] = None) -> List[Dict[str, Any]]:
    """The caller-visible publish rows (cross-org: public matches every org).

    Visibility is inherent in the audience walk — only the caller's own
    user row, rows of teams they belong to, and public rows can match.
    Optionally narrowed to one app id.
    """
    try:
        rows = await account.publish_list(org_id, 'app', _audiences_of(conn))
    except Exception as exc:
        debug(f'[app_deploy] publish_list failed: {exc}')
        return []
    if app_id is not None:
        rows = [r for r in rows if r.get('appId') == app_id]
    return rows


# Audience precedence for cross-publisher arbitration (most specific wins).
_RUNG_RANK = {'public': 0, 'team': 1, 'user': 2}


async def _home_org_of(conn: Any, account: Any, org_id: str, app_id: str) -> 'tuple[str, bool]':
    """(home_org, developer) — which org's rail owns this app for the caller.

    The caller's own org wins whenever its rail carries the app (the
    developer case). Otherwise the publisher org of a caller-visible
    publish row serves it (cross-org store apps — seeded platform apps for
    every non-platform caller); with multiple publishers of the same app
    id, the most specific audience wins, then the lowest org id for
    determinism. Falls back to the caller org so unknown apps error on
    their natural not-found paths.
    """
    try:
        entries = await account.deployments_versions(org_id, app_id)
    except Exception:
        entries = []
    if entries:
        return org_id, True
    rows = await _visible_rows_of(conn, account, org_id, app_id)
    if rows:
        rows.sort(
            key=lambda r: (-_RUNG_RANK.get((r.get('audience') or {}).get('type', ''), 0), str(r.get('orgId') or ''))
        )
        return str(rows[0].get('orgId') or org_id), False
    return org_id, True


def _developer_id_of(conn: Any) -> Optional[str]:
    """The caller org's registered developer-id slug, or None."""
    org = getattr(conn._account_info, 'organization', None)
    if isinstance(org, dict):
        return org.get('developerId')
    return getattr(org, 'developerId', None)


def _assert_owns_namespace(conn: Any, app_id: str) -> None:
    """GUARANTEE the app id lives in the caller org's developer namespace.

    Every org is issued a globally-unique developer-id slug (e.g.
    ``rocketride``) and every app it ships is named ``<developerId>.<name>``
    (or the bare slug). Because the slug is unique, this partitions the app-id
    keyspace by org: an org can only create/publish ids inside its OWN
    partition, so two orgs can never contend for — or impersonate — an id.
    The platform org holds ``rocketride``, so ``rocketride.*`` is reachable
    by nobody else.

    An org with no developer-id owns no namespace and cannot publish apps
    until an org admin claims one (rrext_app developer_register).

    Raises:
        ValueError: no developer-id, or app_id outside the owned namespace.
    """
    dev = _developer_id_of(conn)
    if not dev:
        raise ValueError(
            'Publishing an app requires a registered developer id — an org admin must '
            'claim one (rrext_app developer_register) before apps can be deployed or published'
        )
    if app_id != dev and not app_id.startswith(f'{dev}.'):
        raise ValueError(
            f'App id {app_id!r} is outside your developer namespace — it must be {dev!r} '
            f'or start with {dev + "."!r} (apps are namespaced by your developer id, guaranteed unique)'
        )


# =============================================================================
# DAP HANDLER
# =============================================================================


async def handle_app_add(conn: Any, request: Dict[str, Any]) -> Dict[str, Any]:
    """
    The app branch of the generic ``rrext_deploy add`` verb: DEPLOY an app.

    Receives ONE zip via the binary ``arguments.data`` frame. The zip carries
    the app's SOURCE (the server owns the build — client-produced binaries
    are never trusted): it is retained at ``<artifact sibling dir>/bundle/``
    for provenance and unpacked immediately into ``.../v<N>/source/``. The
    BUILD WORKER (app_build) is enqueued on success and compiles the source
    into ``.../v<N>/dist/`` — entry minting points there, so a version
    serves only once the server has built it. The response returns
    immediately with ``buildStatus: 'queued'``; progress rides the deploy
    event stream and the versions rows.

    Two zip layouts, told apart by ``metadata.appRoot``:

    - Absent: legacy app-at-root — package.json at the zip root.
    - Present: WORKSPACE-RELATIVE — the packer roots the zip at the app's
      workspace folder so ``appManifest.include`` extras (a shared source
      dir, a local lib) ride at their real positions and relative
      references between them survive unpacking verbatim. ``appRoot``
      names the app folder inside the tree; the manifest is read from
      ``<appRoot>/package.json`` and the build worker roots there.

    The appManifest read from the packed package.json becomes
    ``metadata.manifest`` (the listing truth); the optional client-side
    ``.rrapp`` projectId rides as metadata.projectId, and appRoot itself
    persists with the caller metadata for the build worker.

    Governance: any authenticated org member may deploy (org-open rail).
    The app deployment is born state='private' — internally publishable (an
    @me/@team binding may serve it); the developer submits it for review, and
    admin approval to 'ready' gates the public store track. Deploying also
    WITHDRAWS every prior version still in 'submit' (→ 'private', history
    'withdrawn') — the review queue only ever holds current work.
    """
    from ai.account import account

    info = getattr(conn, '_account_info', None)
    if not info or not getattr(info, 'userId', None):
        return conn.build_error(request, 'deploying an app requires an authenticated connection')

    args = request.get('arguments', {}) or {}
    org_id = _org_of(conn)
    comment = str(args.get('comment', '') or '')
    data = args.get('data')
    if not data:
        return conn.build_error(request, 'data (the app source zip) is required')
    # data MUST be a binary frame — a str (or anything non-bytes-like) makes
    # io.BytesIO / bytes() raise TypeError, which escapes as an unhandled 500
    # instead of a clean DAP error. Normalise bytes-like inputs, reject the rest.
    if isinstance(data, (bytearray, memoryview)):
        data = bytes(data)
    elif not isinstance(data, bytes):
        return conn.build_error(request, 'data must be a binary zip frame (bytes), not text')
    # The upload cap, measured on the ZIPPED byte count and refused before
    # any parsing or decompression — a legitimate source pack is far smaller
    # (dist/, node_modules, and .git never pack). The unpacked-size and
    # file-count guards below still apply: a small zip can inflate large.
    if len(data) > _ZIP_MAX_ZIPPED:
        return conn.build_error(
            request,
            f'app source zip is {len(data) // (1024 * 1024)} MB — the upload cap is '
            f'{_ZIP_MAX_ZIPPED // (1024 * 1024)} MB zipped; narrow appManifest.include '
            '(a shared source root, a build output, or large assets) and redeploy',
        )

    # ── Parse the zip in memory: manifest first, files after allocation ───
    import io
    import zipfile

    try:
        archive = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile:
        return conn.build_error(request, 'data is not a valid zip archive')
    # appRoot names the app folder inside a workspace-relative zip; its shape
    # is guarded like a zip entry (it becomes a path inside the source tree).
    caller_meta = args.get('metadata') if isinstance(args.get('metadata'), dict) else {}
    app_root = str(caller_meta.get('appRoot') or '')
    if app_root and (
        app_root.startswith('/')
        or app_root.endswith('/')
        or '\\' in app_root
        or ':' in app_root
        or '..' in app_root.split('/')
        or '.' in app_root.split('/')
    ):
        return conn.build_error(request, f'metadata.appRoot has an unsafe path: {app_root!r}')
    try:
        manifest, app_version = _manifest_of_zip(archive, app_root)
    except ValueError as exc:
        return conn.build_error(request, str(exc))
    app_id = str(manifest.get('id') or '')
    if not app_id:
        return conn.build_error(request, 'package.json appManifest.id is required')
    # Namespace ownership — fail fast before decompressing the archive: an org
    # may only deploy app ids inside its own developer namespace (the guarantee
    # is re-enforced at publish, which also covers the pipe-forge path).
    try:
        _assert_owns_namespace(conn, app_id)
    except ValueError as exc:
        return conn.build_error(request, str(exc))
    guard_error = _zip_guard(archive)
    if guard_error:
        return conn.build_error(request, guard_error)

    # ── Registry row first: version allocation names the content paths ────
    artifact = {
        'kind': 'app',
        'appId': app_id,
        'moduleId': str(manifest.get('moduleId') or app_id.replace('.', '_').replace('-', '_')),
        'name': str(manifest.get('name') or app_id),
        'appVersion': app_version,
        'bundleSha256': hashlib.sha256(data).hexdigest(),
    }
    # The build lifecycle is born 'queued' WITH the registry row — the rail
    # row IS the build job record, so a version can never exist without a
    # build status and the restart sweep can always find in-flight work.
    metadata = {
        **caller_meta,
        'manifest': manifest,
        'build': {'status': 'queued', 'queuedAt': time.time(), 'attempt': 0},
    }
    entry = await account.deployments_publish(
        org_id, app_id, artifact, _actor_of(conn), comment=comment, metadata=metadata
    )
    version = int(entry.get('version', 0))

    # ── Content: retained transport zip + the unpacked SOURCE tree ───────
    # source/ holds what the developer shipped; dist/ receives the server
    # build's output so source and servable bytes never mix. The
    # content home is the artifact's SIBLING directory — the registry JSON
    # path minus '.json', co-located under .deployments (the same ONE
    # convention the platform seeder uses for its bundle copies).
    # EVERYTHING goes through the Store interface — authority is carried by
    # the IDENTITY, not by which method was called: the internal identity
    # passes resolve_scope's internal branch (id references, system trees
    # included), the same pattern as the run-log writer.
    from ai.account.models import RequestContext
    from ai.account.store import Store

    fs = Store.file_store(RequestContext.internal('app-deploy'), client_id=info.userId)
    written: List[str] = []
    try:
        # Derive the home INSIDE the compensation scope: a backend that
        # returned no artifactPath must flip the row 'failed', not write to
        # a garbage root.
        content_root = artifact_content_dir(str(entry.get('artifactPath') or ''))
        org_prefix = f'orgs/{org_id}/files/'
        if not content_root.startswith(org_prefix):
            raise ValueError(f'registry entry carries no usable artifactPath ({content_root!r})')
        home = f'@/Org/={org_id}/{content_root[len(org_prefix) :]}'
        path = f'{home}/bundle/{app_id}-v{version:06d}.zip'
        # Record BEFORE the write (same rule as the source loop below): a
        # bundle write that fails partway still leaves bytes on disk, and
        # the compensation loop only deletes recorded paths.
        written.append(path)
        await fs.write(path, bytes(data))
        for item in archive.infolist():
            if item.is_dir():
                continue
            path = f'{home}/source/{item.filename}'
            # Record BEFORE the write: a write that fails PARTWAY (file created,
            # call then raised) still leaves bytes on disk, so cleanup must know
            # about a path that never returned success.
            written.append(path)
            await fs.write(path, archive.read(item))
    except Exception as exc:
        # Compensation: the registry row was allocated BEFORE the content
        # writes (version allocation names these paths), so a write failure
        # would otherwise strand an internally-publishable version with no
        # bytes behind it. Best-effort partial cleanup, then flip the row
        # to 'failed' — the rail already refuses to publish or serve that
        # state — and surface the real cause.
        for path in written:
            try:
                await fs.delete(path)
            except Exception:
                pass  # best-effort: the 'failed' state alone gates serving
        try:
            await account.set_artifact_state(org_id, app_id, version, 'failed', _actor_of(conn))
            # Teammates' rails show the dead version without a manual refresh.
            fail_server = getattr(conn, '_server', None)
            if fail_server is not None:
                from ai.modules.task.deploy_events import broadcast_review_state

                await broadcast_review_state(fail_server, org_id, app_id, version, 'failed')
        except Exception as flip_exc:
            debug(f'[app_deploy] could not flip {app_id} v{version} to failed: {flip_exc}')
        debug(f'[app_deploy] content write failed for {app_id} v{version}: {exc}')
        return conn.build_error(
            request, f'deploy failed while storing content (version {version} marked failed): {exc}'
        )

    # ── Deploying supersedes pending reviews ─────────────────────────────
    # Every OTHER version still sitting in 'submit' is WITHDRAWN (submit →
    # private, the legal edge; history records 'withdrawn'): a new deploy
    # makes older submissions stale by definition, and leaving them queued
    # spends admin review effort on code that has already been replaced.
    # Best-effort per row — the deploy itself already succeeded.
    try:
        rail = await account.deployments_versions(org_id, app_id)
    except Exception:
        rail = []
    for row in rail:
        row_version = int(row.get('version', 0))
        if row_version == version or str(row.get('state') or '') != 'submit':
            continue
        try:
            await account.set_artifact_state(org_id, app_id, row_version, 'private', _actor_of(conn))
            debug(f'[app_deploy] withdrew stale review of {app_id} v{row_version} (superseded by v{version})')
            # The stale version left the queue — reviewer badges drop it live.
            auto_server = getattr(conn, '_server', None)
            if auto_server is not None:
                from ai.modules.task.deploy_events import broadcast_review_state

                await broadcast_review_state(auto_server, org_id, app_id, row_version, 'private')
        except Exception as exc:
            debug(f'[app_deploy] could not withdraw {app_id} v{row_version}: {exc}')

    # ── Hand the version to the build worker ─────────────────────────────
    # First card-ticker word: the zip is on the server (the client's own
    # 'uploading' state hands over here); the worker ticks the rest. Sent
    # BEFORE the enqueue — the worker loop can resume on the next await, and
    # its 'preparing' tick must not reach the card ahead of 'uploaded'.
    server = getattr(conn, '_server', None)
    if server is not None:
        try:
            from ai.modules.task.deploy_events import broadcast_build_status

            await broadcast_build_status(server, org_id, app_id, version, 'uploaded')
        except Exception as exc:
            debug(f'[app_deploy] uploaded status broadcast failed: {exc}')
    # Deploy is THE build trigger (there is no developer-side manual kick):
    # the worker compiles source/ into dist/ asynchronously and stamps
    # metadata.build as it goes. Best-effort — a worker that is not running
    # (tests, minimal embeddings) leaves the row 'queued' for the restart
    # sweep to pick up.
    try:
        from ai.account.app_build import enqueue_build

        enqueue_build(getattr(conn, '_server', None), org_id, app_id, version)
    except Exception as exc:
        debug(f'[app_deploy] could not enqueue build for {app_id} v{version}: {exc}')

    debug(f'[app_deploy] deployed {app_id} v{artifact["appVersion"]} as registry v{version} (private, build queued)')
    # One generic response shape for every kind: rrext_deploy add -> {artifact}
    return conn.build_response(request, body={'artifact': _rail_entry(entry, artifact)})


def _manifest_of_zip(archive: Any, app_root: str = '') -> 'tuple[Dict[str, Any], str]':
    """The appManifest and app semver from the zip's packed package.json.

    ``app_root`` names the app folder inside a workspace-relative zip; when
    empty the zip is the legacy app-at-root layout and package.json sits at
    the zip root.

    Returns ``(manifest, version)``. package.json is the CONTROL-PLANE
    truth: the version is its top-level ``version`` field, full stop. The
    appManifest block is a PROJECTION for the store listing and the shell's
    boot-time loading — it is stored verbatim as metadata.manifest and is
    never consulted for control fields, so a stray ``appManifest.version``
    can never shadow the app's real semver.

    Raises:
        ValueError: package.json missing/unparseable or appManifest absent.
    """
    import json as _json

    pkg_path = f'{app_root}/package.json' if app_root else 'package.json'
    if pkg_path not in archive.namelist():
        raise ValueError(f'zip must contain {pkg_path} (the appManifest carrier)')
    # Bounded read: this runs BEFORE _zip_guard (manifest is needed for the
    # fail-fast namespace check), so a single highly-compressible package.json
    # would otherwise decompress fully into memory here — a small upload that
    # exhausts server RAM. package.json is legitimately a few KB; cap the read
    # and reject anything absurd. read(N+1) lets us detect overflow exactly.
    try:
        with archive.open(pkg_path) as handle:
            raw = handle.read(_ZIP_MAX_MANIFEST + 1)
    except Exception:
        raise ValueError(f'{pkg_path} could not be read')
    if len(raw) > _ZIP_MAX_MANIFEST:
        raise ValueError(f'{pkg_path} exceeds the {_ZIP_MAX_MANIFEST}-byte manifest cap')
    try:
        package = _json.loads(raw)
    except Exception:
        raise ValueError(f'{pkg_path} is not valid JSON')
    manifest = package.get('appManifest')
    if not isinstance(manifest, dict) or not manifest:
        raise ValueError('package.json has no appManifest block')
    return dict(manifest), str(package.get('version') or '')


# Zip guards: transport caps that stop hostile archives before extraction.
_ZIP_MAX_FILES = 2000
_ZIP_MAX_ZIPPED = 50 * 1024 * 1024  # 50 MB zipped — the upload cap, checked before parsing
_ZIP_MAX_UNPACKED = 100 * 1024 * 1024  # 100 MB unpacked
_ZIP_MAX_MANIFEST = 1 * 1024 * 1024  # 1 MB — package.json read before the guard runs


def _zip_guard(archive: Any) -> str:
    """Reject unsafe archives (traversal, bombs); '' when acceptable.

    The unpacked-size cap is measured on the ACTUAL decompressed bytes, not
    the central directory's declared ``file_size`` — that field is
    attacker-controlled, so a zip bomb can declare tiny sizes and still
    decompress to gigabytes. Each entry is streamed once here under the
    running budget so no registry row is written for a bomb; extraction
    downstream is then bounded by having passed this gate.
    """
    import zipfile

    names = archive.namelist()
    if len(names) > _ZIP_MAX_FILES:
        return f'zip contains too many files ({len(names)} > {_ZIP_MAX_FILES})'
    total = 0
    for item in archive.infolist():
        name = item.filename.replace('\\', '/')
        # Path traversal / absolute entries can escape the artifact tree
        if name.startswith('/') or '..' in name.split('/') or (len(name) > 1 and name[1] == ':'):
            return f'zip entry has an unsafe path: {item.filename!r}'
        if item.is_dir():
            continue
        # Decompress under the running cap — the declared size cannot be trusted.
        try:
            with archive.open(item) as handle:
                while True:
                    chunk = handle.read(1024 * 1024)
                    if not chunk:
                        break
                    total += len(chunk)
                    if total > _ZIP_MAX_UNPACKED:
                        return f'zip unpacks past the {_ZIP_MAX_UNPACKED}-byte limit'
        except (zipfile.BadZipFile, RuntimeError, OSError) as exc:
            # Corrupt or encrypted (encrypted entries raise RuntimeError on read)
            return f'zip entry {item.filename!r} could not be read: {exc}'
    return ''


# Review-thread messages are chat lines, not documents — cap the payload so
# a runaway client cannot balloon the history stream.
_REPLY_MAX_CHARS = 4000

# Response cap for the build_log verb — long logs serve their TAIL (the
# failure always lands at the end; the full file stays in the store).
_BUILD_LOG_MAX_CHARS = 256 * 1024


async def handle_deploy_app(conn: Any, request: Dict[str, Any]) -> Dict[str, Any]:
    """
    Handle the ``rrext_deploy_app`` command for both platform flavours.

    App-specific publish control: publish / versions / where / entry /
    submit / withdraw / reply / build_log / disable / remove. Uploading is
    NOT here — the generic ``rrext_deploy add`` verb is the one rail door
    for every kind. Requires an authenticated connection; org scoping
    comes from the session.

    CROSS-ORG: every subcommand first resolves the app's HOME org — the
    caller's own org when its rail carries the app (the developer case),
    else the publisher org of a caller-visible publish row (store apps;
    seeded platform apps live under the platform org, so this is the
    normal case for every desktop selector on them). Artifact loads,
    publish rows, and entry minting all target the home org; deploying to
    another org's rail stays impossible (the generic add verb is always
    caller-org).
    """
    from ai.account import account

    info = getattr(conn, '_account_info', None)
    if not info or not getattr(info, 'userId', None):
        return conn.build_error(request, 'rrext_deploy_app requires an authenticated connection')

    args = request.get('arguments', {}) or {}
    sub = args.get('subcommand', '')
    app_id = args.get('appId', '')
    if not app_id:
        return conn.build_error(request, 'appId is required')
    org_id = _org_of(conn)
    home, developer = await _home_org_of(conn, account, org_id, app_id)

    # ── versions — the rail, newest first, with audience chips ────────────
    if sub == 'versions':
        if developer:
            # The caller's own rail: the full version history.
            entries = await account.deployments_versions(home, app_id)
            rail: List[Dict[str, Any]] = []
            for entry in sorted(entries, key=lambda e: -int(e.get('version', 0))):
                artifact = await _artifact_of(account, home, app_id, entry)
                rail.append(_rail_entry(entry, artifact))
            # Audience chips: which audiences currently serve which version
            rows = await account.publish_of_app(home, 'app', app_id)
        else:
            # Another org's app: the publisher's rail is not the caller's to
            # browse — only versions serving on caller-visible rows appear
            # (exactly what the desktop version selector needs).
            rows = [r for r in await _visible_rows_of(conn, account, org_id, app_id) if r.get('orgId') == home]
            # Read the version list ONCE and index it — _registry_entry_of
            # re-reads the whole list per call, so looking each version up
            # through it was an O(N) full-metadata read per visible version.
            try:
                entries_by_version = {
                    int(e.get('version', 0)): e for e in await account.deployments_versions(home, app_id)
                }
            except Exception:
                entries_by_version = {}
            rail = []
            for version in sorted({int(r.get('version', 0)) for r in rows}, reverse=True):
                entry = entries_by_version.get(version)
                if entry is None:
                    continue
                artifact = await _artifact_of(account, home, app_id, entry)
                rail.append(_rail_entry(entry, artifact))
        by_version: Dict[int, List[str]] = {}
        for row in rows:
            by_version.setdefault(int(row.get('version', 0)), []).append(row['audience']['type'])
        for rail_row in rail:
            rail_row['rungs'] = by_version.get(int(rail_row['registryVersion']), [])
        return conn.build_response(request, body={'versions': rail})

    # ── publish — bind a deployment to an audience (repoint = promote/rollback)
    if sub == 'publish':
        version = args.get('version')
        target = args.get('target', '')
        if not isinstance(version, int):
            return conn.build_error(request, 'version (registry version number) is required')
        # Target validation failures answer as clean DAP errors on BOTH
        # flavours — the OSS path calls this handler directly, without the
        # SaaS wrapper's ValueError-to-error conversion around it.
        try:
            audience = _resolve_target(conn, target)
        except ValueError as exc:
            return conn.build_error(request, str(exc))
        # THE cross-org guarantee: publishing your OWN rail's app to ANY
        # audience requires the app id to be in your developer namespace.
        # This is the real chokepoint — it holds no matter how the artifact
        # reached your rail (the app-deploy door OR a forged kind:'app' via
        # the pipe path), and because developer ids are globally unique it
        # makes cross-org impersonation of an app id impossible. Pinning
        # ANOTHER org's store app to @user/@team is the version selector
        # (developer is False, home is that org) — a separate,
        # entitlement-checked path that keeps the owner's id, so it is
        # deliberately NOT gated here.
        if developer:
            try:
                _assert_owns_namespace(conn, app_id)
            except ValueError as exc:
                return conn.build_error(request, str(exc))
        elif audience['type'] == 'public':
            # A public row can only be created on your own rail; reaching here
            # with developer False means the app id belongs to another org.
            return conn.build_error(request, f'Only the developer organization can publish {app_id} to the store')
        # Version entitlement. A @user (personal) pin ALWAYS needs it — even
        # within your own developer org a personal pin requires personal reach
        # (you deployed the version, or it is already visible to you). A @team
        # pin needs the SAME entitlement ONLY when you do NOT own the app's
        # rail (developer=False — pinning ANOTHER org's store app via the
        # version selector): checking only @user let a member pin another org's
        # PRIVATE/in-review/rejected version to their own team and then mint its
        # bundle bytes. A @team pin of your OWN app is namespace-gated above and
        # needs no per-version check.
        needs_entitlement = audience['type'] == 'user' or (not developer and audience['type'] == 'team')
        if needs_entitlement:
            if not await _caller_entitled_to_version(conn, account, org_id, home, app_id, version):
                return conn.build_error(
                    request,
                    f'Not entitled to version {version} of {app_id} '
                    '(not published to any of your audiences, and you did not deploy it)',
                )
        entry = await _registry_entry_of(account, home, app_id, version)
        if entry is None:
            return conn.build_error(request, f'Version {version} of {app_id} not found')
        artifact = await _artifact_of(account, home, app_id, {'version': version})
        if not isinstance(artifact, dict) or artifact.get('kind') != 'app':
            return conn.build_error(request, f'Registry version {version} of {app_id} is not an app artifact')
        # DEPLOYMENT-state gate — the review state lives on the deployment, not
        # the binding. A PUBLIC binding may only point at an approved ('ready')
        # version (submit -> admin approve -> ready first). Internal (@me/@team)
        # bindings accept any internal-eligible version (anything but 'failed';
        # 'submit' is still in review but the developer can already run it on
        # their own team). The binding created here is a pure pointer.
        deploy_state = str(entry.get('state') or DEFAULT_REVIEW_STATE)
        if audience['type'] == 'public':
            if deploy_state != 'ready':
                return conn.build_error(
                    request,
                    f'Version {version} of {app_id} is not approved for the store yet '
                    f'(state {deploy_state!r}) — submit it for review and get it to "ready" first',
                )
        elif deploy_state == 'failed':
            return conn.build_error(request, f'Version {version} of {app_id} failed processing — not publishable')
        # BUILT gate — a binding must never point at a version whose dist/
        # does not exist yet (still building) or never will (build failed):
        # the pointer would mint URLs to an empty directory.
        if not _is_built(entry):
            return conn.build_error(request, _not_built_error(app_id, version, entry))

        row = await account.publish_set(
            home, 'app', app_id, audience, version, manifest_snapshot(entry, artifact), _actor_of(conn)
        )

        # Refresh the acting user's manifest (data + signal); other audience
        # members pick the row up on their next account rebuild/login.
        try:
            from ai.account.dev_overlay import push_refresh

            await push_refresh(conn._server, conn._account_info.userId, source='app-publish')
        except Exception as exc:
            debug(f'[app_deploy] refresh push failed: {exc}')

        return conn.build_response(request, body={'publish': row})

    # ── submit — flip THIS deployment into public review (private -> submit) ─
    # The "Submit app for review" button. Review state lives on the deployment;
    # the admin queue is deployments in 'submit'. Approve -> ready (a public
    # binding may then point at it); reject -> rejected.
    if sub == 'submit':
        version = args.get('version')
        if not isinstance(version, int):
            return conn.build_error(request, 'version (registry version number) is required')
        if not developer:
            return conn.build_error(request, f'Only the developer organization can submit {app_id} for review')
        try:
            _assert_owns_namespace(conn, app_id)
        except ValueError as exc:
            return conn.build_error(request, str(exc))
        artifact = await _artifact_of(account, home, app_id, {'version': version})
        if not isinstance(artifact, dict) or artifact.get('kind') != 'app':
            return conn.build_error(request, f'Registry version {version} of {app_id} is not an app artifact')
        # Latest-only review: submission is legal ONLY for the newest
        # non-'failed' version — review tracks current work (deploying
        # already withdraws stale submissions). Older code that should
        # ship is deployed again: new review = new version. Enforced HERE,
        # not just hidden in the UI, so the rule cannot drift.
        rail = await account.deployments_versions(home, app_id)
        newest = max((int(r.get('version', 0)) for r in rail if str(r.get('state') or '') != 'failed'), default=0)
        if newest == 0:
            # No non-failed version exists (empty rail or every row failed).
            # "newest is v0" would name a version that cannot exist — versions
            # are 1-based — so state the real condition instead.
            return conn.build_error(
                request,
                f'{app_id} has no deployable version to submit — deploy the app before submitting it for review',
            )
        if version != newest:
            return conn.build_error(
                request,
                f'v{version} is not the newest version of {app_id} (newest is v{newest}) — deploy that code again to submit it for review',
            )
        # BUILT gate — every review-queue entry must be a real, servable
        # candidate: nothing to review while the build runs, and approving
        # a version that can never serve would strand a broken 'ready'.
        submit_entry = await _registry_entry_of(account, home, app_id, version)
        if not _is_built(submit_entry):
            return conn.build_error(request, _not_built_error(app_id, version, submit_entry))
        try:
            updated = await account.set_artifact_state(home, app_id, version, 'submit', _actor_of(conn))
        except Exception as exc:
            return conn.build_error(request, str(exc))
        # Review-loop liveness: the org's rails invalidate and the typed
        # status event reaches developer surfaces + reviewer queues live.
        server = getattr(conn, '_server', None)
        if server is not None:
            try:
                from ai.modules.task.deploy_events import broadcast_review_state

                await broadcast_review_state(server, home, app_id, version, 'submit')
            except Exception as exc:
                debug(f'[app_deploy] submit status push failed: {exc}')
        return conn.build_response(request, body={'artifact': _rail_entry(updated, artifact)})

    # ── withdraw — cancel a pending review (submit -> private) ────────────
    # The developer's own cancel: the version leaves the admin queue and
    # returns to draft (internally publishable as before); history records
    # 'withdrawn'. Only 'submit' withdraws — terminal states never move.
    if sub == 'withdraw':
        version = args.get('version')
        if not isinstance(version, int):
            return conn.build_error(request, 'version (registry version number) is required')
        if not developer:
            return conn.build_error(request, f'Only the developer organization can withdraw {app_id} from review')
        try:
            _assert_owns_namespace(conn, app_id)
        except ValueError as exc:
            return conn.build_error(request, str(exc))
        artifact = await _artifact_of(account, home, app_id, {'version': version})
        if not isinstance(artifact, dict) or artifact.get('kind') != 'app':
            return conn.build_error(request, f'Registry version {version} of {app_id} is not an app artifact')
        entry = await _registry_entry_of(account, home, app_id, version)
        state = str((entry or {}).get('state') or 'unknown')
        if state != 'submit':
            return conn.build_error(request, f'v{version} of {app_id} is not in review (state {state!r})')
        try:
            updated = await account.set_artifact_state(home, app_id, version, 'private', _actor_of(conn))
        except Exception as exc:
            return conn.build_error(request, str(exc))
        # The version left the queue — reviewer badges drop it live.
        server = getattr(conn, '_server', None)
        if server is not None:
            try:
                from ai.modules.task.deploy_events import broadcast_review_state

                await broadcast_review_state(server, home, app_id, version, 'private')
            except Exception as exc:
                debug(f'[app_deploy] withdraw status push failed: {exc}')
        return conn.build_response(request, body={'artifact': _rail_entry(updated, artifact)})

    # ── reply — append a developer message to the review thread ───────────
    # The developer half of the review conversation: the message rides the
    # app's deployment_history as a 'reply' row (side 'developer'), the same
    # stream the admin verbs write to. A 'reply' liveness ping follows so
    # reviewer surfaces update without polling.
    if sub == 'reply':
        message = str(args.get('message') or '').strip()
        if not message:
            return conn.build_error(request, 'message is required')
        if len(message) > _REPLY_MAX_CHARS:
            return conn.build_error(request, f'message exceeds the {_REPLY_MAX_CHARS}-character limit')
        version = args.get('version')
        if version is not None and not isinstance(version, int):
            return conn.build_error(request, 'version must be a registry version integer when given')
        if not developer:
            return conn.build_error(
                request, f'Only the developer organization can reply on the review thread of {app_id}'
            )
        try:
            _assert_owns_namespace(conn, app_id)
        except ValueError as exc:
            return conn.build_error(request, str(exc))
        await account.deployments_history_append(
            home,
            app_id,
            'reply',
            _actor_of(conn),
            version=version,
            data={'side': 'developer', 'message': message},
        )
        # Reply liveness: the same walk the verdict pushes use, with status
        # 'reply' — cross-org reviewer surfaces (queue badges, the Feedback
        # thread list) re-pull on it; consumers toast only on explicit
        # 'ready'/'rejected'. Best-effort, never fails the reply.
        server = getattr(conn, '_server', None)
        if server is not None:
            try:
                from ai.modules.task.deploy_events import broadcast_review_state

                await broadcast_review_state(server, home, app_id, version, 'reply')
            except Exception as exc:
                debug(f'[app_deploy] reply status push failed: {exc}')
        return conn.build_response(request, body={'replied': True, 'appId': app_id})

    # ── build_log — one version's durable server build log ────────────────
    # The full output the build worker writes beside the version's artifacts
    # (metadata.build carries no error text) — the Deploy card's "failed"
    # badge opens this. Developer-org only: the log describes the org's own
    # source build.
    if sub == 'build_log':
        version = args.get('version')
        if not isinstance(version, int):
            return conn.build_error(request, 'version (registry version number) is required')
        if not developer:
            return conn.build_error(request, f'Only the developer organization can read the build log of {app_id}')
        entry = await _registry_entry_of(account, home, app_id, version)
        if entry is None:
            return conn.build_error(request, f'{app_id} has no registry version {version}')
        content_root = artifact_content_dir(str(entry.get('artifactPath') or ''))
        if not content_root:
            return conn.build_error(request, f'v{version} of {app_id} has no content home on the server')
        from ai.account.store import Store

        try:
            data = await Store.instance()._store.read_bytes(f'{content_root}/build.log')
        except Exception:
            # No log (legacy build, or the worker never ran) — an empty log
            # is a normal answer, not an error.
            return conn.build_response(request, body={'appId': app_id, 'version': version, 'log': ''})
        text = data.decode('utf-8', errors='replace')
        if len(text) > _BUILD_LOG_MAX_CHARS:
            text = f'... (showing the last {_BUILD_LOG_MAX_CHARS} characters)\n{text[-_BUILD_LOG_MAX_CHARS:]}'
        return conn.build_response(request, body={'appId': app_id, 'version': version, 'log': text})

    # ── where — the reverse index (audience → served version) ─────────────
    if sub == 'where':
        return conn.build_response(
            request, body={'pins': await _where_of(conn, account, org_id, home, developer, app_id)}
        )

    # ── disable / remove — flip one audience row's serving state ──────────
    if sub in ('disable', 'remove'):
        try:
            audience = _resolve_target(conn, args.get('target', ''))
        except ValueError as exc:
            return conn.build_error(request, str(exc))
        if audience['type'] == 'public' and not developer:
            return conn.build_error(request, f'Only the developer organization can manage the store row of {app_id}')
        state = 'disabled' if sub == 'disable' else 'removed'
        try:
            row = await account.publish_set_state(home, 'app', app_id, audience, state, _actor_of(conn))
        except Exception as exc:
            return conn.build_error(request, str(exc))
        return conn.build_response(request, body={'publish': row})

    # (The 'entry' verb is RETIRED: versioned serving replaced minted bundle
    # URLs — clients construct /apps/<appId>/v<N>/remoteEntry.js and the
    # serve route enforces entitlement per request.)
    return conn.build_error(request, f'Unknown subcommand: {sub!r}')


# =============================================================================
# HELPERS
# =============================================================================


def _rail_entry(entry: Dict[str, Any], artifact: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    """One version-rail row: registry facts + review state + build + semver."""
    who = entry.get('publishedBy') or {}
    build = build_of(entry)
    return {
        'registryVersion': entry.get('version'),
        'appVersion': (artifact or {}).get('appVersion') or '',
        'state': entry.get('state') or '',
        'sha256': entry.get('sha256', ''),
        'publishedAt': entry.get('publishedAt'),
        'author': who.get('display') or who.get('email') or who.get('userId') or '',
        'message': entry.get('comment', ''),
        # The build lifecycle (metadata.build) — the DEPLOY view's chips.
        # No error text rides the rail: detail lives in build.log, served
        # on demand by the build_log verb.
        'buildStatus': str(build.get('status') or ''),
        'buildPhase': str(build.get('phase') or ''),
        'buildEndedAt': build.get('endedAt'),
    }


async def _artifact_of(account: Any, org_id: str, app_id: str, entry: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """Reads one registry entry's app artifact (None on any failure)."""
    try:
        return await account.deployments_artifact(org_id, app_id, int(entry.get('version', 0)))
    except Exception:
        return None


async def _registry_entry_of(account: Any, org_id: str, app_id: str, version: int) -> Optional[Dict[str, Any]]:
    """One registry entry by version number, or None."""
    try:
        entries = await account.deployments_versions(org_id, app_id)
    except Exception:
        return None
    for entry in entries:
        if int(entry.get('version', 0)) == version:
            return entry
    return None


def manifest_snapshot(entry: Dict[str, Any], artifact: Dict[str, Any]) -> Dict[str, Any]:
    """The publish row's manifest snapshot, from the entry's metadata.

    metadata.manifest is the listing truth (zip deploys carry the full
    appManifest); artifact fields fill the gaps for legacy binary deploys.
    """
    metadata = entry.get('metadata') if isinstance(entry.get('metadata'), dict) else {}
    manifest = metadata.get('manifest') if isinstance(metadata.get('manifest'), dict) else {}
    return {
        'name': str(manifest.get('name') or artifact.get('name') or artifact.get('appId') or ''),
        'description': str(manifest.get('description') or ''),
        'iconPath': str(manifest.get('icon') or ''),
        'readmePath': str(manifest.get('readme') or ''),
        'categories': manifest.get('categories'),
        'mode': str(manifest.get('mode') or 'free'),
        'shells': manifest.get('shells'),
        'authenticated': bool(manifest.get('authenticated', True)),
        'configuration': manifest.get('contributes', {}).get('configuration')
        if isinstance(manifest.get('contributes'), dict)
        else manifest.get('configuration'),
        'requiredPermissions': manifest.get('requiredPermissions'),
        # Pre-auth listing visibility (apps.json 'public: false' built-ins
        # stay off the unauthenticated probe). Stored verbatim by the file
        # backend; the DB edition's fixed snapshot columns drop it — the
        # filter is an OSS probe concern.
        'public': manifest.get('public', True) is not False,
    }


def _audience_handle(conn: Any, audience: Dict[str, str]) -> str:
    """The display handle of one audience ('@me' | '@team/<name>' | '@public').

    Personal reads back as '@me' — the ONE personal spelling across the
    platform ('@user' is accepted on input for compatibility, never shown).
    """
    if audience['type'] == 'user':
        return '@me'
    if audience['type'] == 'public':
        return '@public'
    # Prefer the team's name spelling when the caller can see it
    for ref, tid in _team_ids_of(conn).items():
        if tid == audience.get('id') and ref != tid:
            return f'@team/{ref}'
    return f'@team/{audience.get("id", "")}'


async def _where_of(
    conn: Any, account: Any, org_id: str, home: str, developer: bool, app_id: str
) -> List[Dict[str, Any]]:
    """
    The caller-visible reverse index for one app: their own user binding,
    bindings of teams they belong to, and the public binding. A public
    binding is only shown to OTHER orgs once its deployment is 'ready' — the
    in-review states are the publisher's business. The pin's ``state`` is the
    bound DEPLOYMENT's review state ('private'/'submit'/'ready'/'rejected'),
    which is what the version selector renders. appVersion joins from the artifact.
    """
    rows = [r for r in await _visible_rows_of(conn, account, org_id, app_id) if r.get('orgId') == home]
    if not developer:
        rows = [
            r for r in rows if (r.get('audience') or {}).get('type') != 'public' or r.get('artifactState') == 'ready'
        ]

    pins: List[Dict[str, Any]] = []
    for row in rows:
        audience = row.get('audience') or {}
        artifact = await _artifact_of(account, home, app_id, {'version': row.get('version')})
        rung = 'personal' if audience.get('type') == 'user' else audience.get('type', '')
        pins.append(
            {
                'rung': rung,
                'handle': _audience_handle(conn, audience),
                'version': row.get('version'),
                'appVersion': (artifact or {}).get('appVersion') or '',
                'state': row.get('artifactState') or '',
                'deployedAt': row.get('publishedAt'),
            }
        )
    return pins


async def _caller_entitled_to_version(
    conn: Any, account: Any, org_id: str, home: str, app_id: str, version: int
) -> bool:
    """
    Whether the caller may receive a specific registry version's bundle.

    Entitled when a caller-visible binding of the HOME org serves that
    version (their user binding, a team they belong to, or the public
    binding whose deployment is 'ready' — cross-org store apps resolve
    exactly here), or when the caller deployed that registry version (the
    developer flow — a fresh version is published nowhere yet).
    """
    user_id = conn._account_info.userId
    rows = await _visible_rows_of(conn, account, org_id, app_id)
    for row in rows:
        if row.get('orgId') != home or int(row.get('version', -1)) != version:
            continue
        # A disabled/removed binding never entitles — mirror the resolve_app_pins
        # serving gate so a PULLED version can't still be minted, nor re-pinned
        # elsewhere to resurrect it past a disable.
        if row.get('state') != 'enabled':
            continue
        audience = row.get('audience') or {}
        if audience.get('type') in ('user', 'team'):
            # Visibility is inherent: only own-user and member-team rows match
            return True
        # Public bundles are reachable only once the deployment is approved.
        if audience.get('type') == 'public' and row.get('artifactState') == 'ready':
            return True
    # Deployer — the caller copied this version to the server
    entry = await _registry_entry_of(account, home, app_id, version)
    if entry is not None:
        who = entry.get('publishedBy') or {}
        return who.get('userId') == user_id
    return False


# =============================================================================
# MANIFEST RESOLUTION — the scope walk
# =============================================================================


async def resolve_app_pins(org_id: str, user_id: Optional[str], team_ids: List[str]) -> List[Dict[str, Any]]:
    """
    Resolves the caller's published apps via the scope walk over the binding
    rows: public first, then each team, then the user row — most specific
    WINS on id collisions (user > team > public; ties across publisher orgs
    break on the lowest org id). SERVING GATE (the review state lives on the
    DEPLOYMENT): a public binding serves only when its deployment is 'ready';
    an internal (team/user) binding serves any internal-eligible deployment
    (anything but 'failed'); a disabled/removed BINDING never serves. CROSS-ORG:
    public rows come from every org (seeded platform apps live under the
    platform org); each row's own publisher orgId drives the artifact load and
    entry minting. Returns manifest-shaped entries — public (store) entries
    carry appStatus 'free' / onDesktop False for the account layer to overlay
    with desktop membership and subscriptions; internal pins are on-desktop by
    definition. Pure additive input to the assembly — the dev overlay still
    overrides on top.
    """
    from ai.account import account

    audiences: List[Dict[str, str]] = [{'type': 'public', 'id': ''}]
    audiences += [{'type': 'team', 'id': tid} for tid in team_ids]
    if user_id:
        audiences.append({'type': 'user', 'id': user_id})
    try:
        rows = await account.publish_list(org_id, 'app', audiences)
    except Exception as exc:
        debug(f'[app_deploy] publish_list failed: {exc}')
        return []

    # Precedence: MORE-SPECIFIC audience wins by app id (user > team >
    # public); on a same-rung tie the LOWEST org id wins — the same rule
    # _home_org_of uses, so a stray duplicate public row can never let a
    # higher-UUID org displace a lower one (the seeded platform org, at the
    # minimum UUID, always holds its ids). Sort so the winner lands LAST and
    # the blind dict-overwrite below keeps it: rank ascending, org id
    # DESCENDING within a rank.
    rows.sort(key=lambda r: str(r.get('orgId') or ''), reverse=True)
    rows.sort(key=lambda r: _RUNG_RANK.get((r.get('audience') or {}).get('type', ''), 0))

    resolved: Dict[str, Dict[str, Any]] = {}
    for row in rows:
        # Binding must be live (publish_list already drops 'removed'; guard
        # 'disabled' too), and the DEPLOYMENT must be serveable for the rung:
        # public needs 'ready', internal needs anything but 'failed'.
        if row.get('state') != 'enabled':
            continue
        audience_type = (row.get('audience') or {}).get('type', '')
        deploy_state = row.get('artifactState') or ''
        if audience_type == 'public':
            if deploy_state != 'ready':
                continue
        elif deploy_state == 'failed':
            continue
        app_id = row.get('appId') or ''
        version = row.get('version')
        row_org = str(row.get('orgId') or org_id)
        if not app_id or not isinstance(version, int):
            continue
        try:
            artifact = await account.deployments_artifact(row_org, app_id, version)
        except Exception:
            continue
        if not isinstance(artifact, dict) or artifact.get('kind') != 'app':
            continue
        # BUILT gate — a pin serves only once the version's servable bytes
        # exist: a completed build (artifactBuild 'ok', stamped by the build
        # worker and the seeder alike, joined onto the row by both backends).
        # An unbuilt pin is silently skipped (the DEPLOY surfaces show the
        # build status; the desktop just doesn't serve it).
        if row.get('artifactBuild') != 'ok':
            continue
        snapshot = row.get('snapshot') or {}
        rung = 'personal' if audience_type == 'user' else audience_type
        mode = snapshot.get('mode') or 'free'
        # Internal-pin serving status. A public (store) entry gets its real
        # status from the account layer. An internal (@me/@team) pin serves
        # free UNLESS it is a cross-org PAID app (published by ANOTHER org): a
        # subscription app must NOT be served free just because someone pinned
        # it, so it safe-defaults to 'unsubscribed' and the SaaS account layer
        # upgrades it to 'subscribed' only with an active subscription. An
        # owner-org pin of its OWN paid app keeps 'deployed' — you do not
        # subscribe to your own app.
        if audience_type == 'public':
            app_status = 'free'
        elif mode == 'subscription' and row_org != org_id:
            app_status = 'unsubscribed'
        else:
            app_status = 'deployed'
        entry = {
            'id': app_id,
            'moduleId': artifact.get('moduleId') or app_id.replace('.', '_'),
            'name': snapshot.get('name') or artifact.get('name') or app_id,
            'description': snapshot.get('description') or '',
            'icon': snapshot.get('iconPath') or '',
            'readme': snapshot.get('readmePath') or '',
            'categories': snapshot.get('categories') or [],
            # NO entry URL — the wire carries the version NUMBER and clients
            # construct /apps/<appId>/v<N>/remoteEntry.js themselves. The dev
            # overlay is the one thing that adds an `entry` (a localhost dev
            # server is not constructible from a number).
            'version': artifact.get('appVersion', ''),
            'registryVersion': version,
            'mode': mode,
            'shells': snapshot.get('shells'),
            'authenticated': bool(snapshot.get('authenticated', True)),
            'requiredPermissions': snapshot.get('requiredPermissions') or [],
            'rung': rung,
            'public': audience_type == 'public',
            # Public (store) entries get their real status/desktop flags from
            # the account layer; internal pins carry the app_status computed
            # above (a paid cross-org pin safe-defaults to 'unsubscribed').
            'appStatus': app_status,
            'onDesktop': audience_type != 'public',
        }
        # Omitted (not None) when absent — a present None fails the client
        # AppManifestEntry dict validation.
        if snapshot.get('configuration'):
            entry['configuration'] = snapshot.get('configuration')
        resolved[app_id] = entry
    return list(resolved.values())


# =============================================================================
# VERSIONED SERVING — the /apps/<appId>/v<N>/ route's entitlement resolvers
# =============================================================================


def _dist_dir_of(artifact_path: str) -> str:
    """The servable dist tree of one registry entry (the build's output)."""
    return f'{artifact_content_dir(artifact_path)}/dist'


async def entitled_version_dirs(info: Optional[Any], app_id: str) -> Dict[int, str]:
    """Registry version -> store ``dist/`` dir the caller may FETCH (SaaS).

    The versioned serving route's request-time gate (cached by the shell
    with a HARD expiry). The rules mirror ``_caller_entitled_to_version``,
    evaluated over the whole version set at once:

    - An ENABLED caller-visible binding entitles its version — the
      caller's own user row, rows of teams they belong to, and public
      rows (public only when the deployment is 'ready').
    - The caller ORG's own rail entitles its built versions (the developer
      flow — the version picker lists the rail published or not, and any
      org member who can browse the DEPLOY rail can fetch its bytes; rail
      rows only ever exist inside the owning developer namespace).
    - The BUILT gate applies everywhere: an unbuilt version has no
      servable bytes.

    ``info`` None = anonymous: public rows only (the pre-auth landing).
    """
    from ai.account import account

    user_id = str(getattr(info, 'userId', '') or '') if info is not None else ''
    org = getattr(info, 'organization', None) if info is not None else None
    org_id = ''
    team_ids: List[str] = []
    if org is not None:
        org_id = str((org.get('id') if isinstance(org, dict) else getattr(org, 'id', '')) or '')
        teams = (org.get('teams') if isinstance(org, dict) else getattr(org, 'teams', None)) or []
        for team in teams:
            tid = team.get('id') if isinstance(team, dict) else getattr(team, 'id', None)
            if tid:
                team_ids.append(str(tid))

    audiences: List[Dict[str, str]] = [{'type': 'public', 'id': ''}]
    audiences += [{'type': 'team', 'id': tid} for tid in team_ids]
    if user_id:
        audiences.append({'type': 'user', 'id': user_id})

    dirs: Dict[int, str] = {}
    try:
        rows = await account.publish_list(org_id, 'app', audiences)
    except Exception as exc:
        debug(f'[app_deploy] entitled_version_dirs publish_list failed: {exc}')
        rows = []
    for row in rows:
        if row.get('appId') != app_id or row.get('state') != 'enabled':
            continue
        if (row.get('audience') or {}).get('type') == 'public' and row.get('artifactState') != 'ready':
            continue
        if row.get('artifactBuild') != 'ok':
            continue
        version = row.get('version')
        artifact_path = str(row.get('artifactPath') or '')
        if isinstance(version, int) and artifact_path:
            dirs[version] = _dist_dir_of(artifact_path)

    # Developer-org entitlement: the caller org's OWN rail (rail rows exist
    # only inside the owning developer namespace), built versions only —
    # published or not. Org-scoped, not deployer-scoped: the DEPLOY view
    # already shows every org member the whole rail, so serving parity
    # follows visibility parity.
    if user_id and org_id:
        try:
            entries = await account.deployments_versions(org_id, app_id)
        except Exception:
            entries = []
        for entry in entries:
            if _build_status_of_entry(entry) != 'ok':
                continue
            version = int(entry.get('version', 0))
            artifact_path = str(entry.get('artifactPath') or '')
            if version and artifact_path:
                dirs[version] = _dist_dir_of(artifact_path)
    return dirs


async def open_version_dirs(app_id: str) -> Dict[int, str]:
    """Registry version -> ``dist/`` dir, EVERY built version (OSS).

    OSS serving is OPEN (a localhost single-tenant server gains nothing
    from the gate — Rod's call), so the resolver is just "what exists and
    is built" on the single implicit 'local' org.
    """
    from ai.account import account

    dirs: Dict[int, str] = {}
    try:
        entries = await account.deployments_versions('local', app_id)
    except Exception:
        entries = []
    for entry in entries:
        if _build_status_of_entry(entry) != 'ok':
            continue
        version = int(entry.get('version', 0))
        artifact_path = str(entry.get('artifactPath') or '')
        if version and artifact_path:
            dirs[version] = _dist_dir_of(artifact_path)
    return dirs


def _build_status_of_entry(entry: Dict[str, Any]) -> str:
    """One registry entry's build status ('' when never stamped)."""
    return str(build_of(entry).get('status') or '')
