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
reach here. Pages answer GET and HEAD (405 otherwise). A page's
trailing-slash twin answers GET and HEAD with a 301 to the page; any other
path the aggregate does not claim answers what the router answered before
the catch-all existed: 405, 307 or 404.

Auth: the catch-all is not a public route, which would open every path,
private API routes included, to anonymous callers. The web server consults
``is_public_path`` per request instead: only paths no real route matches
(the catch-all answers them with a page, a redirect or a 404) skip
authentication; a path any real route matches still needs credentials.

A page is the document the shell boots from (the route's prerendered
capture when the shell build carries one, else ``index.html``) with the
page's head metadata injected (title, description, canonical URL, robots),
for people and crawlers alike, so the shell boots and routes as before.
"""

from typing import Any, Optional

from fastapi import HTTPException
from fastapi.responses import HTMLResponse, RedirectResponse, Response
from starlette.routing import Route, WebSocketRoute

from ai.web import Request

from . import public_pages
from .crawlers import CRAWLER, classify
from .head import inject_head
from .shell import _CACHE_CONTROL, _app_url, shell_document_path, shell_static

# The web server whose route table the auth predicate and the live-route
# collision check read (set by initModule).
_web_server: Any = None

# Path parameter name of the catch-all (distinctive, so no handler signature
# ever collides with it).
FALLBACK_PATH = '/{public_page_path:path}'

# Bounds how long browsers keep a 301: page paths are manifest data that can
# change, and an unbounded 301 is cached indefinitely.
_REDIRECT_CACHE_CONTROL = 'public, max-age=86400'


def _real_routes(server: Any) -> list:
    """The server's HTTP routes in match order (websocket routes never match an HTTP request)."""
    return [r for r in server.app.router.routes if not isinstance(r, WebSocketRoute)]


def is_public_path(path: str) -> bool:
    """Auth-middleware predicate: will a page handler answer this path?

    True when the first route whose pattern matches the path is a page
    handler (``/`` or the catch-all). Those answer only public outcomes (a
    page, a redirect or a 404), so an anonymous caller gets those instead of
    a 401. A path any real route's pattern matches stays private, whatever
    the aggregate claims. A route the check cannot reason about (no path
    pattern) fails closed.
    """
    for route in _real_routes(_web_server):
        regex = getattr(route, 'path_regex', None)
        if regex is None:
            return False
        if regex.match(path):
            return getattr(route, 'endpoint', None) is public_page
    return False


def live_route_conflict(path: str) -> Optional[str]:
    """The live route a page path would collide with ('GET /status'), or None.

    Reads the web server's current route table: the real routes every module
    and the account layer registered. The page handlers themselves (``/`` and
    the catch-all) are the claim space, not conflicts.
    """
    server = _web_server
    if server is None:
        return None
    for route in server.app.router.routes:
        route_path = getattr(route, 'path', None)
        if not route_path or getattr(route, 'endpoint', None) is public_page:
            continue
        regex = getattr(route, 'path_regex', None)
        if regex is not None and regex.match(path):
            methods = ','.join(sorted(getattr(route, 'methods', None) or [])) or 'ANY'
            return f'{methods} {route_path}'
    return None


def canonical_url(path: str) -> str:
    """Absolute canonical URL, from RR_APP_URL only, never request headers ('' when unset)."""
    base = _app_url()
    return f'{base}{path}' if base else ''


def _relative_location(request: Request, path: str) -> str:
    """``path`` plus the request's query: a Location on this origin, never built from the Host header."""
    query = request.url.query
    return f'{path}?{query}' if query else path


def _router_miss(request: Request) -> Optional[Response]:
    """What the router answered for an unclaimed path before the catch-all existed.

    The catch-all fully matches every path, so the router's own outcomes for
    a miss are re-derived here: a path some real route serves with other
    methods is a 405 (with Allow), and a path whose trailing-slash twin is
    served is a 307 to it (Starlette's redirect_slashes, with a relative
    Location instead of one built from the Host header). Otherwise None
    (a 404).
    """
    server = _web_server
    if server is None:
        return None
    path = request.url.path
    routes = [r for r in _real_routes(server) if getattr(r, 'endpoint', None) is not public_page]
    for route in routes:
        regex = getattr(route, 'path_regex', None)
        if regex is not None and regex.match(path):
            methods = sorted(getattr(route, 'methods', None) or [])
            raise HTTPException(
                status_code=405, detail='Method Not Allowed', headers={'Allow': ', '.join(methods)} if methods else None
            )
    # A relative Location starting with '//' is protocol-relative: off-site.
    if path != '/' and not path.startswith('//'):
        twin = path[:-1] if path.endswith('/') else path + '/'
        served = twin in public_pages.current().exact
        served = served or any(getattr(r, 'path_regex', None) and r.path_regex.match(twin) for r in routes)
        if served:
            return RedirectResponse(_relative_location(request, twin), status_code=307)
    return None


def _not_found() -> Any:
    raise HTTPException(status_code=404, detail='Not Found')


def _moved(request: Request, path: str) -> Response:
    """301 to ``path`` on this origin with the request's query kept.

    The Location is relative, never built from the Host header. ``path`` is
    a validated page path, so it never starts with ``//`` (a
    protocol-relative open redirect).
    """
    return RedirectResponse(
        _relative_location(request, path), status_code=301, headers={'Cache-Control': _REDIRECT_CACHE_CONTROL}
    )


async def public_page(request: Request):
    """Serve one public page (or the router's own answer for a miss); also mounted on ``/``.

    ``/`` keeps its dedicated route: when the aggregate does not claim it,
    it serves the shell exactly as ``shell_static`` does.
    """
    path = request.url.path
    aggregate = public_pages.current()
    # HEAD is GET without the body (the server drops it; status and headers
    # stay identical): link checkers and unfurl prefetches send it.
    if request.method not in ('GET', 'HEAD'):
        # Any other method: pages answer 405; any other path answers what the
        # router would have without the catch-all.
        if path == '/' or path in aggregate.exact:
            raise HTTPException(status_code=405, detail='Method Not Allowed', headers={'Allow': 'GET, HEAD'})
        return _router_miss(request) or _not_found()
    public_pages.maybe_refresh()  # schedules only: the swap lands on a later request
    page = aggregate.exact.get(path)
    if page is None:
        if path == '/':
            return await shell_static(request)
        # A page's trailing-slash twin: one permanent URL per page.
        if path.endswith('/') and path[:-1] in aggregate.exact:
            return _moved(request, path[:-1])
        return _router_miss(request) or _not_found()
    body = inject_head(
        shell_document_path(request).read_text(encoding='utf-8'),
        title=page.head_title or page.title,
        description=page.description,
        canonical=canonical_url(path),
        noindex=not page.listed,
    )
    # Crawler responses may sit in shared caches; people's never do (the
    # document names the current build's bundles), so caches key on the UA.
    crawler = classify(request.headers.get('user-agent', '')) == CRAWLER
    headers = {'Vary': 'User-Agent', 'Cache-Control': _CACHE_CONTROL if crawler else 'private, no-cache'}
    if not page.listed:
        headers['X-Robots-Tag'] = 'noindex'
    return HTMLResponse(body, headers=headers)


async def register_public_pages(server: Any) -> None:
    """Register the catch-all last and build the first aggregate.

    Call at the end of server startup, after every module's initModule and
    the account layer's init_account, and before serving. Routes registered
    after this are shadowed, for every method, by the catch-all.

    Until the first build lands (it is bounded, see
    ``public_pages.build_at_startup``), the legacy page list serves, filtered
    against the now-complete route table so no legacy page opens a real
    route to anonymous callers.
    """
    # Not an API operation, so a plain route outside the schema. It takes every
    # method, unknown ones (TRACE, PROPFIND) included: with a method list, the
    # router would answer any other method on any path with its partial match
    # (405, not 404), and a non-GET route registered after it would still fully
    # match a claimed path that the auth predicate already exempted.
    route = Route(FALLBACK_PATH, public_page, include_in_schema=False)
    route.methods = None
    server.app.router.routes.append(route)
    public_pages.swap(public_pages.legacy_aggregate(public_pages.live_conflict()))
    await public_pages.build_at_startup()
