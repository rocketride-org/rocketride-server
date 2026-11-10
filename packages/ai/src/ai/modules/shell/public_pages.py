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
Public pages: the page map of the app origin and the gate that guards it.

The aggregate is one immutable map of the public pages that published platform
apps declare in their manifests (the contract is ``contract.py``): what the
pages are lives in the owning app's manifest, not in the engine. It is built
at startup, rebuilt in the background on every platform app's publish,
unpublish or rung repoint, and kept as it was when the store cannot be read.
Until a published manifest contributes a valid page, it holds the legacy page
list (``legacy_manifest.py``).

The publish gate (``gate_errors``) refuses a public publish whose page claims
are invalid. The aggregate re-checks every manifest anyway: seeded platform
rows never pass the gate.
"""

import asyncio
import json
from dataclasses import dataclass, field, replace
from typing import Any, Callable, Dict, List, Mapping, Optional, Set, Tuple

from rocketlib import debug, warning

from ai.account.app_rows import (
    dist_dir_of,
    holds_required_permissions,
    manifest_of,
    precedence_sorted,
    serving_block_of,
)

from .contract import Page, check_manifest, is_privileged, may_claim_root


@dataclass(frozen=True)
class Published:
    """One production-rung (public) app version's manifest, as the loader read it."""

    app_id: str
    manifest: Mapping[str, Any]
    dist_dir: str = ''
    published_at: Optional[float] = None


@dataclass(frozen=True)
class Aggregate:
    """The immutable page map, keyed by exact path. A rebuild swaps a whole new one (never edited).

    ``published`` maps each app owning a page to the manifest it was read
    from: what a rebuild keeps when that app cannot be read. Comparisons
    ignore it.
    """

    exact: Mapping[str, Page]
    site: Mapping[str, Any] = field(default_factory=dict)
    published: Mapping[str, Published] = field(default_factory=dict, compare=False, repr=False)
    legacy: bool = False

    def pages(self) -> List[Page]:
        """Every claimed page, sorted by path (deterministic output order)."""
        return sorted(self.exact.values(), key=lambda p: p.path)


def _claim_order(published: List[Published]) -> List[Published]:
    """First claim wins: the earlier production binding, then app id (deterministic)."""
    return sorted(published, key=lambda p: (p.published_at if p.published_at is not None else float('inf'), p.app_id))


def _claims(
    published: List[Published], live_conflict: Optional[Callable[[str], Optional[str]]] = None
) -> Tuple[Dict[str, Page], Dict[str, Dict[str, Any]]]:
    """``(exact, sites)`` of the valid, non-colliding claims, first claim winning."""
    exact: Dict[str, Page] = {}
    sites: Dict[str, Dict[str, Any]] = {}
    for pub in _claim_order(published):
        pages, site, errors = check_manifest(pub.app_id, pub.manifest, live_conflict)
        for err in errors:
            warning(f'[public_pages] {pub.app_id}: {err} (page skipped)')
        for page in pages:
            owner = exact.get(page.path)
            if owner is not None:
                warning(f'[public_pages] {pub.app_id}: {page.path} already claimed by {owner.app_id} (page skipped)')
                continue
            exact[page.path] = replace(page, dist_dir=pub.dist_dir, published_at=pub.published_at)
        if site is not None:
            sites[pub.app_id] = site
    return exact, sites


def build_aggregate(
    published: List[Published], live_conflict: Optional[Callable[[str], Optional[str]]] = None
) -> Aggregate:
    """Build the aggregate from published manifests (pure; no I/O).

    Every manifest is re-validated (``check_manifest``) and only its valid
    pages are kept; a page colliding with an earlier claim is dropped (first
    claim wins). ``site`` comes only from the app owning ``/``. When no page
    survives, the aggregate is the legacy page list (a broken manifest falls
    back instead of removing every page).
    """
    exact, sites = _claims(published, live_conflict)
    if not exact:
        return legacy_aggregate(live_conflict)
    root = exact.get('/')
    owners = {page.app_id for page in exact.values()}
    return Aggregate(
        exact=exact,
        site=dict(sites.get(root.app_id, {})) if root is not None else {},
        published={pub.app_id: pub for pub in published if pub.app_id in owners},
    )


def legacy_aggregate(live_conflict: Optional[Callable[[str], Optional[str]]] = None) -> Aggregate:
    """The aggregate of the legacy page list: trusted engine constants.

    Filtered through ``live_conflict`` like any claim, when one is given.
    """
    from .legacy_manifest import legacy_head_title, legacy_page_manifest

    manifest = legacy_page_manifest()
    exact: Dict[str, Page] = {}
    for raw in manifest['publicPages']:
        conflict = live_conflict(raw['path']) if live_conflict else None
        if conflict:
            debug(f'[public_pages] legacy page {raw["path"]} collides with the live route {conflict} (page skipped)')
            continue
        exact[raw['path']] = Page(
            path=raw['path'],
            app_id='',
            title=raw['title'],
            description=raw['description'],
            listed=raw['listed'],
            head_title=legacy_head_title(raw['path'], raw['title']),
        )
    return Aggregate(exact=exact, site=dict(manifest['site']), legacy=True)


async def load_published(
    acct: Any = None, strict: bool = False, exclude: str = '', unreadable: Optional[Set[str]] = None
) -> List[Published]:
    """The production-rung manifests of every published platform app.

    Public rows only (a team or user pin, the pre-release cookie path, never
    reaches here), through the SAME serving gate the store walk uses (binding
    enabled, deployment approved on a review-ladder server, build ok),
    anonymous permission reach (no requiredPermissions), platform namespace
    only. One winner per app id, chosen among its serving rows (lowest
    publisher org, as the store walk resolves ties).

    ``public: false`` apps never contribute. One app whose row or artifact
    cannot be read is skipped (logged) so it cannot freeze the map, and its
    id goes into ``unreadable`` when one is given: it is still published,
    unlike an app missing from the result for any other reason. With
    ``strict`` (the publish gate) an unreadable root claimant raises instead,
    since its claims cannot be checked; a platform app that may not claim
    root holds no claims, so it is skipped either way. ``exclude`` names an
    app left out unread: at the gate, the publishing app, whose current
    version is being replaced (an unreadable current version must never lock
    it out of publishing a fix).

    Raises:
        Exception: a publish_list failure (the rebuild keeps the previous
            aggregate).
        RuntimeError: with ``strict``, a root claimant that cannot be read
            (the message names it).
    """
    if acct is None:
        from ai.account import account as acct

    org = '' if 'saas' in getattr(acct, 'capabilities', ()) else 'local'
    review_ladder = getattr(acct, 'review_ladder', True)
    winners: Dict[str, Dict[str, Any]] = {}
    for row in precedence_sorted(await acct.publish_list(org, 'app', [{'type': 'public', 'id': ''}])):
        # The store walk's order: a row that does not serve never competes,
        # and the precedence winner among the rest lands last.
        if serving_block_of(row, review_ladder) or not holds_required_permissions(row, set()):
            continue
        winners[str(row.get('appId') or '')] = row
    out: List[Published] = []
    for app_id, row in sorted(winners.items()):
        if app_id == exclude or (row.get('audience') or {}).get('type') != 'public' or not is_privileged(app_id):
            continue
        if (row.get('snapshot') or {}).get('public', True) is False:
            continue
        version = row.get('version')
        artifact_path = str(row.get('artifactPath') or '')
        try:
            if not isinstance(version, int) or not artifact_path:
                raise ValueError(f'malformed public row (version {version!r}, artifactPath {artifact_path!r})')
            artifact = await acct.deployments_artifact(str(row.get('orgId') or org), app_id, version)
            stored = manifest_of(artifact or {})
            if stored.get('public', True) is False:
                continue
            dist_dir = dist_dir_of(artifact_path)
            manifest = await page_manifest(stored, dist_dir)
        except Exception as exc:
            # One unreadable app must not freeze the map (a later unpublish
            # elsewhere would never apply): it contributes nothing this build.
            # The gate is strict instead: an unverifiable claim refuses.
            if strict and may_claim_root(app_id):
                raise RuntimeError(f'cannot read the published manifest of {app_id}: {exc}') from exc
            debug(f'[public_pages] {app_id}: skipped this build: {exc}')
            if unreadable is not None:
                unreadable.add(app_id)
            continue
        if 'publicPages' not in manifest and 'site' not in manifest:
            continue
        published_at = row.get('publishedAt') or row.get('updatedAt')
        out.append(
            Published(
                app_id=app_id,
                manifest=manifest,
                dist_dir=dist_dir,
                published_at=float(published_at) if isinstance(published_at, (int, float)) else None,
            )
        )
    return out


# The build-emitted, server-readable manifest file inside a version's build
# output ({publicPages, site} only), shipped next to the pages/*.html
# snapshots. home-ui writes it; the platform seeder mirrors static/apps/<id>/
# into the version's store dist/, so seeded and deployed versions alike carry
# it. Preferred over metadata.manifest: apps.json registration copies a fixed
# field whitelist, and the file is versioned WITH the snapshots it points at.
MANIFEST_FILE = 'app-manifest.json'


async def page_manifest(metadata_manifest: Any, dist_dir: str) -> Mapping[str, Any]:
    """The publicPages/site source of one version.

    ``<dist_dir>/app-manifest.json`` when the build emitted one (its
    ``publicPages``/``site`` are authoritative; other keys are ignored), else
    the registry's ``metadata.manifest``.

    Raises:
        ValueError: the emitted file exists but is not a JSON object.
        Exception: a storage failure other than not-found (the caller
            aborts: no partial aggregate, no unverified publish).
    """
    from ai.account.store import StorageNotFoundError

    fallback = metadata_manifest if isinstance(metadata_manifest, Mapping) else {}
    if not dist_dir:
        return fallback
    try:
        raw = await read_artifact_file(f'{dist_dir}/{MANIFEST_FILE}')
    except StorageNotFoundError:
        return fallback
    try:
        emitted = json.loads(raw.decode('utf-8'))
    except ValueError:
        emitted = None
    if not isinstance(emitted, dict):
        raise ValueError(f'{MANIFEST_FILE} in the build output is not a JSON object')
    return {key: emitted[key] for key in ('publicPages', 'site') if key in emitted}


async def read_artifact_file(path: str) -> bytes:
    """Read one file of a version's store tree (snapshots and the emitted manifest live under ``dist/``)."""
    from ai.account.store import Store

    return await Store.instance().raw_store().read_bytes(path)


# =============================================================================
# THE PUBLISH GATE: called where kind:'app' publishes are validated
# =============================================================================


async def gate_errors(app_id: str, manifest: Mapping[str, Any], dist_dir: str, acct: Any = None) -> List[str]:
    """Why publishing this version to the public rung must be refused ([] = allowed).

    Runs at ``rrext_deploy_app publish`` for the public audience only, the
    one rung the aggregate reads. Checks, each with an actionable message:
    privilege and may-claim-root, path grammar, reserved prefixes, data
    entries, cross-app collisions against every OTHER published platform
    manifest (first claim wins; ownership is derived from published
    manifests, so unpublishing releases it, with no table), and snapshot
    files missing from the built version.

    The sections come from the version's build-emitted ``app-manifest.json``
    when present, else ``manifest`` (``metadata.manifest``): the same
    resolution the aggregate uses. Only platform apps' build output is read
    (a third party's sections can never take effect, so its
    ``metadata.manifest`` alone decides how loudly it is refused); a version
    without either section derives no claims.

    Args:
        app_id: The publishing app's id.
        manifest: The version's ``metadata.manifest``.
        dist_dir: The version's store ``dist/`` tree; empty when the version
            has no artifact path.
        acct: The account layer (the singleton when None).

    Raises:
        Exception: the build output of a platform app cannot be located, or a
            storage failure while reading it or deriving claims; the caller
            refuses the publish (fail closed).
    """
    from ai.account.store import StorageNotFoundError

    if is_privileged(app_id):
        if not dist_dir:
            raise ValueError('the version has no artifact path, so its build output cannot be read')
        try:
            manifest = await page_manifest(manifest, dist_dir)
        except ValueError as exc:
            return [f'{exc}; emit {{"publicPages": [...], "site": {{...}}}} or drop the file']
    if 'publicPages' not in manifest and 'site' not in manifest:
        return []
    pages, _, errors = check_manifest(app_id, manifest, _live_conflict)
    if not pages:
        # Nothing to collide or snapshot (a third party, or every page invalid):
        # never read, or echo a failure of, the other platform apps' storage.
        return errors
    # The publishing app's own current version is being replaced: never read it.
    others = await load_published(acct, strict=True, exclude=app_id)
    exact, _ = _claims(others, _live_conflict)
    for page in pages:
        owner = exact.get(page.path)
        if owner is not None:
            errors.append(
                f'publicPages path {page.path!r} is already claimed by the published app {owner.app_id} '
                '(first claim wins; the claim is released when that app unpublishes); choose another path'
            )
    for page in pages:
        if not page.snapshot:
            continue
        try:
            await read_artifact_file(f'{dist_dir}/{page.snapshot}')
        except StorageNotFoundError:
            errors.append(
                f'publicPages path {page.path!r}: snapshot {page.snapshot!r} is not in the built version; '
                'emit it into the build output or drop the field'
            )
    return errors


# =============================================================================
# CURRENT AGGREGATE + ATOMIC REBUILD
# =============================================================================

# The first build blocks startup at most this long. Reading the published
# manifests is a store listing plus two small reads per platform app, well under
# a second on a healthy store; a slow or hanging store must not hold the engine
# off its port (and its health checks) for longer. On timeout the engine boots
# on the legacy page list and the build finishes in the background.
STARTUP_BUILD_SECONDS = 10.0

# One build (the store listing and every read) may take at most this long. A
# slow store needs a few seconds; a hung read must not hold the rebuild lock and
# freeze the map. On timeout the previous aggregate stays, the lock is released,
# and the next platform app deploy event retries.
BUILD_SECONDS = 60.0

_current: Optional[Aggregate] = None
_live_conflict: Optional[Callable[[str], Optional[str]]] = None
_on_swap: List[Callable[[Aggregate, Aggregate], None]] = []
_rebuild_lock = asyncio.Lock()
_rebuild_task: Any = None
_rebuild_pending = False


def current() -> Aggregate:
    """The aggregate in effect right now (the legacy one until the first build)."""
    global _current
    if _current is None:
        _current = legacy_aggregate()
    return _current


def set_live_conflict(fn: Optional[Callable[[str], Optional[str]]]) -> None:
    """Install the live-route collision check (the shell module installs ``pages.live_route_conflict``)."""
    global _live_conflict
    _live_conflict = fn


def live_conflict() -> Optional[Callable[[str], Optional[str]]]:
    """The installed live-route collision check, or None."""
    return _live_conflict


def on_swap(callback: Callable[[Aggregate, Aggregate], None]) -> None:
    """Register ``callback(old, new)``, run after every aggregate swap."""
    _on_swap.append(callback)


def swap(aggregate: Aggregate) -> None:
    """Atomically replace the current aggregate, then notify listeners."""
    global _current
    old = current()
    _current = aggregate
    for callback in list(_on_swap):
        try:
            callback(old, aggregate)
        except Exception as exc:
            warning(f'[public_pages] swap listener failed: {exc}')


async def rebuild(acct: Any = None) -> bool:
    """Rebuild from the published manifests; swap only when the map changed.

    One rebuild at a time, so a slower, older build never lands after a newer
    one, each bounded by ``BUILD_SECONDS``. Any failure (reading the store,
    a timeout, or building) keeps the previous aggregate. An app the store
    still publishes but cannot read keeps its pages: its manifest in the
    current aggregate is built again and claims against the fresh ones, so a
    transient read error drops nothing. An app no longer published drops its
    pages.

    Returns:
        True when the aggregate now reflects the published manifests, False
        when the build failed and the previous aggregate stays.
    """
    async with _rebuild_lock:
        try:
            unreadable: Set[str] = set()
            published = list(await asyncio.wait_for(load_published(acct, unreadable=unreadable), BUILD_SECONDS))
            for app_id in sorted(unreadable):
                kept = current().published.get(app_id)
                if kept is not None:
                    warning(f'[public_pages] {app_id}: unreadable this build, keeping its current pages')
                    published.append(kept)
            aggregate = build_aggregate(published, _live_conflict)
        except asyncio.TimeoutError:
            warning(f'[public_pages] rebuild timed out after {BUILD_SECONDS:g}s, keeping the previous aggregate')
            return False
        except Exception as exc:
            warning(f'[public_pages] rebuild failed, keeping the previous aggregate: {exc}')
            return False
        if aggregate != current():
            swap(aggregate)
        return True


def schedule_rebuild() -> None:
    """Coalesced background rebuild: the publish/unpublish/rung-repoint hook.

    Never blocks the caller. Events arriving while a rebuild runs fold into
    exactly one more rebuild. A no-op outside a running event loop.
    """
    global _rebuild_task, _rebuild_pending
    _rebuild_pending = True
    if _rebuild_task is not None and not _rebuild_task.done():
        return
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return
    _rebuild_task = loop.create_task(_rebuild_loop())


async def _rebuild_loop() -> None:
    global _rebuild_pending
    while _rebuild_pending:
        _rebuild_pending = False
        await rebuild()


async def build_at_startup() -> bool:
    """Build the first aggregate before the engine serves, waiting at most ``STARTUP_BUILD_SECONDS``.

    Returns:
        True when the build finished in time. Otherwise the engine starts on
        the legacy page list and the build carries on in the background.
    """
    schedule_rebuild()
    done, _ = await asyncio.wait({_rebuild_task}, timeout=STARTUP_BUILD_SECONDS)
    if not done:
        warning(
            f'[public_pages] the first build is still running after {STARTUP_BUILD_SECONDS:g}s; starting on the legacy page list'
        )
    return bool(done)


def app_changed(app_id: str) -> None:
    """The app deployment-change hook (``broadcast_app_changed``).

    Only a platform app's publish, unpublish or rung repoint can change the
    page claims; any other app's is ignored.
    """
    if is_privileged(app_id):
        schedule_rebuild()
