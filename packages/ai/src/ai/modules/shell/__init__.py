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
    GET /shell/{file_path:path}     — shell assets (JS, CSS, themes)
    GET /apps/{file_path:path}      — MF remote app bundles
"""

from typing import Any, Dict

from ai.web import WebServer
from .shell import shell_static, apps_static


def initModule(server: WebServer, config: Dict[str, Any]):
    """
    Initialize the shell module by registering routes with the web server.

    All routes are public because the shell handles authentication
    client-side — the server only needs to deliver static assets.

    Args:
        server: The WebServer instance where routes will be registered.
        config: Configuration settings (currently unused).
    """
    # ── Shell SPA entry point ────────────────────────────────────────────
    # Bare "/" serves index.html — the shell's HTML entry point.
    server.add_route(
        path='/',
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
