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

All files live under ``dist/server/static/shell/``:
  - ``shell/index.html``                  — SPA entry point
  - ``shell/static/js/*.js``              — JS bundles
  - ``shell/static/css/*.css``            — CSS bundles
  - ``shell/themes/*.json``               — theme token files
  - ``shell/favicon.svg``                 — favicon
  - ``shell/apps/<app>/remoteEntry.js``   — MF remote app bundles

Routes registered:
    GET /                           — shell SPA entry point (index.html)
    GET /shell/{file_path:path}     — all shell assets, themes, and app bundles
"""

from typing import Any, Dict

from ai.web import WebServer
from .shell import shell_static


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

    # ── All shell assets ────────────────────────────────────────────────
    # Single catch-all route for everything under /shell/ — JS, CSS,
    # themes, favicon, and app bundles.  The handler strips the /shell/
    # prefix and resolves within dist/server/static/shell/.
    server.add_route(
        path='/shell/{file_path:path}',
        routeHandler=shell_static,
        methods=['GET'],
        public=True,
    )
