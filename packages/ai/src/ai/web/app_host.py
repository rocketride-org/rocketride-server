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
    Any other name under the suffix (the bare suffix, a wrong label or port)
    is app-domain traffic too and gets the same 404. Nothing under the app
    suffix ever reaches the engine's own routes, and no response sets a
    cookie;
  - any OTHER host answers 404 for ``/_t``, ``/_p`` and ``/_rr`` and passes
    everything else through untouched.

App-host routes:
    GET /_rr/frame.html               — the guest frame, shell origins injected as a meta tag
    GET /_rr/<guest>                  — the guest bundle named by runtime.json (immutable)
    GET /_rr/clear                    — Clear-Site-Data: "storage" (a same-origin navigation only, on logout)
    GET /_t/<token>/v<N>/<file>       — one version's dist behind a frame token (private, no-store)
    GET /_p/<appId>/v<N>/<file>       — a public ready version's dist (anonymous; registry
                                        walks are budgeted per client)

HTML and SVG from a dist get ``frame-ancestors 'none'``: frame.html is the
only framable document on an app host.

The host comes from ``Host`` (lowercased, one trailing dot stripped, port
compared with the template), or with ``RR_APP_HOST_SOURCE=edge-header`` from
``X-RR-App-Host`` when ``X-RR-Edge-Secret`` matches ``RR_EDGE_SECRET``.
"""

import hashlib
import hmac
import html
import re
from typing import Optional

from starlette.datastructures import Headers
from starlette.responses import Response

from ai.modules.shell.app_origin import (
    FrameTokenError,
    IsolationConfig,
    client_ip,
    current_config,
    entitlement_ok,
    guest_dir,
    is_canonical_app_id,
    label_of,
    public_lookup_ok,
    public_version_dirs,
    read_runtime_marker,
    token_version_dirs,
    verify_frame_token,
)

_LABEL = re.compile(r'[a-z2-7]{25}')
_HOST_PORT = re.compile(r'(.*):([0-9]{1,5})')
_VERSION = re.compile(r'v([0-9]{1,9})')
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
# Revalidated on every use (an ETag keeps it cheap): a withdrawn deployment must stop loading at once,
# not after an hour in the browser's cache.
_PUBLIC_CACHE = 'private, no-cache'
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
        """Route one scope: app-domain traffic, an app-host path on another host, or pass-through."""
        if scope['type'] not in ('http', 'websocket'):
            await self.app(scope, receive, send)
            return
        headers = Headers(scope=scope)
        app_domain, label = self._classify(headers)
        path = scope.get('path', '')
        if not app_domain and not _is_app_host_path(path):
            await self.app(scope, receive, send)
            return
        if scope['type'] == 'websocket':
            # Closed before accept: the client sees HTTP 403.
            await send({'type': 'websocket.close', 'code': 1008})
            return
        if not app_domain:
            response = _not_found()
        else:
            response = await self._serve(scope, headers, label, path) if label else _not_found()
            response.headers.update(_APP_HOST_HEADERS)
            if 'content-security-policy' not in response.headers:
                response.headers['Content-Security-Policy'] = _CSP
        await response(scope, receive, send)

    # ── Host ────────────────────────────────────────────────────────────────

    def _in_app_domain(self, value: str) -> 'tuple[bool, Optional[str]]':
        """``(under the app suffix, valid app label or None)`` for one host header value."""
        name, port = value.strip().lower(), None
        match = _HOST_PORT.fullmatch(name)
        if match:
            name, port = match.group(1), int(match.group(2))
        elif ':' in name and not name.startswith('['):
            name, port = name.rpartition(':')[0], -1  # a port that is not ASCII digits never matches
        if name.endswith('.'):
            name = name[:-1]
        suffix = self.config.app_suffix
        if not (name == suffix or name.endswith('.' + suffix)):
            return False, None
        label = name[: -len(suffix) - 1] if name != suffix else ''
        if port != self.config.app_port or not _LABEL.fullmatch(label):
            return True, None
        return True, label

    def _classify(self, headers: Headers) -> 'tuple[bool, Optional[str]]':
        """
        ``(app-domain traffic, app label or None)`` of one request.

        ANY name under the app suffix (the bare suffix included) is app-domain
        traffic and never reaches the engine; only a valid label with the
        template's port is served. With ``edge-header`` the label comes only
        from ``X-RR-App-Host`` behind a matching ``X-RR-Edge-Secret``; an
        app-suffix ``Host`` without it is still app-domain traffic (a 404).
        """
        if self.config.host_source == 'edge-header':
            secret = headers.get('x-rr-edge-secret', '')
            if secret and hmac.compare_digest(secret.encode('utf-8'), self.config.edge_secret.encode('utf-8')):
                app_domain, label = self._in_app_domain(headers.get('x-rr-app-host', ''))
                if app_domain:
                    return True, label
            return self._in_app_domain(headers.get('host', ''))[0], None
        return self._in_app_domain(headers.get('host', ''))

    # ── Routes ──────────────────────────────────────────────────────────────

    async def _serve(self, scope, headers: Headers, label: str, path: str) -> Response:
        """Answer one request on an app host."""
        if scope.get('method') not in ('GET', 'HEAD') or 'service-worker' in headers:
            # E9: a service worker registration is refused on the app host.
            return _not_found()
        parts = path.split('/')[1:]
        if parts[:1] == ['_rr'] and len(parts) == 2:
            return self._serve_rr(parts[1], headers)
        if parts[:1] in (['_t'], ['_p']) and len(parts) >= 4:
            version = _VERSION.fullmatch(parts[2])
            rest = parts[3:]
            if version and all(seg and seg not in ('.', '..') and '\\' not in seg and ':' not in seg for seg in rest):
                if parts[0] == '_t':
                    return await self._serve_token(parts[1], int(version.group(1)), rest, label)
                peer = (scope.get('client') or ('',))[0] or ''
                if not public_lookup_ok(parts[1], client_ip(headers, peer, self.config)):
                    return Response('Too many requests', status_code=429, media_type='text/plain')
                return await self._serve_public(parts[1], int(version.group(1)), rest, label, headers)
        return _not_found()

    def _serve_rr(self, name: str, headers: Headers) -> Response:
        """``/_rr/frame.html``, ``/_rr/<guest>`` and ``/_rr/clear``."""
        if name == 'clear':
            # Only a same-ORIGIN navigation wipes the origin's storage (each
            # guest navigates its own frame here on logout). Every app host is
            # same-site with every other one, so 'same-site' would let one app
            # wipe another's storage; any other site, a subresource load, or no
            # fetch metadata at all (older browsers never clear) gets the 404.
            same_site = headers.get('sec-fetch-site') in ('same-origin', 'none')
            navigation = headers.get('sec-fetch-dest') in ('document', 'iframe')
            foreign = 'origin' in headers and headers['origin'] not in self._own_origins(headers)
            if not (same_site and navigation) or foreign:
                return _not_found()
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

    def _own_origins(self, headers: Headers) -> tuple:
        """The origin this app host answers as (the request's own label under the template)."""
        _, label = self._classify(headers)
        return (self.config.origin_template.replace('{label}', label),) if label else ()

    async def _serve_token(self, token: str, version: int, rest: list, label: str) -> Response:
        """``/_t/<token>/v<N>/<file>``: the token's own app and version, on its own host, while entitled."""
        try:
            claims = verify_frame_token(token, label, config=self.config)
        except FrameTokenError:
            return _not_found()
        if claims['v'] != version:
            return _not_found()
        if not await entitlement_ok(claims['u'], claims['o'], claims['a'], version):
            return _not_found()
        dirs = await token_version_dirs(claims['u'], claims['o'], claims['a'])
        dist_dir = dirs.get(version)
        # The grant the token was minted with described one deployment: a version that now
        # resolves to another dist tree (another rail won, or it was replaced) is not that grant.
        if 'd' in claims and dist_dir != claims['d']:
            return _not_found()
        return await _read_dist(dist_dir, rest, _TOKEN_CACHE)

    async def _serve_public(
        self, app_id: str, version: int, rest: list, label: str, headers: Optional[Headers] = None
    ) -> Response:
        """``/_p/<appId>/v<N>/<file>``: a version an anonymous caller may load, on the app's own host."""
        if not is_canonical_app_id(app_id) or not hmac.compare_digest(label_of(app_id), label):
            return _not_found()
        dirs = await public_version_dirs(app_id, version)
        return await _read_dist(dirs.get(version), rest, _PUBLIC_CACHE, etag=True, if_none_match=(headers or {}).get('if-none-match', ''))


async def _read_dist(
    dist_dir: Optional[str], rest: list, cache_control: str, *, etag: bool = False, if_none_match: str = ''
) -> Response:
    """Stream one file of a version's dist tree from the store, or the one 404.

    With ``etag`` the response carries a validator and a matching ``If-None-Match`` answers 304: the
    caller has already re-resolved the version (so a withdrawn one is the 404 above), only the bytes are saved.
    """
    if not dist_dir:
        return _not_found()
    from ai.account.store import Store

    try:
        data = await Store.instance()._store.read_bytes(f'{dist_dir}/{"/".join(rest)}')
    except Exception:
        return _not_found()
    from ai.modules.shell.shell import _media_type

    # The pinned table: on Windows the registry can map .js to text/plain,
    # which a nosniff browser then refuses to run.
    media_type = _media_type(rest[-1]) or 'application/octet-stream'
    headers = {'Cache-Control': cache_control}
    if etag:
        validator = '"' + hashlib.sha256(data).hexdigest()[:32] + '"'
        headers['ETag'] = validator
        if validator in [item.strip() for item in if_none_match.split(',')]:
            return Response(status_code=304, headers=headers)
    if media_type in ('text/html', 'application/xhtml+xml', 'image/svg+xml'):
        # A document from a dist is never framed by anyone: the guest frame
        # (frame.html) is the only framable page on an app host.
        headers['Content-Security-Policy'] = f"{_CSP}; frame-ancestors 'none'"
    return Response(data, media_type=media_type, headers=headers)
