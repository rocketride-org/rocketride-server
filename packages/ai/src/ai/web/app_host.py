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
App-host dispatch (#1022, design section 5).

``AppHostMiddleware`` is a pure ASGI middleware installed OUTERMOST when
``RR_APP_ISOLATION`` is not ``off``. It splits traffic by host:

  - an APP HOST (``{label}.<suffix>`` of the origin template, label of 25
    characters of ``[a-z2-7]``) serves only the app-host routes below; every
    other path is 404 and a WebSocket is closed before accept (HTTP 403).
    Nothing on an app host ever reaches the engine's own routes, and no
    response sets a cookie;
  - any OTHER host answers 404 for ``/_t``, ``/_p`` and ``/_rr`` and passes
    everything else through untouched.

App-host routes:
    GET /_rr/frame.html               — the guest frame, shell origins injected as a meta tag
    GET /_rr/<guest>                  — the guest bundle named by runtime.json (immutable)
    GET /_rr/clear                    — Clear-Site-Data: "storage" (loaded on logout)
    GET /_t/<token>/v<N>/<file>       — one version's dist behind a frame token (private, no-store)
    GET /_p/<appId>/v<N>/<file>       — a public ready version's dist (anonymous)

The host comes from ``Host`` (lowercased, one trailing dot stripped, port
compared with the template), or with ``RR_APP_HOST_SOURCE=edge-header`` from
``X-RR-App-Host`` when ``X-RR-Edge-Secret`` matches ``RR_EDGE_SECRET``.
"""

import hmac
import html
import mimetypes
import re
from typing import Optional

from starlette.datastructures import Headers
from starlette.responses import Response

from ai.modules.shell.app_origin import (
    FrameTokenError,
    IsolationConfig,
    current_config,
    guest_dir,
    label_of,
    public_version_dirs,
    read_runtime_marker,
    token_version_dirs,
    verify_frame_token,
)

_LABEL = re.compile(r'[a-z2-7]{25}')
_VERSION = re.compile(r'v(\d{1,9})')
_APP_ID = re.compile(r'[A-Za-z0-9_][A-Za-z0-9_.\-]{0,127}')
_APP_HOST_PREFIXES = ('/_t', '/_p', '/_rr')

# Appendix C. frame.html adds frame-ancestors <RR_SHELL_ORIGINS>; every other
# app-host response carries the same policy without it.
_CSP = (
    "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; "
    "img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; worker-src 'self' blob:; "
    "frame-src 'none'; form-action 'none'; base-uri 'none'; object-src 'none'"
)

# Set on EVERY app-host response by the route itself (the engine's
# security-headers middleware sits inside this one and never sees them).
_APP_HOST_HEADERS = {
    'Strict-Transport-Security': 'max-age=31536000',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'Origin-Agent-Cluster': '?1',
    'Vary': 'Service-Worker',
}

_TOKEN_CACHE = 'private, no-store'
_PUBLIC_CACHE = 'private, max-age=3600'
_GUEST_CACHE = 'public, max-age=31536000, immutable'


def _is_app_host_path(path: str) -> bool:
    """Whether a path belongs to the app-host route families."""
    return any(path == prefix or path.startswith(prefix + '/') for prefix in _APP_HOST_PREFIXES)


def _not_found() -> Response:
    """The one 404 every refused path answers."""
    return Response('Not found', status_code=404, media_type='text/plain')


class AppHostMiddleware:
    """Outermost ASGI dispatch between app hosts and every other host (``http`` and ``websocket``)."""

    def __init__(self, app, config: Optional[IsolationConfig] = None):
        """
        Wrap the engine's ASGI app.

        Args:
            app: The inner ASGI application.
            config: The isolation configuration (default: the environment's).
        """
        self.app = app
        self.config = config or current_config()

    async def __call__(self, scope, receive, send):
        """Route one scope: app host, app-host path on another host, or pass-through."""
        if scope['type'] not in ('http', 'websocket'):
            await self.app(scope, receive, send)
            return
        headers = Headers(scope=scope)
        label = self._app_label(headers)
        path = scope.get('path', '')
        if label is None and not _is_app_host_path(path):
            await self.app(scope, receive, send)
            return
        if scope['type'] == 'websocket':
            # Closed before accept: the client sees HTTP 403.
            await send({'type': 'websocket.close', 'code': 1008})
            return
        if label is None:
            response = _not_found()
        else:
            response = await self._serve(scope, headers, label, path)
            response.headers.update(_APP_HOST_HEADERS)
            if 'content-security-policy' not in response.headers:
                response.headers['Content-Security-Policy'] = _CSP
        await response(scope, receive, send)

    # ── Host ────────────────────────────────────────────────────────────────

    def _app_label(self, headers: Headers) -> Optional[str]:
        """The app label of the request's host, or None when it is not an app host."""
        if self.config.host_source == 'edge-header':
            secret = headers.get('x-rr-edge-secret', '')
            if not secret or not hmac.compare_digest(secret.encode('utf-8'), self.config.edge_secret.encode('utf-8')):
                return None
            value = headers.get('x-rr-app-host', '')
        else:
            value = headers.get('host', '')
        name, port = value.strip().lower(), None
        if ':' in name:
            name, _, port_text = name.rpartition(':')
            if not port_text.isdigit():
                return None
            port = int(port_text)
        if name.endswith('.'):
            name = name[:-1]
        label, dot, suffix = name.partition('.')
        if not dot or suffix != self.config.app_suffix or port != self.config.app_port:
            return None
        return label if _LABEL.fullmatch(label) else None

    # ── Routes ──────────────────────────────────────────────────────────────

    async def _serve(self, scope, headers: Headers, label: str, path: str) -> Response:
        """Answer one request on an app host."""
        if scope.get('method') not in ('GET', 'HEAD') or 'service-worker' in headers:
            # E9: a service worker registration is refused on the app host.
            return _not_found()
        parts = path.split('/')[1:]
        if parts[:1] == ['_rr'] and len(parts) == 2:
            return self._serve_rr(parts[1])
        if parts[:1] in (['_t'], ['_p']) and len(parts) >= 4:
            version = _VERSION.fullmatch(parts[2])
            rest = parts[3:]
            if version and all(seg and seg not in ('.', '..') and '\\' not in seg and ':' not in seg for seg in rest):
                if parts[0] == '_t':
                    return await self._serve_token(parts[1], int(version.group(1)), rest, label)
                return await self._serve_public(parts[1], int(version.group(1)), rest, label)
        return _not_found()

    def _serve_rr(self, name: str) -> Response:
        """``/_rr/frame.html``, ``/_rr/<guest>`` and ``/_rr/clear``."""
        if name == 'clear':
            return Response(b'', headers={'Clear-Site-Data': '"storage"', 'Cache-Control': 'no-store'})
        try:
            marker = read_runtime_marker()
            if name == 'frame.html':
                document = (guest_dir() / 'frame.html').read_text(encoding='utf-8')
            elif name == marker['guest']:
                bundle = (guest_dir() / marker['guest']).read_bytes()
                return Response(bundle, media_type='text/javascript', headers={'Cache-Control': _GUEST_CACHE})
            else:
                return _not_found()
        except (OSError, RuntimeError):
            return _not_found()
        origins = ' '.join(self.config.shell_origins)
        meta = f'<meta name="rr-shell-origins" content="{html.escape(origins)}">'
        head = re.search(r'<head[^>]*>', document, re.IGNORECASE)
        document = document[: head.end()] + meta + document[head.end() :] if head else meta + document
        return Response(
            document,
            media_type='text/html',
            headers={
                'Cache-Control': 'no-cache',
                'Content-Security-Policy': f'{_CSP}; frame-ancestors {origins}',
            },
        )

    async def _serve_token(self, token: str, version: int, rest: list, label: str) -> Response:
        """``/_t/<token>/v<N>/<file>``: the token's own app and version, on its own host, while entitled."""
        try:
            claims = verify_frame_token(token, label, config=self.config)
        except FrameTokenError:
            return _not_found()
        if claims['v'] != version:
            return _not_found()
        dirs = await token_version_dirs(claims['u'], claims['o'], claims['a'])
        return await _read_dist(dirs.get(version), rest, _TOKEN_CACHE)

    async def _serve_public(self, app_id: str, version: int, rest: list, label: str) -> Response:
        """``/_p/<appId>/v<N>/<file>``: a version an anonymous caller may load, on the app's own host."""
        if not _APP_ID.fullmatch(app_id) or not hmac.compare_digest(label_of(app_id), label):
            return _not_found()
        dirs = await public_version_dirs(app_id)
        return await _read_dist(dirs.get(version), rest, _PUBLIC_CACHE)


async def _read_dist(dist_dir: Optional[str], rest: list, cache_control: str) -> Response:
    """Stream one file of a version's dist tree from the store, or the one 404."""
    if not dist_dir:
        return _not_found()
    from ai.account.store import Store

    try:
        data = await Store.instance()._store.read_bytes(f'{dist_dir}/{"/".join(rest)}')
    except Exception:
        return _not_found()
    media_type = mimetypes.guess_type(rest[-1])[0] or 'application/octet-stream'
    return Response(data, media_type=media_type, headers={'Cache-Control': cache_control})
