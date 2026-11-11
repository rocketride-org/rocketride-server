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

A page is the document the shell boots from (the route's prerendered
capture when the shell build carries one, else ``index.html``) with the
page's head metadata injected (title, description, canonical URL, robots),
for people and crawlers alike, so the shell boots and routes as before.

Rendered responses are cached per (path, UA class) under a byte budget and
dropped on every aggregate swap.
"""

import asyncio
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple

from fastapi import HTTPException
from fastapi.responses import HTMLResponse, RedirectResponse, Response
from starlette.routing import Route, WebSocketRoute

from ai.web import Request, WebServer
from ai.web.middleware import route_path

from . import public_pages
from .contract import Page, with_slash_twin
from .crawlers import CRAWLER, classify
from .head import inject_head
from .settings import app_url
from .shell import shell_document_path, shell_static

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

    def __init__(self, max_bytes: int, max_entries: int) -> None:
        self.max_bytes = max_bytes
        self.max_entries = max_entries
        self.total = 0
        self._entries: Dict[Any, Tuple[Any, int]] = {}

    def __len__(self) -> int:
        return len(self._entries)

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
        self._drop(key)
        while self._entries and (self.total + size > self.max_bytes or len(self._entries) >= self.max_entries):
            self._drop(next(iter(self._entries)))
        self._entries[key] = (value, size)
        self.total += size

    def clear(self) -> None:
        """Drop every entry."""
        self._entries.clear()
        self.total = 0

    def _drop(self, key: Any) -> None:
        hit = self._entries.pop(key, None)
        if hit is not None:
            self.total -= hit[1]


# Rendered page responses: (path, UA class, shell document, its mtime and size,
# RR_APP_URL) -> (body bytes, headers). Cleared on every aggregate swap, so
# the shell file is read and rewritten once per page, UA class and build.
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

# Bumped by every swap: a render that started before one is served, not cached.
_generation = 0


def _clear_rendered(old: Any, new: Any) -> None:
    """Swap listener (installed by ``register_public_pages``): renders and resolved documents of the previous page map are stale."""
    global _generation
    _generation += 1
    _render_cache.clear()
    _documents.clear()


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
    ``RR_APP_URL``), so a new shell build or origin renders afresh. A render
    that a swap overtook is served, not cached.

    Returns:
        The page's response.

    Raises:
        HTTPException: 503 (from ``shell_document_path``) when the shell is not built.
    """
    crawler = classify(request.headers.get('user-agent', '')) == CRAWLER
    document, mtime_ns, size = _shell_document(request, path)
    key = (path, crawler, document, mtime_ns, size, app_url())
    cached = _render_cache.get(key)
    if cached is None:
        generation = _generation
        cached = await asyncio.to_thread(_render, path, page, crawler, document)
        if generation == _generation:
            _render_cache.put(key, cached, len(cached[0]))
    return HTMLResponse(cached[0], headers=dict(cached[1]))


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


def _render(path: str, page: Page, crawler: bool, document: Path) -> Tuple[bytes, Dict[str, str]]:
    """Render one page as the render cache holds it: ``(body, headers)``.

    The body is the shell document with the page's head metadata injected.
    """
    body = inject_head(
        document.read_text(encoding='utf-8'),
        title=page.head_title or page.title,
        description=page.description,
        canonical=canonical_url(path),
        noindex=not page.listed,
    )
    # No shared cache may keep either class's copy: the document names the
    # current build's hashed bundles, which a deploy removes. Caches key on the UA.
    headers = {'Vary': 'User-Agent', 'Cache-Control': 'private, no-cache'}
    if not page.listed:
        headers['X-Robots-Tag'] = 'noindex'
    return body.encode('utf-8'), headers


async def register_public_pages(server: WebServer) -> None:
    """Register the catch-all last, drop renders on every swap, and build the first aggregate.

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
    server.add_catch_all(route)
    public_pages.swap(public_pages.legacy_aggregate(public_pages.live_conflict()))
    await public_pages.build_at_startup()
