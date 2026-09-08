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
(APIKEY for OSS, Zitadel OIDC for SaaS).

Static files:
  - ``static/shell/index.html``           — SPA entry point
  - ``static/shell/static/js/*.js``       — JS bundles
  - ``static/shell/static/css/*.css``     — CSS bundles
  - ``static/shell/themes/*.json``        — theme token files
  - ``static/shell/favicon.svg``          — favicon
  - ``static/apps/<app>/remoteEntry.js``  — MF remote app bundles

Routes registered:
    GET /                           — shell SPA entry point (index.html)
    GET /pricing, /store, ...       — shell SPA deep links (see PUBLIC_ROUTES)
    GET /shell/{file_path:path}     — shell assets (JS, CSS, themes)
    GET /apps/{file_path:path}      — MF remote app bundles
    GET /sitemap.xml                — sitemap from PUBLIC_ROUTES (404 unless RR_APP_URL is set)
    GET /robots.txt                 — robots policy (Disallow-all unless RR_APP_URL is set)
    GET /llms.txt                   — llmstxt.org index (404 unless RR_APP_URL is set)
"""

from typing import Any, Dict

from ai.web import WebServer
from .shell import PUBLIC_ROUTES, shell_static, apps_static, sitemap_xml, robots_txt, llms_txt


def initModule(server: WebServer, config: Dict[str, Any]):
    """
    Initialize the shell module by registering routes with the web server.

    All routes are public because the shell handles authentication
    client-side — the server only needs to deliver static assets.

    Args:
        server: The WebServer instance where routes will be registered.
        config: Configuration settings (currently unused).
    """
    # ── Shell SPA entry point + public deep links ────────────────────────
    # Every path in PUBLIC_ROUTES serves index.html: bare "/" is the
    # shell's HTML entry point, and deep links like /pricing must resolve
    # server-side so hard reloads don't 404 before the client-side router
    # takes over. New public pages only need a PUBLIC_ROUTES entry.
    for route in PUBLIC_ROUTES:
        server.add_route(
            path=route,
            routeHandler=shell_static,
            methods=['GET'],
            public=True,
        )

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
    server.add_route(
        path='/sitemap.xml',
        routeHandler=sitemap_xml,
        methods=['GET'],
        public=True,
    )

    server.add_route(
        path='/robots.txt',
        routeHandler=robots_txt,
        methods=['GET'],
        public=True,
    )

    server.add_route(
        path='/llms.txt',
        routeHandler=llms_txt,
        methods=['GET'],
        public=True,
    )
