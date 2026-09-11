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
# SEED APPS — edition-neutral platform-app seeding
#
# apps.json is the SEED, not a runtime catalog. Each entry becomes ONE
# ordinary artifact-rail row (kind 'app', state 'ready' — platform apps are
# pre-approved — with the entry itself as metadata.manifest and the built
# bundle mirrored into the version's dist/ tree, the SAME layout and minted
# serving path server builds use) plus ONE public publish binding (a pure
# pointer). Once an app has rail rows, apps.json loses authority for it.
#
# Everything here runs through the account's UPPER-LEVEL deploy/publish
# functions (deployments_versions / deployments_publish / publish_get /
# publish_set), so the SAME code seeds the SaaS DB edition and the OSS
# meta-file edition — the storage difference lives inside the deployment
# backend. What differs per edition is the ORCHESTRATION around this module:
# SaaS runs it from the explicit pod-deploy tool (never at boot — pods must
# not race) and adds platform-org bootstrap + billing; OSS runs it from its
# init sequence with a version-march policy.
# =============================================================================

"""Edition-neutral seeding of the fixed platform apps from apps.json."""

import json
import os
import sys
import time
from typing import Any, Awaitable, Callable, Dict, List, Optional

from rocketlib import debug

# Display-semver FALLBACK for an apps.json entry that carries no version of
# its own — seeded rows normally show the app's real semver (the desktop
# card's version line), so the fallback only marks a manifest gap.
SEED_VERSION = '0'

# Registry comment stamped on every seeded version — the marker orchestrators
# use to tell seed rows from user deploys of the same app id.
SEED_COMMENT = 'Platform seed'

# System actor for seeded rows: no user FK (None), the display copy carries
# the identity in the audit trail.
SYSTEM_ACTOR = {'userId': None, 'display': 'Platform', 'email': ''}

# The public audience every seed binds to (the store rung).
PUBLIC_AUDIENCE = {'type': 'public', 'id': ''}


# =============================================================================
# MANIFEST DISCOVERY
# =============================================================================


def find_apps_json() -> str:
    """
    Locate apps.json on disk.

    Checks the server's static directory first (production layout:
    ``<engine_dir>/static/apps.json``), then falls back to the build
    directory used during development.

    Returns:
        Absolute path to apps.json.

    Raises:
        FileNotFoundError: If apps.json cannot be found in any known location.
    """
    # Production: static dir next to the engine executable
    engine_dir = os.path.dirname(sys.executable)
    candidates = [
        os.path.join(engine_dir, 'static', 'apps.json'),
        # Development: build output at repo root
        os.path.join(engine_dir, '..', '..', 'build', 'apps.json'),
    ]
    for path in candidates:
        if os.path.isfile(path):
            return os.path.abspath(path)
    raise FileNotFoundError(f'apps.json not found in any of: {candidates}')


def load_manifest_entries() -> List[Dict[str, Any]]:
    """
    Read apps.json and return its app entries.

    Returns:
        The manifest's app entry list ([] when the manifest is empty).

    Raises:
        FileNotFoundError: If apps.json cannot be found (broken build).
    """
    apps_json_path = find_apps_json()
    debug(f'[seed_apps] loading {apps_json_path}')
    with open(apps_json_path, 'r', encoding='utf-8') as f:
        data = json.load(f)
    return data.get('apps', [])


# =============================================================================
# THE PRIMITIVE — mint one seed version + copy its bundle
# =============================================================================


def seed_artifact_of(entry: Dict[str, Any]) -> Dict[str, Any]:
    """The kind='app' artifact record derived from one apps.json entry.

    Deliberately NO explicit ``entry``: seeded versions serve from their own
    ``dist/`` tree via constructed versioned URLs, exactly like server-built
    versions — one layout, one serving path, and every seeded VERSION serves
    its own bytes (the retired static-entry short-circuit always pointed at
    the CURRENT static tree, so older seeded versions served the wrong
    bundle). ``appVersion`` is the app's REAL semver from apps.json — the
    desktop card's version line — falling back to SEED_VERSION only when the
    manifest carries none.
    """
    app_id = str(entry['id'])
    return {
        'kind': 'app',
        'appId': app_id,
        'moduleId': str(entry.get('moduleId') or app_id.replace('.', '_')),
        'name': str(entry.get('name') or app_id),
        'appVersion': str(entry.get('version') or SEED_VERSION),
    }


async def copy_bundle_to_store(app_id: str, artifact_path: str) -> int:
    """Copy an app's built bundle from the local static tree INTO the file
    store, at the version's ``dist/`` serving tree.

    The registry JSON is ``.deployments/<app_id>/v<N>-<sha8>.json``; the
    bundle mirrors into ``.deployments/<app_id>/v<N>-<sha8>/dist/`` — the
    SAME subtree the server build worker writes, and the one entry minting
    serves. The subtree (never the content root) keeps the directory-scoped
    entry token from ever granting a deployed version's ``source/`` or
    ``bundle/``, and gives every seeded VERSION its own servable bytes.

    Source: ``<engine_dir>/static/apps/<app_id>/`` (what the app build
    emits). Best-effort per app: a missing local tree (apps not rebuilt) logs
    and returns 0 rather than aborting the seed — but with the static-entry
    short-circuit retired the caller treats 0 as "cannot serve". Returns the
    file count copied. Writes go through the raw store's ``write_bytes`` (a
    server-side bulk copy, not a user operation).
    """
    from ai.account.deployment_backend import artifact_content_dir
    from ai.account.store import Store

    local_root = os.path.join(os.path.dirname(sys.executable), 'static', 'apps', app_id)
    if not os.path.isdir(local_root):
        debug(f'[seed_apps] no local bundle at {local_root} — store copy skipped for {app_id} (rebuild the app)')
        return 0
    if not artifact_path:
        debug(f'[seed_apps] no artifactPath for {app_id} — store copy skipped')
        return 0

    # The version's dist/ tree under the content home (the one convention).
    dest_root = f'{artifact_content_dir(artifact_path)}/dist'
    store = Store.instance()._store
    count = 0
    # Walk the built tree and mirror every file into the dist/ serving tree.
    for dirpath, _dirs, files in os.walk(local_root):
        for filename in files:
            abs_path = os.path.join(dirpath, filename)
            rel = os.path.relpath(abs_path, local_root).replace(os.sep, '/')
            with open(abs_path, 'rb') as handle:
                data = handle.read()
            await store.write_bytes(f'{dest_root}/{rel}', data)
            count += 1
    debug(f'[seed_apps] copied {count} bundle file(s) for {app_id} -> {dest_root}')
    return count


async def seed_app(account: Any, org_id: str, entry: Dict[str, Any], actor: Dict[str, Any]) -> Dict[str, Any]:
    """
    Mint one apps.json entry as a fresh, pre-approved rail version.

    The PRIMITIVE: registers the seed artifact (born 'ready') as the next
    registry version and copies the built bundle into the store next to it.
    An EMPTY copy (no local bundle), or one that raises partway, re-stamps
    the row's build FAILED — an empty or half-written ``dist/`` must never
    pass the built gate, so callers withhold the binding and the self-heal
    path retries the copy on a later run. Binding
    the version to an audience is deliberately the CALLER's job — each
    edition records visibility its own way.

    Args:
        account: The active Account (either edition).
        org_id:  Owning org — the platform org on SaaS, 'local' on OSS.
        entry:   One apps.json app entry (the manifest truth for the seed).
        actor:   Audit actor for the registry rows.

    Returns:
        The new registry entry (version, sha256, artifactPath, ...) with
        ``metadata.build`` reflecting the copy outcome.
    """
    app_id = str(entry['id'])
    # The stored manifest carries NO entry URL: serving URLs are constructed
    # from version numbers everywhere, so recording apps.json's build-time
    # static path would only seed a dead field into every new row.
    manifest = {k: v for k, v in entry.items() if k != 'entry'}
    registered = await account.deployments_publish(
        org_id,
        app_id,
        seed_artifact_of(entry),
        actor,
        comment=SEED_COMMENT,
        # build.status 'ok': the seed's dist/ is populated by the copy below
        # from an already-built static tree, so seeded versions pass the SAME
        # built gate server builds do (no special-casing anywhere downstream).
        metadata={'manifest': manifest, 'build': {'status': 'ok', 'seeded': True, 'endedAt': time.time()}},
        state='ready',
    )
    try:
        copied = await copy_bundle_to_store(app_id, str(registered.get('artifactPath') or ''))
    except Exception as exc:
        # A copy that dies partway leaves a HALF-written dist/, which is as
        # unservable as an empty one — the row must never keep the 'ok' it was
        # published with. Stamp the build FAILED on the way out (same contract
        # as the empty-copy branch below) so the built gate refuses the row and
        # a later run's self-heal retries the copy, then re-raise.
        broken = {
            'status': 'failed',
            'seeded': True,
            'errors': [f'seed bundle copy failed: {exc}'],
            'endedAt': time.time(),
        }
        try:
            await account.deployments_set_build(org_id, app_id, int(registered.get('version', 0)), broken)
        except Exception as stamp_exc:
            debug(f'[seed_apps] {app_id}: failed-build stamp failed: {stamp_exc}')
        registered.setdefault('metadata', {})['build'] = broken
        raise
    if copied == 0:
        # With the static-entry short-circuit retired, the dist/ copy IS the
        # serving path — an empty copy means this seed cannot serve at all.
        # Re-stamp the build FAILED (visible on the DEPLOY rail) so the
        # built gate refuses it everywhere and the caller withholds the
        # binding; a later run's self-heal retries the copy once the built
        # tree exists.
        failed = {
            'status': 'failed',
            'seeded': True,
            'errors': ['seed bundle copy found no local files — rebuild the app'],
            'endedAt': time.time(),
        }
        try:
            await account.deployments_set_build(org_id, app_id, int(registered.get('version', 0)), failed)
        except Exception as exc:
            debug(f'[seed_apps] {app_id}: failed-build stamp failed: {exc}')
        registered.setdefault('metadata', {})['build'] = failed
        debug(f'[seed_apps] WARNING: {app_id} seeded with an EMPTY dist/ — binding withheld (rebuild the app)')
    return registered


def _build_ok(entry: Dict[str, Any]) -> bool:
    """Whether a registry row's build completed (``metadata.build.status`` ok)."""
    metadata = entry.get('metadata') if isinstance(entry.get('metadata'), dict) else {}
    build = metadata.get('build') if isinstance(metadata.get('build'), dict) else {}
    return str(build.get('status') or '') == 'ok'


# =============================================================================
# ONE ENTRY — presence check, self-heal, mint, bind
# =============================================================================


async def seed_manifest_app(
    account: Any,
    org_id: str,
    entry: Dict[str, Any],
    actor: Dict[str, Any],
    *,
    force: bool = False,
    repoint_latest: Optional[Callable[[str, int, int, Dict[str, Any]], Awaitable[None]]] = None,
) -> bool:
    """
    Register one apps.json entry: rail artifact + public publish binding.

    The INSERT-if-absent gate: an app whose rail already has rows is skipped
    unless ``force`` (the deliberate-update path — which appends a NEW
    version and repoints the public row; it never rewrites history).
    Edition extras (billing, org bootstrap) are the caller's responsibility.

    Args:
        entry:          One apps.json app entry (the manifest truth).
        force:          Append a new version even when rail rows exist.
        repoint_latest: Optional fleet-bump hook for ``force``: called with
                        (app_id, old_latest, new_version, snapshot) to
                        re-point every pin on the old latest. When None the
                        force path repoints only the public binding via
                        ``publish_set``.

    Returns:
        True when the app was (re)registered, False when skipped.

    Raises:
        RuntimeError: When the presence lookup fails — a transient error must
            not read as an empty rail (it would append a duplicate version).
    """
    from ai.account.app_deploy import manifest_snapshot

    app_id = str(entry['id'])
    artifact = seed_artifact_of(entry)

    # Step 1: decide what to do with an app that already has rail rows.
    try:
        existing = await account.deployments_versions(org_id, app_id)
    except Exception as exc:
        raise RuntimeError(f'{app_id}: version lookup failed — refusing to seed') from exc
    old_latest: Optional[int] = None
    if existing and force:
        # Deliberate update: roll a NEW version below, then re-point pins on
        # the CURRENT latest -> the new version (append-only — prior
        # artifacts and pins deliberately held on OLDER versions stay put).
        old_latest = max(int(v.get('version', 0)) for v in existing)
    elif existing:
        # Self-heal (no force): the INSERT-if-absent gate keys on the
        # ARTIFACT, but the public BINDING is a SEPARATE row — an install
        # with the artifact but no pointer strands the app off the store.
        # Backfill just the binding rather than skip.
        pub = await account.publish_get(org_id, 'app', app_id, PUBLIC_AUDIENCE)
        if pub is not None:
            return False  # fully seeded, nothing to do.
        # Point the public audience at the latest ready AND BUILT version —
        # binding an unbuilt row would expose a version with no servable
        # bytes (seeds are born 'ready'; deployments_versions is
        # newest-first). A ready seed row whose earlier bundle copy failed
        # gets the copy RETRIED here (idempotent — the dist path derives
        # from the row's artifactPath), so a rebuilt tree heals on the next
        # run without minting runaway versions.
        ready = [v for v in existing if v.get('state') == 'ready'] or existing
        target = next((row for row in ready if _build_ok(row)), None)
        if target is None:
            for row in ready:
                # Newest SEED row only — user deploys are the worker's job.
                if str(row.get('comment') or '') != SEED_COMMENT:
                    continue
                try:
                    if await copy_bundle_to_store(app_id, str(row.get('artifactPath') or '')) > 0:
                        stamp = {'status': 'ok', 'seeded': True, 'endedAt': time.time()}
                        await account.deployments_set_build(org_id, app_id, int(row.get('version', 0)), stamp)
                        row.setdefault('metadata', {})['build'] = stamp
                        target = row
                except Exception as exc:
                    debug(f'[seed_apps] {app_id}: bundle-copy retry failed: {exc}')
                break
        if target is None:
            debug(f'[seed_apps] {app_id}: no BUILT ready version — public binding withheld (rebuild the app)')
            return False
        version = int(target.get('version', 1))
        await account.publish_set(
            org_id, 'app', app_id, PUBLIC_AUDIENCE, version, manifest_snapshot(target, artifact), actor
        )
        debug(f'[seed_apps] backfilled missing public binding for {app_id} v{version}')
        return True

    # Step 2: mint the seed version + copy its bundle (the primitive).
    registered = await seed_app(account, org_id, entry, actor)
    version = int(registered.get('version', 1))
    # The primitive stamps the build FAILED when the copy found no bundle —
    # never bind (or fleet-repoint!) an empty version: the pointer would
    # serve nothing, and a fleet bump would walk EVERY pin onto it. The
    # self-heal path above retries the copy on the next run.
    if not _build_ok(registered):
        return False
    snapshot = manifest_snapshot(registered, artifact)

    # Step 3: bind the public audience. The deployment was registered 'ready'
    # above (platform apps are pre-approved), so the binding legitimately
    # serves it.
    if force and old_latest is not None and repoint_latest is not None:
        # Fleet bump: the edition hook re-points every pin on the OLD latest
        # (public AND any team/user pins) to this fresh version in one pass.
        await repoint_latest(app_id, old_latest, version, snapshot)
    else:
        await account.publish_set(org_id, 'app', app_id, PUBLIC_AUDIENCE, version, snapshot, actor)
    return True


# =============================================================================
# THE WALK — shared loop over apps.json
# =============================================================================


async def seed_apps_from_manifest(
    account: Any,
    org_id: str,
    actor: Dict[str, Any],
    *,
    force: bool = False,
    seed_entry: Optional[Callable[[Dict[str, Any], bool], Awaitable[bool]]] = None,
) -> Dict[str, Any]:
    """
    Walk apps.json and register every absent platform app.

    Idempotent by default: an app already on the rail with its public
    binding is a no-op; an artifact missing its binding is self-healed.
    ``seed_entry`` lets an edition wrap the per-entry step (SaaS adds
    billing); it defaults to ``seed_manifest_app``.

    Returns:
        ``{total, seeded, skipped, failed}`` counts (plus ``error`` when the
        manifest itself is missing — a broken build must not read as a clean
        all-zero seed).
    """
    try:
        entries = load_manifest_entries()
    except FileNotFoundError as exc:
        debug(f'[seed_apps] skipping: {exc}')
        return {'total': 0, 'seeded': 0, 'skipped': 0, 'failed': 0, 'error': str(exc)}
    if not entries:
        debug('[seed_apps] apps.json is empty — nothing to seed')
        return {'total': 0, 'seeded': 0, 'skipped': 0, 'failed': 0}

    async def default_entry(entry: Dict[str, Any], entry_force: bool) -> bool:
        return await seed_manifest_app(account, org_id, entry, actor, force=entry_force)

    step = seed_entry or default_entry
    seeded = 0
    skipped = 0
    failed = 0
    for entry in entries:
        try:
            if await step(entry, force):
                seeded += 1
            else:
                skipped += 1
        except Exception as exc:
            failed += 1
            debug(f'[seed_apps] FAILED to seed {entry.get("id", "?")}: {exc}')
            # A failed app is an operator-visible error — print the full
            # failure to stderr where the operator is looking.
            print(f'seed FAILED: {entry.get("id", "?")}: {exc}', file=sys.stderr)
            import traceback

            traceback.print_exc(file=sys.stderr)

    debug(f'[seed_apps] seeded {seeded} app(s), {skipped} already on the rail, {failed} failed')
    return {'total': len(entries), 'seeded': seeded, 'skipped': skipped, 'failed': failed}
