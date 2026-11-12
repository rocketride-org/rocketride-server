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
Shell module — serves the web shell SPA and built-in app bundles.

Registers public HTTP routes so the shell can be loaded by browsers
without authentication. The shell itself handles auth in the browser
(APIKEY for OSS, Zitadel OIDC for SaaS). Public pages (``/pricing``,
``/legal/terms``, ...) are data, not routes: published platform apps
declare them (``public_pages``) and one catch-all serves them (``pages``).

Static files:
  - ``static/shell/index.html``           — SPA entry point
  - ``static/shell/static/js/*.js``       — JS bundles
  - ``static/shell/static/css/*.css``     — CSS bundles
  - ``static/shell/themes/*.json``        — theme token files
  - ``static/shell/favicon.svg``          — favicon
  - ``static/apps/<app>/...``             — app ASSETS (icons/readmes); MF
                                            bundles serve store-backed and
                                            versioned, never from this tree

Routes registered:
    GET  /                          — the root public page (or the shell SPA entry point)
    GET  /shell/{file_path:path}    — shell assets (JS, CSS, themes)
    POST /apps/session              — mint the /apps auth cookie
    GET  /apps/{file_path:path}     — app serving, three shapes:
        <appId>/v<N>/<file>         — versioned MF bundle (store-backed)
        <appId>                     — resolution info: what a bundle fetch
                                      would serve THIS caller (the deploy
                                      smoke-test / ops probe)
        anything else               — the static assets tree
    GET  /sitemap.xml               — listed public pages (404 unless RR_APP_URL is set)
    GET  /robots.txt                — robots policy (Disallow-all unless RR_APP_URL is set)
    GET  /llms.txt                  — llmstxt.org index (404 unless RR_APP_URL is set)
                                      (the three crawler files answer HEAD like GET)
    GET  /<RR_INDEXNOW_KEY>.txt     — the IndexNow key file (only with a valid key and an https
                                      RR_APP_URL; answers HEAD like GET; see indexnow.py)
    ANY  /{public_page_path:path}   — the public-page catch-all; registered LAST by
                                      ``register_public_pages`` (end of startup), not here
"""

from typing import Any, Dict

from ai.web import WebServer

from rocketlib import warning

from . import indexnow, pages, public_pages
from .pages import public_page, register_public_pages
from .shell import app_url, shell_static, apps_static, apps_session, sitemap_xml, robots_txt, llms_txt, ungated_noindex

_warned_noindex = False


def _warn_noindex_with_published_pages(old: public_pages.Aggregate, new: public_pages.Aggregate) -> None:
    """Swap listener: warn once that published pages are served with ``noindex`` for lack of ``RR_APP_URL``.

    Args:
        old: The aggregate swapped out (unused).
        new: The aggregate swapped in; the legacy list and an empty map publish nothing.
    """
    global _warned_noindex
    if _warned_noindex or not new.serves_published_pages():
        return
    _warned_noindex = True
    warning(
        '[shell] RR_APP_URL is not set but public pages are published: every response carries '
        'X-Robots-Tag: noindex, nofollow, and robots.txt lets crawlers fetch pages to read it; '
        'set RR_APP_URL on an engine that serves the public site'
    )


__all__ = ['initModule', 'register_public_pages']


def initModule(server: WebServer, config: Dict[str, Any]):
    """
    Initialize the shell module by registering routes with the web server.

    All routes are public because the shell handles authentication
    client-side — the server only needs to deliver static assets.

    Args:
        server: The WebServer instance where routes will be registered.
        config: Configuration settings (currently unused).
    """
    # ── Shell SPA entry point + public pages ────────────────────────────
    # "/" keeps a dedicated route (the shell's HTML entry point). Every other
    # public page is served by ONE catch-all that consults the page aggregate
    # (pages.py), registered LAST by register_public_pages after every module
    # and account route, so real routes always win. Pages are data (published
    # app manifests), not registrations: a publish changes them without a
    # restart.
    server.add_route(
        path='/',
        routeHandler=public_page,
        methods=['GET'],
        public=True,
    )

    # Only paths the catch-all answers skip authentication; the catch-all
    # itself is NOT public (that would open every private API path).
    server.add_public_predicate(pages.is_public_path)

    # The publish gate and the aggregate builder reject page paths that
    # collide with this server's live routes.
    pages.set_web_server(server)
    public_pages.set_live_conflict(pages.live_route_conflict)

    # ── IndexNow ────────────────────────────────────────────────────────
    # With a valid RR_INDEXNOW_KEY and an https RR_APP_URL: the key file
    # (registered here, so ahead of the catch-all) and a submission of the
    # changed pages after each swap.
    if indexnow.enabled():
        for method in ('GET', 'HEAD'):
            server.add_route(
                path=f'/{indexnow.key()}.txt', routeHandler=indexnow.key_file, methods=[method], public=True
            )
        public_pages.on_swap(indexnow.on_swap)

    # ── Shell assets ──────────────────────────────────────────────────
    # Catch-all for everything under /shell/ — JS, CSS, themes, favicon.
    # The handler strips the /shell/ prefix and resolves within
    # dist/server/static/shell/.
    server.add_route(
        path='/shell/{file_path:path}',
        routeHandler=shell_static,
        methods=['GET'],
        public=True,
    )

    # ── App-session cookie (SaaS) ───────────────────────────────────────
    # POST /apps/session stows the caller's token into an /apps-scoped cookie
    # so the browser attaches it to bundle fetches (the shell calls this after
    # a successful connect). Registered BEFORE the catch-all so it isn't
    # swallowed by the bundle server. Trust-free — apps_static does the real
    # per-app permission check on every serve (SaaS only).
    server.add_route(
        path='/apps/session',
        routeHandler=apps_session,
        methods=['POST'],
        public=True,
    )

    # ── MF remote app bundles ───────────────────────────────────────────
    # Serves app bundles from dist/server/static/apps/.
    server.add_route(
        path='/apps/{file_path:path}',
        routeHandler=apps_static,
        methods=['GET'],
        public=True,
    )

    # ── SEO files ───────────────────────────────────────────────────────
    # Root-level crawler files. These must be server routes (not static
    # assets) because shell-ui's assetPrefix pins all static files under
    # /shell/, and the files embed absolute URLs.
    #
    # All three routes are registered in every deployment, but the
    # handlers gate on RR_APP_URL at request time (see shell.py): only the
    # hosted SaaS — where RR_APP_URL pins the public origin — serves
    # sitemap/llms content; OSS, self-hosted, and desktop engines get 404s
    # and a Disallow-all robots policy instead of marketing SEO endpoints.
    #
    # HEAD answers like GET (crawlers and link checkers send it). One route
    # per method keeps each OpenAPI operation id unique.
    for path, handler in (('/sitemap.xml', sitemap_xml), ('/robots.txt', robots_txt), ('/llms.txt', llms_txt)):
        for method in ('GET', 'HEAD'):
            server.add_route(path=path, routeHandler=handler, methods=[method], public=True)

    # ── Engines without RR_APP_URL: noindex everywhere ──────────────────
    # Disallow-all alone does not keep a linked host (a staging deployment)
    # out of search indexes: every response says noindex, nofollow. Added
    # last, so it wraps the auth middleware and covers its refusals too.
    # Only an engine ungated at init registers it: production runs no extra
    # middleware. A production engine that lost RR_APP_URL deindexes its
    # published pages, so it warns at the first swap that has some (OSS and
    # desktop engines publish none and stay quiet).
    if not app_url():
        public_pages.on_swap(_warn_noindex_with_published_pages)
        server.app.middleware('http')(ungated_noindex)
