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
pages are lives in the owning app's manifest, not in the engine. The public
pages, ``/sitemap.xml`` and ``/llms.txt`` are served from it (``pages.py``,
``shell.py``). It is built at startup, rebuilt in the background on every
platform app's publish, unpublish or rung repoint (and at least every
``REFRESH_SECONDS`` on traffic), and kept as it was when the store cannot be
read. Until a published manifest contributes a valid page, it holds the legacy
page list (``legacy_manifest.py``).

The publish gate (``gate_errors``) refuses a public publish whose page claims
are invalid. The aggregate re-checks every manifest anyway: seeded platform
rows never pass the gate.
"""

import asyncio
import json
import time
from dataclasses import dataclass, field, replace
from typing import Any, Callable, Dict, List, Mapping, Optional, Set, Tuple

from rocketlib import debug, warning

from ai.account.app_rows import dist_dir_of, manifest_of, public_winners

from . import data_sources
from .contract import (
    MAX_SNAPSHOT_BYTES,
    Page,
    check_manifest,
    check_redirects,
    is_privileged,
    may_claim_root,
    slash_twin_label,
    with_slash_twin,
)


@dataclass(frozen=True)
class Published:
    """One production-rung (public) app version's manifest, as the loader read it.

    ``version`` is the registry version the public rung serves; ``dist_dir``
    is that version's build output.
    """

    app_id: str
    manifest: Mapping[str, Any]
    dist_dir: str = ''
    published_at: Optional[float] = None
    version: Optional[int] = None


@dataclass(frozen=True)
class Aggregate:
    """The immutable page map, keyed by exact path. A rebuild swaps a whole new one (never edited).

    ``redirects`` maps an old path to the page path it 301s to, and
    ``feeds`` a feed path to its ``{path, prefix, title}`` (the root
    owner's ``site.redirects`` and ``site.feeds``). ``built_at`` is the
    wall-clock time it was built; it never makes two aggregates differ, so
    an unchanged rebuild is not swapped in and the time stays that of the
    content.

    ``published`` maps each app owning a page to the manifest it was read
    from: what a rebuild keeps when that app cannot be read. Comparisons
    ignore it.
    """

    exact: Mapping[str, Page]
    site: Mapping[str, Any] = field(default_factory=dict)
    published: Mapping[str, Published] = field(default_factory=dict, compare=False, repr=False)
    legacy: bool = False
    redirects: Mapping[str, str] = field(default_factory=dict)
    feeds: Mapping[str, Mapping[str, str]] = field(default_factory=dict)
    built_at: float = field(default_factory=time.time, compare=False)

    def pages(self) -> List[Page]:
        """Every claimed page, sorted by path (deterministic output order)."""
        return sorted(self.exact.values(), key=lambda p: p.path)

    def serves_published_pages(self) -> bool:
        """Whether platform apps publish pages here; the legacy list and an empty map publish none."""
        return not self.legacy and bool(self.exact)


def _claim_key(pub: Published) -> Tuple[float, str]:
    """Sort key of one claim: its production binding time, then its app id. An unknown time sorts last."""
    if pub.published_at is None:
        return float('inf'), pub.app_id
    return pub.published_at, pub.app_id


def _claim_order(published: List[Published]) -> List[Published]:
    """First claim wins: the earlier production binding, then app id (deterministic)."""
    return sorted(published, key=_claim_key)


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
            exact[page.path] = replace(page, dist_dir=pub.dist_dir, version=pub.version, published_at=pub.published_at)
        if site is not None:
            sites[pub.app_id] = site
    return exact, sites


def build_aggregate(
    published: List[Published], live_conflict: Optional[Callable[[str], Optional[str]]] = None
) -> Aggregate:
    """Build the aggregate from published manifests (pure; no I/O).

    Every manifest is re-validated (``check_manifest``) and only its valid
    pages are kept; a page colliding with an earlier claim is dropped (first
    claim wins). ``site`` and its redirects come only from the app owning
    ``/``; a redirect whose source (or its slash twin) another app's page
    serves is dropped, and so is a feed at another app's page. When no page
    survives, the aggregate is the legacy page list (a broken manifest falls
    back instead of removing every page).
    """
    exact, sites = _claims(published, live_conflict)
    if not exact:
        return legacy_aggregate(live_conflict)
    site: Dict[str, Any] = {}
    root = exact.get('/')
    if root is not None:
        site = dict(sites.get(root.app_id, {}))
    redirects = {}
    for source, target in site.pop('redirects', {}).items():
        if any(c in exact for c in with_slash_twin(source)):
            debug(f'[public_pages] redirect {source} -> {target} collides with a page (redirect skipped)')
            continue
        redirects[source] = target
    feeds = {}
    for path, feed in site.pop('feeds', {}).items():
        if path in exact:
            debug(f'[public_pages] feed {path} collides with a page (feed skipped)')
            continue
        feeds[path] = feed
    owners = {page.app_id for page in exact.values()}
    return Aggregate(
        exact=exact,
        site=site,
        published={pub.app_id: pub for pub in published if pub.app_id in owners},
        redirects=redirects,
        feeds=feeds,
    )


def legacy_aggregate(live_conflict: Optional[Callable[[str], Optional[str]]] = None) -> Aggregate:
    """The aggregate of the legacy page list and its redirects: trusted engine constants.

    Filtered through ``live_conflict`` like any claim, when one is given.
    """
    from .legacy_manifest import legacy_head_title, legacy_page_manifest

    manifest = legacy_page_manifest()
    exact: Dict[str, Page] = {}
    for raw in manifest['publicPages']:
        if live_conflict is not None:
            conflict = live_conflict(raw['path'])
            if conflict:
                debug(
                    f'[public_pages] legacy page {raw["path"]} collides with the live route {conflict} (page skipped)'
                )
                continue
        exact[raw['path']] = Page(
            path=raw['path'],
            app_id='',
            title=raw['title'],
            description=raw['description'],
            listed=raw['listed'],
            head_title=legacy_head_title(raw['path'], raw['title']),
        )
    site = dict(manifest['site'])
    redirects, errors = check_redirects(site.pop('redirects'), list(exact.values()), live_conflict)
    for err in errors:
        debug(f'[public_pages] legacy {err} (redirect skipped)')
    return Aggregate(exact=exact, site=site, legacy=True, redirects=redirects)


def _skip_unreadable(
    app_id: str, reason: str, strict: bool, unreadable: Optional[Set[str]], cause: Optional[Exception] = None
) -> None:
    """Leave one app the loader cannot read out of this build; under ``strict``, refuse instead for a root claimant.

    One unreadable app must not freeze the map (a later unpublish elsewhere
    would never apply). The gate is strict: an unverifiable claim refuses.
    """
    if strict and may_claim_root(app_id):
        raise RuntimeError(f'cannot read the published manifest of {app_id}: {reason}') from cause
    debug(f'[public_pages] {app_id}: skipped this build: {reason}')
    if unreadable is not None:
        unreadable.add(app_id)


async def load_published(
    acct: Any = None, strict: bool = False, exclude: str = '', unreadable: Optional[Set[str]] = None
) -> List[Published]:
    """The production-rung manifests of every published platform app.

    Public rows only (a team or user pin, the pre-release cookie path, never
    reaches here), through the SAME serving gate the store walk uses (binding
    enabled, deployment approved on a review-ladder server, build ok),
    anonymous permission reach (no requiredPermissions), platform namespace
    only. One winner per app id, chosen among its serving rows (lowest
    publisher org, as the store walk resolves ties) by
    ``app_rows.public_winners``, which the ``plans:``/``app:`` data sources
    read too.

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
    org, winners = await public_winners(acct)
    out: List[Published] = []
    for app_id, row in sorted(winners.items()):
        if app_id == exclude or not is_privileged(app_id):
            continue
        if (row.get('snapshot') or {}).get('public', True) is False:
            continue
        version = row.get('version')
        artifact_path = str(row.get('artifactPath') or '')
        if not isinstance(version, int) or not artifact_path:
            _skip_unreadable(
                app_id,
                f'malformed public row (version {version!r}, artifactPath {artifact_path!r})',
                strict,
                unreadable,
            )
            continue
        try:
            artifact = await acct.deployments_artifact(str(row.get('orgId') or org), app_id, version)
            stored = manifest_of(artifact or {})
            if stored.get('public', True) is False:
                continue
            dist_dir = dist_dir_of(artifact_path)
            manifest = await page_manifest(stored, dist_dir)
        except Exception as exc:
            _skip_unreadable(app_id, str(exc), strict, unreadable, exc)
            continue
        if 'publicPages' not in manifest and 'site' not in manifest:
            continue
        bound_at = row.get('publishedAt') or row.get('updatedAt')
        published_at: Optional[float] = None
        if isinstance(bound_at, (int, float)):
            published_at = float(bound_at)
        out.append(
            Published(
                app_id=app_id,
                manifest=manifest,
                dist_dir=dist_dir,
                published_at=published_at,
                version=version,
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
    """Read one file of a version's store tree (snapshots and the emitted manifest live under ``dist/``).

    Args:
        path: The file's store path.

    Returns:
        The file's bytes.

    Raises:
        StorageNotFoundError: the file does not exist.
        StorageError: any other storage failure, a transport failure the
            store stopped retrying included.
    """
    from ai.account.store import StorageError, Store
    from ai.account.store_providers.s3.s3 import TRANSIENT_ERRORS

    try:
        return await Store.instance().raw_store().read_bytes(path)
    except TRANSIENT_ERRORS as exc:
        raise StorageError(f'Failed to read {path}: {exc}') from exc


async def artifact_file_info(path: str) -> Dict[str, Any]:
    """Stat one file of a version's store tree without reading its body.

    ``get_file_info`` is a stat on the filesystem store and a HEAD on S3 and
    Azure, so proving a snapshot exists never downloads it.

    Args:
        path: The file's store path.

    Returns:
        ``{'size': <bytes>, 'modified': <epoch seconds>}``.

    Raises:
        StorageNotFoundError: the file does not exist.
        StorageError: any other storage failure, a transport failure the
            store stopped retrying included.
    """
    from ai.account.store import StorageError, Store
    from ai.account.store_providers.s3.s3 import TRANSIENT_ERRORS

    try:
        return await Store.instance().raw_store().get_file_info(path)
    except TRANSIENT_ERRORS as exc:
        raise StorageError(f'Failed to stat {path}: {exc}') from exc


# =============================================================================
# THE PUBLISH GATE: called where kind:'app' publishes are validated
# =============================================================================


async def gate_errors(app_id: str, manifest: Mapping[str, Any], dist_dir: str, acct: Any = None) -> List[str]:
    """Why publishing this version to the public rung must be refused ([] = allowed).

    Runs at ``rrext_deploy_app publish`` for the public audience only, the
    one rung the aggregate reads. Checks, each with an actionable message:
    privilege and may-claim-root, path grammar, reserved prefixes and the
    live route table, data entries, redirects, cross-app collisions (of page
    paths and redirect sources) against every OTHER published platform
    manifest (first claim wins; ownership is derived from published
    manifests, so unpublishing releases it, with no table) and of feed
    paths against their pages, and snapshot files (each page's and
    ``site.notFound``) missing from the built version or over
    ``MAX_SNAPSHOT_BYTES`` (sized by a stat, never read).

    The collision check sees only what is already published: two platform
    apps publishing the same path at the same moment can both pass. The
    aggregate then keeps the first claim and drops the other with a warning
    naming both apps.

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
    pages, site, errors = check_manifest(app_id, manifest, page_map.live_conflict)
    if not pages:
        # Nothing to collide or snapshot (a third party, or every page invalid):
        # never read, or echo a failure of, the other platform apps' storage.
        return errors
    # The publishing app's own current version is being replaced: never read it.
    others = await load_published(acct, strict=True, exclude=app_id)
    exact, sites = _claims(others, page_map.live_conflict)
    root = exact.get('/')
    root_feeds = {}
    if root is not None:
        root_feeds = sites.get(root.app_id, {}).get('feeds', {})
    for page in pages:
        for candidate in with_slash_twin(page.path):
            if candidate in root_feeds:
                errors.append(
                    f'publicPages path {page.path!r} is a feed of the published app {root.app_id}; choose another path'
                )
                break
        owner = exact.get(page.path)
        if owner is not None:
            errors.append(
                f'publicPages path {page.path!r} is already claimed by the published app {owner.app_id} '
                '(first claim wins; the claim is released when that app unpublishes); choose another path'
            )
    for source in (site or {}).get('redirects', {}):
        for candidate in with_slash_twin(source):
            owner = exact.get(candidate)
            if owner is not None:
                which = slash_twin_label(source, candidate)
                errors.append(
                    f'site.redirects from {source!r}: {which}is a page of the published app {owner.app_id}; '
                    'a URL is a page or a redirect, not both: drop the entry'
                )
                break
    for path in (site or {}).get('feeds', {}):
        owner = exact.get(path)
        if owner is not None:
            errors.append(
                f'site.feeds path {path!r} is a page of the published app {owner.app_id}; choose another path'
            )
    for page in pages:
        if not page.snapshot:
            continue
        err = await _stored_snapshot_error(f'{dist_dir}/{page.snapshot}')
        if err:
            errors.append(f'publicPages path {page.path!r}: snapshot {page.snapshot!r} {err}')
    not_found = (site or {}).get('notFound')
    if not_found:
        err = await _stored_snapshot_error(f'{dist_dir}/{not_found}')
        if err:
            errors.append(f'site.notFound {not_found!r} {err}')
    images = [(f'publicPages path {page.path!r}: image', page.image) for page in pages]
    if site is not None:
        images.append(('site.image', site.get('image', '')))
    for label, image in images:
        if not image or image.startswith(('https://', '/')):
            continue
        try:
            await artifact_file_info(f'{dist_dir}/{image}')
        except StorageNotFoundError:
            errors.append(
                f'{label} {image!r} is not in the built version; emit it into the build output or drop the field'
            )
    return errors


async def _stored_snapshot_error(path: str) -> Optional[str]:
    """Why the snapshot at store ``path`` cannot be published, or None.

    Sized by a stat, never read: a missing file, or one over
    ``MAX_SNAPSHOT_BYTES``, which the server would never serve.

    Args:
        path: The snapshot's store path in the version's build output.

    Returns:
        The reason, ready to follow the snapshot's name, or None.

    Raises:
        StorageError: any storage failure but a missing file; the caller
            refuses the publish (fail closed).
    """
    from ai.account.store import StorageNotFoundError

    try:
        info = await artifact_file_info(path)
    except StorageNotFoundError:
        return 'is not in the built version; emit it into the build output or drop the field'
    if info['size'] > MAX_SNAPSHOT_BYTES:
        return (
            f'is {info["size"]} bytes, over the {MAX_SNAPSHOT_BYTES}-byte limit; move images, styles and scripts '
            'into the build output and reference them through {{assets}}'
        )
    return None


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
# and the next platform app deploy event (or the backstop) retries.
BUILD_SECONDS = 60.0

# Convergence backstop: deploy events are in-process only, so a pod that did
# not handle a publish learns of it from the first request after this age.
REFRESH_SECONDS = 300.0


class PageMap:
    """The page map in effect: the current aggregate, its swap listeners and the one-at-a-time rebuild.

    The engine runs one, ``page_map``; the module functions below delegate to
    it. A fresh instance holds the legacy aggregate until its first swap, has
    no listeners and runs no rebuild.
    """

    def __init__(self) -> None:
        """Start with no aggregate built, no live-route check, no listeners and no rebuild running."""
        self.live_conflict: Optional[Callable[[str], Optional[str]]] = None
        self.listeners: List[Callable[[Aggregate, Aggregate], None]] = []
        self._current: Optional[Aggregate] = None
        # time.monotonic() of the last swap or backstop rebuild.
        self._built_at = 0.0
        # One per instance: a lock binds to the event loop that first waits on it.
        self._rebuild_lock = asyncio.Lock()
        self._rebuild_task: Optional[asyncio.Task] = None
        self._rebuild_pending = False

    async def build_at_startup(self) -> bool:
        """Build the first aggregate before the engine serves, waiting at most ``STARTUP_BUILD_SECONDS``.

        Returns:
            True when the build finished in time. Otherwise the engine starts
            on the legacy page list and the build carries on in the background.
        """
        self.schedule_rebuild()
        done, _ = await asyncio.wait({self._rebuild_task}, timeout=STARTUP_BUILD_SECONDS)
        if not done:
            warning(
                f'[public_pages] the first build is still running after {STARTUP_BUILD_SECONDS:g}s; '
                'starting on the legacy page list'
            )
        return bool(done)

    def maybe_refresh(self) -> None:
        """Schedule a background rebuild when the last one is older than ``REFRESH_SECONDS``.

        Called on every public page and crawler file request; never waits for the
        build (the swap lands on a later request). The clock restarts when the
        rebuild is scheduled, not when it swaps: an unchanged map is not swapped,
        and a failing store must not be retried on every request. Deploy events
        are in-process only, so this is how a pod learns of a publish another
        pod handled. Takes and returns nothing; a failed rebuild keeps the
        current aggregate (``rebuild``).
        """
        if time.monotonic() - self._built_at > REFRESH_SECONDS:
            self._built_at = time.monotonic()
            self.schedule_rebuild()

    def schedule_rebuild(self) -> None:
        """Coalesced background rebuild: the publish/unpublish/rung-repoint hook.

        Never blocks the caller. Events arriving while a rebuild runs fold into
        exactly one more rebuild. A no-op outside a running event loop.
        """
        self._rebuild_pending = True
        if self._rebuild_task is not None and not self._rebuild_task.done():
            return
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            return
        self._rebuild_task = loop.create_task(self._rebuild_loop())

    async def _rebuild_loop(self) -> None:
        """Run rebuilds until no more were requested while one ran (``schedule_rebuild`` coalesces into this)."""
        while self._rebuild_pending:
            self._rebuild_pending = False
            await self.rebuild()

    async def rebuild(self, acct: Any = None) -> bool:
        """Rebuild from the published manifests; swap only when the map changed.

        One rebuild at a time, so a slower, older build never lands after a newer
        one, each bounded by ``BUILD_SECONDS``. Any failure (reading the store,
        a timeout, or building) keeps the previous aggregate. An app the store
        still publishes but cannot read keeps its pages: its manifest in the
        current aggregate is built again and claims against the fresh ones, so a
        transient read error drops nothing. An app no longer published drops its
        pages.

        Args:
            acct: The account layer (the singleton when None).

        Returns:
            True when the aggregate now reflects the published manifests, False
            when the build failed and the previous aggregate stays.
        """
        async with self._rebuild_lock:
            try:
                unreadable: Set[str] = set()
                published = list(await asyncio.wait_for(load_published(acct, unreadable=unreadable), BUILD_SECONDS))
                for app_id in sorted(unreadable):
                    kept = self.current().published.get(app_id)
                    if kept is not None:
                        warning(f'[public_pages] {app_id}: unreadable this build, keeping its current pages')
                        published.append(kept)
                aggregate = build_aggregate(published, self.live_conflict)
            except asyncio.TimeoutError:
                warning(f'[public_pages] rebuild timed out after {BUILD_SECONDS:g}s, keeping the previous aggregate')
                return False
            except Exception as exc:
                warning(f'[public_pages] rebuild failed, keeping the previous aggregate: {exc}')
                return False
            if aggregate != self.current():
                self.swap(aggregate)
            return True

    def swap(self, aggregate: Aggregate) -> None:
        """Atomically replace the current aggregate, then notify listeners.

        Args:
            aggregate: The new aggregate. A listener that raises is logged and
                never stops the swap or the other listeners.
        """
        old = self.current()
        self._current = aggregate
        self._built_at = time.monotonic()
        for callback in list(self.listeners):
            try:
                callback(old, aggregate)
            except Exception as exc:
                warning(f'[public_pages] swap listener failed: {exc}')

    def current(self) -> Aggregate:
        """The aggregate in effect right now (the legacy one until the first build).

        Returns:
            The current aggregate.
        """
        if self._current is None:
            self._current = legacy_aggregate()
        return self._current


page_map = PageMap()


def current() -> Aggregate:
    """The aggregate in effect right now (the legacy one until the first build).

    Returns:
        ``page_map.current()``.
    """
    return page_map.current()


def set_live_conflict(fn: Optional[Callable[[str], Optional[str]]]) -> None:
    """Install the live-route collision check (the shell module installs ``pages.live_route_conflict``).

    Args:
        fn: Maps a path to the live route it collides with, or None; None
            removes the check.
    """
    page_map.live_conflict = fn


def live_conflict() -> Optional[Callable[[str], Optional[str]]]:
    """The installed live-route collision check.

    Returns:
        The check, or None when none is installed.
    """
    return page_map.live_conflict


def on_swap(callback: Callable[[Aggregate, Aggregate], None]) -> None:
    """Register ``callback(old, new)``, run after every aggregate swap.

    Args:
        callback: Called with the old and the new aggregate.
    """
    page_map.listeners.append(callback)


def swap(aggregate: Aggregate) -> None:
    """Atomically replace the current aggregate, then notify listeners (``PageMap.swap``).

    Args:
        aggregate: The new aggregate.
    """
    page_map.swap(aggregate)


async def rebuild(acct: Any = None) -> bool:
    """Rebuild from the published manifests; swap only when the map changed (``PageMap.rebuild``).

    Args:
        acct: The account layer (the singleton when None).

    Returns:
        True when the aggregate now reflects the published manifests, False
        when the build failed and the previous aggregate stays.
    """
    return await page_map.rebuild(acct)


def schedule_rebuild() -> None:
    """Coalesced background rebuild (``PageMap.schedule_rebuild``); never blocks the caller."""
    page_map.schedule_rebuild()


async def build_at_startup() -> bool:
    """Build the first aggregate before the engine serves (``PageMap.build_at_startup``).

    Returns:
        True when the build finished in time; otherwise the engine starts on
        the legacy page list and the build carries on in the background.
    """
    return await page_map.build_at_startup()


def maybe_refresh() -> None:
    """Schedule a background rebuild when the last one is older than ``REFRESH_SECONDS`` (``PageMap.maybe_refresh``)."""
    page_map.maybe_refresh()


def app_changed(app_id: str) -> None:
    """The app deployment-change hook (``broadcast_app_changed``).

    A change to an app a page names (``plans:<appId>``, ``app:<appId>``) can
    change what that page may show, so the data sources are invalidated; any
    other app's change (a build, say) leaves bound renders cached. Only a
    platform app's publish, unpublish or rung repoint can change the page
    claims, so only those rebuild the aggregate.

    Args:
        app_id: The app whose deployment changed.
    """
    if _named_by_a_page(app_id):
        data_sources.invalidate('app')
    if is_privileged(app_id):
        schedule_rebuild()


def _named_by_a_page(app_id: str) -> bool:
    """Whether a page of the current aggregate binds ``app_id``'s data (``plans:<appId>`` or ``app:<appId>``)."""
    entries = {f'plans:{app_id}', f'app:{app_id}'}
    return any(entries.intersection(page.data) for page in current().exact.values())
