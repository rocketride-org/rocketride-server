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
The public-page catch-all: one route, every method, answering from the page aggregate.

Registered last (``register_public_pages``, at the end of server startup,
after every module and the account layer): FastAPI matches routes in
registration order, so every real route wins and only unmatched requests
reach here. Pages answer GET and HEAD (405 otherwise). A redirect source
(``site.redirects``) and a page's trailing-slash twin answer GET and HEAD
with a 301 to the page; any other path the aggregate does not claim answers
what the router answered before the catch-all existed: 405, 307 or 404.

Auth: the catch-all is not a public route, which would open every path,
private API routes included, to anonymous callers. The web server consults
``is_public_path`` per request instead: only paths no real route matches
(the catch-all answers them with a page, a redirect or a 404) skip
authentication; a path any real route matches still needs credentials.

A page answers people with the document the shell boots from (the route's
prerendered capture when the shell build carries one, else ``index.html``),
so the shell boots and routes as before. A crawler (``crawlers.classify``)
gets the page's ``snapshot`` instead: that file of the production version's
build output, rendered by the restricted template engine (``template.py``)
with ``assets``, the version's URL base, and the page's bound data sources
(``data_sources.py``). A page without a snapshot, or with one that cannot be
read or rendered, serves crawlers the shell document too. Either way the
page's head metadata (title, description, canonical URL, robots) is injected,
plus, for crawlers, the JSON-LD of its data sources. A source that cannot be
read leaves the page without its data, uncached. Only a rendered snapshot may
sit in shared caches; the shell document names the current build's bundles,
so it is ``private, no-cache`` for everyone.

Rendered responses are cached per (path, UA class) under a byte budget and
dropped on every aggregate swap; a crawler response bound to a data source is
also dropped when that source is invalidated, and expires after
``data_sources.TTL_SECONDS``. Shared caches may keep such a response only for
what is left of that time, so the TTL bounds staleness end to end. Snapshot
bytes, immutable per version, are cached by store path under their own byte
budget. A snapshot over ``MAX_SNAPSHOT_BYTES`` (sized by a stat) is never read.
"""

import asyncio
import math
import sys
import time
from pathlib import Path
from time import monotonic
from typing import Any, Dict, Iterable, List, Optional, Tuple

from fastapi import HTTPException
from fastapi.responses import HTMLResponse, RedirectResponse, Response
from starlette.routing import Route, WebSocketRoute

from ai.account.store import StorageError
from ai.web import Request, WebServer
from ai.web.middleware import route_path

from rocketlib import warning

from . import data_sources, public_pages
from .contract import MAX_SNAPSHOT_BYTES, Page, snapshot_error, with_slash_twin
from .crawlers import CRAWLER, classify
from .head import inject_head
from .settings import app_url
from .shell import CACHE_CONTROL, shell_document_path, shell_static
from .template import TemplateError, render

# The web server whose route table the auth predicate and the live-route
# collision check read (set by initModule).
_web_server: Optional[WebServer] = None

# Path parameter name of the catch-all (distinctive, so no handler signature
# ever collides with it).
FALLBACK_PATH = '/{public_page_path:path}'

# Bounds how long browsers keep a 301: the redirect map and page paths are
# manifest data that can change, and an unbounded 301 is cached indefinitely.
_REDIRECT_CACHE_CONTROL = 'public, max-age=86400'


def set_web_server(server: WebServer) -> None:
    """Give this module the live server: its route table drives the auth predicate, router misses and collision checks.

    Args:
        server: The web server this module's routes are registered on.
    """
    global _web_server
    _web_server = server


def _real_routes(server: WebServer) -> list:
    """The server's HTTP routes in match order (websocket routes never match an HTTP request)."""
    return [r for r in server.app.router.routes if not isinstance(r, WebSocketRoute)]


def _first_route_matching(path: str, routes: Iterable[Any]) -> Optional[Any]:
    """The first of ``routes`` whose path pattern matches ``path``, in order.

    A route without a path pattern (a ``Host``) cannot be checked against a
    path, so it counts as a match: a caller that must fail closed gets it
    back, and one that must not leaves such routes out of ``routes``.

    Args:
        path: The path the router matches (``root_path`` stripped).
        routes: Routes in match order.

    Returns:
        The matching route, or None when no route matches.
    """
    for route in routes:
        regex = getattr(route, 'path_regex', None)
        if regex is None or regex.match(path):
            return route
    return None


def is_public_path(path: str) -> bool:
    """Auth-middleware predicate: will a page handler answer this path?

    True when the first route whose pattern matches the path is a page
    handler (``/`` or the catch-all). Those answer only public outcomes (a
    page, a redirect or a 404), so an anonymous caller gets those instead of
    a 401. A path any real route's pattern matches stays private, whatever
    the aggregate claims. A route the check cannot reason about (no path
    pattern) fails closed.

    Args:
        path: The path the router matches (``route_path``: ``root_path`` stripped).

    Returns:
        True when a page handler answers ``path``; False when a real route
        does, or the check cannot tell.
    """
    route = _first_route_matching(path, _real_routes(_web_server))
    return route is not None and getattr(route, 'endpoint', None) is public_page


def live_route_conflict(path: str) -> Optional[str]:
    """The live route a page path would collide with ('GET /status'), or None.

    Reads the web server's current route table: the real routes every module
    and the account layer registered. The page handlers themselves (``/`` and
    the catch-all) are the claim space, not conflicts.
    """
    server = _web_server
    if server is None:
        return None
    routes = [
        r
        for r in server.app.router.routes
        if getattr(r, 'path', None) and getattr(r, 'endpoint', None) is not public_page
    ]
    route = _first_route_matching(path, routes)
    if route is None:
        return None
    methods = ','.join(sorted(getattr(route, 'methods', None) or [])) or 'ANY'
    return f'{methods} {route.path}'


def canonical_url(path: str) -> str:
    """Absolute canonical URL, from RR_APP_URL only, never request headers.

    Args:
        path: The page path.

    Returns:
        ``RR_APP_URL`` followed by ``path``, or '' when ``RR_APP_URL`` is unset.
    """
    base = app_url()
    if not base:
        return ''
    return f'{base}{path}'


def _relative_location(request: Request, path: str) -> str:
    """``path`` under the request's ``root_path``, plus its query.

    A Location on this origin, never built from the Host header.
    """
    location = request.scope.get('root_path', '').rstrip('/') + path
    query = request.url.query
    if query:
        return f'{location}?{query}'
    return location


def _router_miss(request: Request) -> Optional[Response]:
    """What the router answered for an unclaimed path before the catch-all existed.

    The catch-all fully matches every path, so the router's own outcomes for
    a miss are re-derived here: a path some real route serves with other
    methods is a 405 (with Allow), and a path whose trailing-slash twin is
    served is a 307 to it (Starlette's redirect_slashes, with a relative
    Location instead of one built from the Host header). Otherwise None
    (a 404).

    Raises:
        HTTPException: 405, with ``Allow``, for a path a real route serves with other methods.
    """
    server = _web_server
    if server is None:
        return None
    path = route_path(request.scope)
    # The router skips a route it cannot match on the path (a Host), and so does this.
    routes = [
        r
        for r in _real_routes(server)
        if getattr(r, 'path_regex', None) is not None and getattr(r, 'endpoint', None) is not public_page
    ]
    route = _first_route_matching(path, routes)
    if route is not None:
        methods = sorted(getattr(route, 'methods', None) or [])
        headers = None
        if methods:
            headers = {'Allow': ', '.join(methods)}
        raise HTTPException(status_code=405, detail='Method Not Allowed', headers=headers)
    # A relative Location starting with '//' is protocol-relative: off-site.
    if path == '/' or path.startswith('//'):
        return None
    twin = with_slash_twin(path)[1]
    if twin in public_pages.current().exact or _first_route_matching(twin, routes) is not None:
        return RedirectResponse(_relative_location(request, twin), status_code=307)
    return None


class _FifoCache:
    """An insertion-ordered cache bounded by total size in bytes and by entry count.

    The oldest entries are evicted first until a new one fits. A value larger
    than the whole budget is never stored.
    """

    def __init__(self, max_bytes: int, max_entries: int = sys.maxsize) -> None:
        self.max_bytes = max_bytes
        self.max_entries = max_entries
        self.total = 0
        self._entries: Dict[Any, Tuple[Any, int]] = {}

    def __len__(self) -> int:
        return len(self._entries)

    def __contains__(self, key: Any) -> bool:
        return key in self._entries

    def keys(self) -> List[Any]:
        """The keys, oldest first."""
        return list(self._entries)

    def get(self, key: Any) -> Any:
        """The value stored under ``key``, or None."""
        hit = self._entries.get(key)
        if hit is None:
            return None
        return hit[0]

    def put(self, key: Any, value: Any, size: int) -> None:
        """Store ``value`` (``size`` bytes), evicting the oldest entries until it fits."""
        if size > self.max_bytes:
            return
        self.discard(key)
        while self._entries and (self.total + size > self.max_bytes or len(self._entries) >= self.max_entries):
            self.discard(next(iter(self._entries)))
        self._entries[key] = (value, size)
        self.total += size

    def clear(self) -> None:
        """Drop every entry."""
        self._entries.clear()
        self.total = 0

    def discard(self, key: Any) -> None:
        hit = self._entries.pop(key, None)
        if hit is not None:
            self.total -= hit[1]


# Rendered page responses: (path, UA class, shell document, its mtime and size,
# RR_APP_URL) -> (data entries bound, expiry on the monotonic clock, body
# bytes, headers). Cleared on every aggregate swap; an entry bound to a data
# source is dropped when that source is invalidated.
_RENDER_CACHE_MAX_BYTES = 32 * 1024 * 1024
_RENDER_CACHE_MAX = 4096
_render_cache = _FifoCache(_RENDER_CACHE_MAX_BYTES, _RENDER_CACHE_MAX)

# Shell documents by (page path, request has a query): (document, its mtime
# and size). Finding the route's capture walks the disk (resolve, is_file),
# so it runs once per page and shell build: a request re-checks only the
# document's stat, which a new build changes. Bounded by the page map and
# cleared on every swap.
# shortcut: a capture added without rewriting the cached document is served from the next swap on.
_documents: Dict[Tuple[str, bool], Tuple[Path, int, int]] = {}

# Bumped by every swap and data-source invalidation: a render that started
# before one is served, not cached.
_generation = 0


def _clear_rendered(old: Any, new: Any) -> None:
    """Swap listener (installed by ``register_public_pages``): renders and resolved documents of the previous page map are stale."""
    global _generation
    _generation += 1
    _render_cache.clear()
    _documents.clear()


def _drop_rendered_for(source: str) -> None:
    global _generation
    _generation += 1
    for key in _render_cache.keys():
        if any(data_sources.source_name(entry) == source for entry in _render_cache.get(key)[0]):
            _render_cache.discard(key)


# Snapshot bytes by store path. A version's build output never changes, so
# entries are only ever evicted, never invalidated.
_SNAPSHOT_CACHE_MAX_BYTES = 16 * 1024 * 1024
_snapshot_cache = _FifoCache(_SNAPSHOT_CACHE_MAX_BYTES)

# Store paths of snapshots that can never render: over MAX_SNAPSHOT_BYTES, or a
# template the engine refuses. A version's build output never changes, so each
# is warned about once and never read again, across swaps too.
_UNUSABLE_SNAPSHOTS_MAX = 1024
_unusable_snapshots = _FifoCache(_UNUSABLE_SNAPSHOTS_MAX, _UNUSABLE_SNAPSHOTS_MAX)

# Store path -> when (monotonic seconds) its last storage failure was warned
# about. While a store is down every crawler request retries the read, so each
# path warns at most once per interval, not once per request.
_STORAGE_WARNING_INTERVAL = 300.0
_STORAGE_WARNED_MAX = 1024
_storage_warned = _FifoCache(_STORAGE_WARNED_MAX, _STORAGE_WARNED_MAX)

# How long a crawler request waits for a snapshot the snapshot cache does not
# hold. The S3 store retries a failing read for minutes, each try holding a
# worker thread; past this the crawler gets the shell document, uncached.
_SNAPSHOT_READ_SECONDS = 5.0


class _SnapshotTooLarge(Exception):
    """A stored snapshot over ``MAX_SNAPSHOT_BYTES`` (never read)."""


def snapshot_path(page: Page) -> str:
    """The store path of a page's snapshot inside its production version's build output.

    The snapshot grammar (a relative path without dot segments, re-checked
    here) keeps the path inside that tree.

    Args:
        page: A page of the aggregate, with its production version's
            ``dist_dir`` and ``version``.

    Returns:
        The snapshot's store path, ``<dist_dir>/<snapshot>``.

    Raises:
        ValueError: the page has no production version, or the snapshot path
            is malformed.
    """
    if not page.dist_dir or page.version is None:
        raise ValueError('the page has no production version to read a snapshot from')
    if snapshot_error(page.snapshot):
        raise ValueError(f'unusable snapshot path {page.snapshot!r}')
    return f'{page.dist_dir.rstrip("/")}/{page.snapshot}'


def assets_base(page: Page) -> str:
    """The URL of the page's production build output: the snapshot's ``{{assets}}``.

    Args:
        page: A page of the aggregate, with its production ``version``.

    Returns:
        ``/apps/<appId>/v<N>``, where that version's build output is served.
    """
    return f'/apps/{page.app_id}/v{page.version}'


async def _snapshot_bytes(path: str) -> bytes:
    """The snapshot at store ``path``, from the snapshot cache or the store.

    On a miss the file is sized by a stat first, so a snapshot over the cap
    is never downloaded.

    Raises:
        _SnapshotTooLarge: the stored file is over ``MAX_SNAPSHOT_BYTES``.
        StorageError: a storage failure (``StorageNotFoundError`` included),
            or no answer from the store within ``_SNAPSHOT_READ_SECONDS``.
    """
    raw = _snapshot_cache.get(path)
    if raw is None:
        try:
            raw = await asyncio.wait_for(_stored_snapshot(path), _SNAPSHOT_READ_SECONDS)
        except asyncio.TimeoutError as exc:
            raise StorageError(f'the store did not answer within {_SNAPSHOT_READ_SECONDS:g} s') from exc
        _snapshot_cache.put(path, raw, len(raw))
    return raw


async def _stored_snapshot(path: str) -> bytes:
    """Read the snapshot at store ``path`` after a stat, so one over the cap is never downloaded.

    Raises:
        _SnapshotTooLarge: the stored file is over ``MAX_SNAPSHOT_BYTES``.
        StorageError: a storage failure (``StorageNotFoundError`` included).
    """
    size = (await public_pages.artifact_file_info(path))['size']
    if size > MAX_SNAPSHOT_BYTES:
        raise _SnapshotTooLarge(f'{size} bytes, over the {MAX_SNAPSHOT_BYTES}-byte limit')
    return await public_pages.read_artifact_file(path)


async def _page_data(page: Page, canonical: str) -> Tuple[Dict[str, Any], bool]:
    """The page's bound data sources: ``(context, complete)``.

    A source that cannot be read is logged as a warning and leaves the page
    without any of its data, uncached, so the next request tries again.
    """
    try:
        return await data_sources.bind(page, canonical), True
    except Exception as exc:
        warning(f'[public_pages] {page.path}: data {list(page.data)} unavailable, serving without it: {exc}')
    return {}, False


def _warn_fallback(page: Page, reason: Any) -> None:
    """Log that crawlers get the shell document in place of the page's snapshot."""
    warning(f'[public_pages] {page.path}: snapshot {page.snapshot!r} unavailable, serving the shell document: {reason}')


async def _crawler_snapshot(page: Page, context: Dict[str, Any]) -> Tuple[Optional[str], bool]:
    """The page's snapshot rendered with ``context``, or None for the shell document: ``(html, cacheable)``.

    A fallback is cacheable when it is final for the page's version: no
    snapshot, a malformed snapshot path or no production version, a snapshot
    over ``MAX_SNAPSHOT_BYTES``, or a template the engine refuses (the last
    two are remembered by store path and warned about once). A storage
    failure (a snapshot the store does not have yet, or no answer within
    ``_SNAPSHOT_READ_SECONDS``, included) falls back uncached, so the next request tries again, and is warned about at most
    once per store path per ``_STORAGE_WARNING_INTERVAL``. Anything else is
    a bug and propagates.

    Args:
        page: A page of the aggregate.
        context: The page's bound data sources (``_page_data``).

    Returns:
        ``(html, cacheable)``: the rendered snapshot, or None when crawlers
        get the shell document, and whether the render cache may keep it.
    """
    if not page.snapshot:
        return None, True
    try:
        path = snapshot_path(page)
    except ValueError as exc:
        _warn_fallback(page, exc)
        return None, True
    if path in _unusable_snapshots:
        return None, True
    try:
        raw = await _snapshot_bytes(path)
        # A 2 MiB snapshot takes tens of milliseconds to render: off the event loop.
        html = await asyncio.to_thread(
            render, raw.decode('utf-8', errors='replace'), {**context, 'assets': assets_base(page)}
        )
        return html, True
    except (_SnapshotTooLarge, TemplateError) as exc:
        _unusable_snapshots.put(path, True, 1)
        _warn_fallback(page, exc)
        return None, True
    except StorageError as exc:
        if _storage_warning_due(path):
            _warn_fallback(page, exc)
        return None, False


def _storage_warning_due(path: str) -> bool:
    """Whether a storage failure reading ``path`` is warned about now; if so, not again for an interval.

    Args:
        path: The snapshot's store path.

    Returns:
        True when ``path`` has no storage failure warned about in the last
        ``_STORAGE_WARNING_INTERVAL`` seconds.
    """
    now = monotonic()
    last = _storage_warned.get(path)
    if last is not None and now - last < _STORAGE_WARNING_INTERVAL:
        return False
    _storage_warned.put(path, now, 1)
    return True


def _moved(request: Request, path: str) -> Response:
    """301 to ``path`` on this origin with the request's query kept.

    The Location is relative, never built from the Host header. ``path`` is
    a validated page path, so it never starts with ``//`` (a
    protocol-relative open redirect).
    """
    return RedirectResponse(
        _relative_location(request, path), status_code=301, headers={'Cache-Control': _REDIRECT_CACHE_CONTROL}
    )


async def public_page(request: Request) -> Response:
    """Serve one public page, or the router's own answer for a path no page claims; also mounted on ``/``.

    One helper per outcome, in order: a method other than GET and HEAD, a
    redirect, a path no page claims, then the page itself. ``/`` keeps its
    dedicated route: when the aggregate does not claim it, it serves the
    shell exactly as ``shell_static`` does.

    Args:
        request: The request. Its path as the router matched it (``root_path``
            stripped) is the one the auth middleware decided on.

    Returns:
        The page, a 301 to a page, the shell on an unclaimed ``/``, or the
        router's 307 to a served trailing-slash twin.

    Raises:
        HTTPException: 404 for a path nothing serves; 405, with ``Allow``, for
            a method the page, redirect or real route does not take; 503
            (from ``shell_document_path``) when the shell is not built.
    """
    path = route_path(request.scope) or '/'
    aggregate = public_pages.current()
    # HEAD is GET without the body (the server drops it; status and headers
    # stay identical): link checkers and unfurl prefetches send it.
    if request.method not in ('GET', 'HEAD'):
        return _other_method(request, path, aggregate)
    public_pages.maybe_refresh()  # schedules only: the swap lands on a later request
    moved = _redirect(request, path, aggregate)
    if moved is not None:
        return moved
    page = aggregate.exact.get(path)
    if page is None:
        return await _unclaimed(request, path)
    return await _render_page(request, path, page)


def _other_method(request: Request, path: str, aggregate: public_pages.Aggregate) -> Response:
    """A method other than GET and HEAD: pages and redirects refuse it; any other path gets the router's answer.

    Returns:
        The router's 307 to a served trailing-slash twin.

    Raises:
        HTTPException: 405 with ``Allow: GET, HEAD`` on ``/``, a page or a
            redirect source; the router's 405 on a real route's path; else 404.
    """
    if path == '/' or path in aggregate.exact or path in aggregate.redirects:
        raise HTTPException(status_code=405, detail='Method Not Allowed', headers={'Allow': 'GET, HEAD'})
    miss = _router_miss(request)
    if miss is None:
        raise HTTPException(status_code=404, detail='Not Found')
    return miss


def _redirect(request: Request, path: str, aggregate: public_pages.Aggregate) -> Optional[Response]:
    """The 301 for a redirect source (``site.redirects``) or a page's trailing-slash twin, else None."""
    target = aggregate.redirects.get(path)
    if target is not None:
        return _moved(request, target)
    # A page's trailing-slash twin: one permanent URL per page. No page path
    # ends with a slash, so a twin is never a page itself.
    if path.endswith('/') and path[:-1] in aggregate.exact:
        return _moved(request, path[:-1])
    return None


async def _unclaimed(request: Request, path: str) -> Response:
    """A GET or HEAD on a path no page claims: the shell on ``/``, else what the router answered before the catch-all.

    Returns:
        The shell on ``/``, or the router's 307 to a served trailing-slash twin.

    Raises:
        HTTPException: the router's 405 on a real route's path, else 404.
    """
    if path == '/':
        return await shell_static(request)
    miss = _router_miss(request)
    if miss is None:
        raise HTTPException(status_code=404, detail='Not Found')
    return miss


async def _render_page(request: Request, path: str, page: Page) -> Response:
    """The page from the render cache, rendered off the event loop on a miss.

    Keyed by (path, UA class, shell document, its mtime and size,
    ``RR_APP_URL``), so a new shell build or origin renders afresh. A
    crawler's copy is the page's rendered snapshot (``_crawler_snapshot``). A
    render that falls back uncacheably, or that a swap overtook, is served,
    not cached.

    Returns:
        The page's response.

    Raises:
        HTTPException: 503 (from ``shell_document_path``) when the shell is not built.
    """
    crawler = classify(request.headers.get('user-agent', '')) == CRAWLER
    document, mtime_ns, size = _shell_document(request, path)
    key = (path, crawler, document, mtime_ns, size, app_url())
    now = time.monotonic()
    cached = _render_cache.get(key)
    if cached is None or cached[1] <= now:
        generation = _generation
        cached, cacheable = await _render(path, page, crawler, document, now)
        if cacheable and generation == _generation:
            _render_cache.put(key, cached, len(cached[2]))
    headers = dict(cached[3])
    if cached[0] and headers['Cache-Control'] == CACHE_CONTROL:
        # A shared cache keeps bound data no longer than this server would.
        headers['Cache-Control'] = f'public, max-age={math.ceil(cached[1] - now)}'
    return HTMLResponse(cached[2], headers=headers)


def _shell_document(request: Request, path: str) -> Tuple[Path, int, int]:
    """The shell document this page request boots from, with its mtime and size (see ``_documents``).

    Args:
        request: The page request; whether it carries a query decides if a capture may serve.
        path: The page path (``route_path``, ``/`` for an empty one).

    Returns:
        ``(document, mtime_ns, size)``.

    Raises:
        HTTPException: 503 (from ``shell_document_path``) when the shell is not built.
    """
    key = (path, bool(request.url.query))
    hit = _documents.get(key)
    if hit is not None and _unchanged(*hit):
        return hit
    document = shell_document_path(request)
    stat = document.stat()
    _documents[key] = (document, stat.st_mtime_ns, stat.st_size)
    return _documents[key]


def _unchanged(document: Path, mtime_ns: int, size: int) -> bool:
    """Whether ``document`` still has this mtime and size; False once it is gone."""
    try:
        stat = document.stat()
    except OSError:
        return False
    return stat.st_mtime_ns == mtime_ns and stat.st_size == size


async def _render(
    path: str, page: Page, crawler: bool, document: Path, now: float
) -> Tuple[Tuple[Tuple[str, ...], float, bytes, Dict[str, str]], bool]:
    """Render one page: ``((sources, expires, body, headers), cacheable)``, the entry as the render cache holds it.

    People get the shell document; crawlers get the page's snapshot rendered
    with its bound data sources (``_crawler_snapshot``), or the shell document
    when there is none to serve. Either way the page's head metadata is
    injected, plus the sources' JSON-LD for crawlers; reading the shell
    document and rewriting the head run off the event loop. A render bound to
    a source expires ``data_sources.TTL_SECONDS`` after ``now``. ``cacheable``
    is False for a fallback the next request should retry.
    """
    canonical = canonical_url(path)
    # Only crawlers bind data: people get the shell document, which the
    # app renders itself.
    sources = page.data if crawler else ()
    context, cacheable = await _page_data(page, canonical) if sources else ({}, True)
    snapshot = None
    if crawler:
        snapshot, rendered = await _crawler_snapshot(page, context)
        cacheable = cacheable and rendered
    # Only a rendered snapshot this server keeps may sit in shared caches: the
    # shell document names the current build's bundles. Caches key on the UA.
    body = snapshot
    cache_control = 'private, no-cache'
    if body is None:
        body = await asyncio.to_thread(document.read_text, encoding='utf-8')
    elif cacheable:
        cache_control = CACHE_CONTROL
    body = await asyncio.to_thread(
        inject_head,
        body,
        title=page.head_title or page.title,
        description=page.description,
        canonical=canonical,
        noindex=not page.listed,
        jsonld=data_sources.jsonld(context, canonical),
    )
    headers = {'Vary': 'User-Agent', 'Cache-Control': cache_control}
    if not page.listed:
        headers['X-Robots-Tag'] = 'noindex'
    expires = now + data_sources.TTL_SECONDS if sources else math.inf
    return (sources, expires, body.encode('utf-8'), headers), cacheable


async def register_public_pages(server: WebServer) -> None:
    """Register the catch-all last, drop renders on every swap and data-source invalidation, and build the first aggregate.

    Call once, at the end of server startup, after every module's initModule
    and the account layer's init_account, and before serving. Routes that
    ``add_route`` registers later still match first: it keeps the catch-all last.

    Until the first build lands (it is bounded, see
    ``public_pages.build_at_startup``), the legacy page list serves, filtered
    against the now-complete route table so no legacy page opens a real
    route to anonymous callers.

    Args:
        server: The web server, its route table complete.
    """
    # Not an API operation, so a plain route outside the schema. It takes every
    # method, unknown ones (TRACE, PROPFIND) included: with a method list, the
    # router would answer any other method on any path with its partial match
    # (405, not 404), and a non-GET route appended after it (straight to
    # ``router.routes``; ``add_route`` keeps the catch-all last) would fully
    # match a claimed path that the auth predicate already exempted.
    # Starlette defaults a function endpoint to GET and HEAD, hence the
    # override; test_unknown_methods_404_off_pages_and_405_on_them pins it.
    route = Route(FALLBACK_PATH, public_page, include_in_schema=False)
    route.methods = None
    # Before the first swap, so no render outlives the page map it came from.
    public_pages.on_swap(_clear_rendered)
    data_sources.on_invalidate(_drop_rendered_for)
    server.add_catch_all(route)
    public_pages.swap(public_pages.legacy_aggregate(public_pages.live_conflict()))
    await public_pages.build_at_startup()
