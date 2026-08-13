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
Shell static file handler.

Serves the shell web application (Module Federation host) from
``dist/server/static/shell/`` and MF remote app bundles from
``dist/server/static/apps/``.

Directory layout:
  - ``static/shell/index.html``              — SPA entry point
  - ``static/shell/static/``                 — JS/CSS bundles
  - ``static/shell/themes/``                 — theme JSON files
  - ``static/shell/favicon.svg``             — favicon
  - ``static/apps/<app>/``                   — MF remote app bundles

Routes:
  GET /                    — shell SPA entry point
  GET /pricing             — shell SPA deep link (see PUBLIC_ROUTES)
  GET /shell/{file_path}   — shell assets (JS, CSS, themes)
  GET /apps/{file_path}    — MF remote app bundles
  GET /sitemap.xml         — sitemap generated from PUBLIC_ROUTES (hosted SaaS only)
  GET /robots.txt          — robots policy (+ sitemap pointer on hosted SaaS)
  GET /llms.txt            — llmstxt.org page index (hosted SaaS only)

The three crawler files key off ``RR_APP_URL`` — the env var that pins the
public base URL of the hosted SaaS deployment. When it is unset (OSS,
self-hosted, desktop engines) /sitemap.xml and /llms.txt return 404 and
/robots.txt disallows all crawling; absolute URLs are never derived from
request headers.
"""

import os
import sys
from pathlib import Path
from xml.sax.saxutils import escape

from fastapi import HTTPException
from fastapi.responses import FileResponse, PlainTextResponse, Response

from ai.web import Request

# Engine binary directory — all static paths are relative to this.
_root_dir = os.path.dirname(sys.executable)

# Shell root: dist/server/static/shell/ — SPA, themes, JS/CSS bundles.
_shell_root = os.path.join(_root_dir, 'static', 'shell')

# Apps root: dist/server/static/apps/ — MF remote app bundles.
_apps_root = os.path.join(_root_dir, 'static', 'apps')

# Public (unauthenticated) SPA paths served by the shell. Each entry gets:
#   - a server-side GET route serving index.html, so hard reloads and
#     shared deep links (e.g. /pricing) don't 404 before the client-side
#     router can take over;
#   - a <url> entry in the generated /sitemap.xml;
#   - a bullet in the generated /llms.txt.
#
# Titles and descriptions mirror the client route manifest in
# apps/home-ui/src/routes.ts (rocketride-saas) verbatim — keep them in
# sync. To expose another home-ui page, add a (path, title, description)
# entry here — no other code changes needed. This list will eventually be
# fed from a shared manifest of deployed apps.
PUBLIC_ROUTE_MANIFEST = [
    (
        '/',
        'Home',
        'Build, run, and harness AI at rocket speed. From prototype to production. '
        'Fully managed, predictable costs, true portability.',
    ),
    (
        '/pricing',
        'Pricing',
        'Predictable pricing that scales with you. Managed cloud with usage-based '
        'token pricing. No hard caps, no surprise bills, no vendor lock-in.',
    ),
    (
        '/store',
        'App Store',
        'Ready-to-run AI apps built on RocketRide. Browse the catalog, try apps '
        'instantly, and deploy them on managed infrastructure.',
    ),
    (
        '/oss',
        'Open Source',
        'Design, run, and deploy AI pipelines visually. Open source, self-hostable, and free to run anywhere.',
    ),
    (
        '/cloud',
        'Cloud',
        'Run and scale your AI pipelines on managed cloud infrastructure. No servers '
        'to run, no capacity to plan, no lock-in.',
    ),
    (
        '/mcp',
        # NOTE: /mcp is also a plausible future API path (Model Context Protocol
        # endpoint). server.add_route() rejects duplicate (method, path)
        # registrations, so a clash would fail loudly at startup rather than
        # silently shadowing one side.
        'MCP',
        'Connect tools and data to your AI with the Model Context Protocol. Bring '
        'your own servers or use the ones RocketRide ships with.',
    ),
]

# Bare route list — kept as the module's public surface for route
# registration and the sitemap.
PUBLIC_ROUTES = [route for route, _, _ in PUBLIC_ROUTE_MANIFEST]

# Canonical docs site, linked from /llms.txt.
DOCS_URL = 'https://docs.rocketride.org/'

# Crawler files are cheap to regenerate but change rarely — let shared
# caches hold them for an hour (same max-age convention as task/fetch.py).
_CACHE_CONTROL = 'public, max-age=3600'


def _resolve_safe(base_dir: str, requested_path: str) -> Path:
    """
    Resolve a requested path within a base directory, guarding against
    path traversal attacks.

    Args:
        base_dir: Absolute path to the allowed root directory.
        requested_path: Relative path from the URL (may contain ``../``).

    Returns:
        Resolved Path within base_dir, or base_dir/index.html as fallback.
    """
    try:
        file_path = (Path(base_dir) / requested_path).resolve()
        root_path = Path(base_dir).resolve()

        # Traversal attempt — fall back to index.html
        if not file_path.is_relative_to(root_path):
            return root_path / 'index.html'

        return file_path
    except Exception:
        # Any resolution error — safe fallback
        return Path(base_dir) / 'index.html'


async def shell_static(request: Request):
    """
    Serve static files for the shell SPA with client-side routing fallback.

    Handles both ``GET /`` (serves index.html) and ``GET /shell/{path}``
    (strips the prefix and resolves within the shell root directory).

    Args:
        request: Incoming HTTP request.

    Returns:
        FileResponse for the matched file or index.html fallback.

    Raises:
        HTTPException: 503 if the shell has not been built.
    """
    # Map the URL path into the shell directory.
    # "/" → index.html
    # "/shell/static/js/main.js" → static/js/main.js
    # "/shell/themes/dark.json" → themes/dark.json
    raw_path = request.url.path.lstrip('/')

    # Strip the "shell/" prefix for shell-specific routes
    if raw_path.startswith('shell/'):
        raw_path = raw_path[len('shell/') :]

    # Default bare "/" to index.html
    if not raw_path:
        raw_path = 'index.html'

    # Resolve safely within the shell root
    file_path = _resolve_safe(_shell_root, raw_path)

    # Serve the file if it exists
    if file_path.exists() and file_path.is_file():
        return FileResponse(file_path)

    # SPA fallback: serve index.html for any unmatched route so that
    # client-side routing (React Router, etc.) can handle it.
    index_path = Path(_shell_root) / 'index.html'
    if index_path.exists() and index_path.is_file():
        return FileResponse(index_path)

    # Shell hasn't been built yet
    raise HTTPException(
        status_code=503,
        detail='Shell UI not built. Run: ./builder shell:build',
    )


async def apps_static(request: Request):
    """
    Serve MF remote app bundles from ``dist/server/static/apps/``.

    Handles ``GET /apps/{path}`` — resolves the path within the apps root
    and returns the file directly. No SPA fallback (these are JS/CSS assets).

    Args:
        request: Incoming HTTP request.

    Returns:
        FileResponse for the matched file.

    Raises:
        HTTPException: 404 if file not found, 503 if apps dir missing.
    """
    # "/apps/home-ui/remoteEntry.js" → home-ui/remoteEntry.js
    raw_path = request.url.path.lstrip('/')
    if raw_path.startswith('apps/'):
        raw_path = raw_path[len('apps/') :]

    if not raw_path:
        raise HTTPException(status_code=404, detail='Not found')

    # Apps haven't been built/copied yet — surface a clearer signal.
    if not os.path.isdir(_apps_root):
        raise HTTPException(status_code=503, detail='App bundles not built. Run the app build/copy step.')
    # Resolve safely within the apps root
    file_path = _resolve_safe(_apps_root, raw_path)

    # Serve the file if it exists
    if file_path.exists() and file_path.is_file():
        return FileResponse(file_path)

    raise HTTPException(status_code=404, detail='Not found')


def _app_url() -> str:
    """
    Return the public base URL of the hosted SaaS deployment, if configured.

    ``RR_APP_URL`` (also honored by ``ai.web.endpoints.auth_callback``) pins
    the externally visible origin and doubles as the "this is the hosted
    SaaS" signal. It is deliberately the ONLY source of absolute URLs here:
    deriving them from ``X-Forwarded-Proto`` / ``X-Forwarded-Host`` would
    let any client poison sitemap URLs through shared caches.

    Returns:
        Base URL without a trailing slash (e.g. ``https://app.example.com``),
        or an empty string when unset.
    """
    return os.environ.get('RR_APP_URL', '').rstrip('/')


async def sitemap_xml(request: Request):
    """
    Serve ``/sitemap.xml`` — one ``<url>`` per entry in ``PUBLIC_ROUTES``.

    Absolute URLs come exclusively from ``RR_APP_URL``. Deployments without
    it (OSS, self-hosted, desktop) have no public marketing site to index,
    so the endpoint 404s.

    Args:
        request: Incoming HTTP request.

    Returns:
        Response with an XML urlset and ``application/xml`` content type.

    Raises:
        HTTPException: 404 when ``RR_APP_URL`` is not configured.
    """
    base_url = _app_url()
    if not base_url:
        raise HTTPException(status_code=404, detail='Not found')

    # escape() guards against XML metacharacters in the configured URL.
    entries = ''.join(f'  <url><loc>{escape(base_url + route)}</loc></url>\n' for route in PUBLIC_ROUTES)

    xml = (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
        f'{entries}'
        '</urlset>\n'
    )
    return Response(
        content=xml,
        media_type='application/xml',
        headers={'Cache-Control': _CACHE_CONTROL},
    )


async def robots_txt(request: Request):
    """
    Serve ``/robots.txt`` — policy depends on the deployment mode.

    Hosted SaaS (``RR_APP_URL`` set): allow all crawlers and point at the
    sitemap. Otherwise (OSS, self-hosted, desktop): a customer engine is
    not a marketing site — tell crawlers to stay out entirely.

    Args:
        request: Incoming HTTP request.

    Returns:
        PlainTextResponse with the robots policy.
    """
    base_url = _app_url()

    if base_url:
        content = f'User-agent: *\nAllow: /\n\nSitemap: {base_url}/sitemap.xml\n'
    else:
        content = 'User-agent: *\nDisallow: /\n'

    return PlainTextResponse(content, headers={'Cache-Control': _CACHE_CONTROL})


async def llms_txt(request: Request):
    """
    Serve ``/llms.txt`` — an llmstxt.org index of the public pages.

    One bullet per ``PUBLIC_ROUTE_MANIFEST`` entry plus a pointer at the
    docs site. Same gating as the sitemap: absolute URLs come exclusively
    from ``RR_APP_URL``, and the endpoint 404s when it is unset.

    Args:
        request: Incoming HTTP request.

    Returns:
        PlainTextResponse with the llms.txt content.

    Raises:
        HTTPException: 404 when ``RR_APP_URL`` is not configured.
    """
    base_url = _app_url()
    if not base_url:
        raise HTTPException(status_code=404, detail='Not found')

    pages = ''.join(
        f'- [{title}]({base_url}{route}): {description}\n' for route, title, description in PUBLIC_ROUTE_MANIFEST
    )

    content = (
        '# RocketRide\n'
        '\n'
        '> Build, run, and harness AI at rocket speed. From prototype to production. '
        'Fully managed, predictable costs, true portability.\n'
        '\n'
        '## Pages\n'
        '\n'
        f'{pages}'
        '\n'
        '## Documentation\n'
        '\n'
        f'- [Docs]({DOCS_URL}): Product and API documentation.\n'
    )
    return PlainTextResponse(
        content,
        media_type='text/plain; charset=utf-8',
        headers={'Cache-Control': _CACHE_CONTROL},
    )
