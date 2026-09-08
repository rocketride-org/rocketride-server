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

import hashlib
import mimetypes
import os
import re
import sys
import time
from pathlib import Path
from typing import Optional
from xml.sax.saxutils import escape

from fastapi import HTTPException
from fastapi.responses import FileResponse, JSONResponse, PlainTextResponse, Response

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
        'Predictable pricing that scales with you. Subscription plans and '
        'metered billing, with no hard caps, no surprise bills, and no vendor '
        'lock-in.',
    ),
    (
        '/marketplace',
        'Marketplace',
        'Ready-to-run AI apps built on RocketRide. Browse the catalog, try apps '
        'instantly, and deploy them on managed infrastructure.',
    ),
    (
        # Legacy alias for /marketplace (the pre-rename App Store URL). Kept so
        # old links and bookmarks survive a hard reload; the client route
        # manifest (routes.ts) canonicalizes the address bar to /marketplace.
        '/store',
        'Marketplace',
        'Ready-to-run AI apps built on RocketRide. Browse the catalog, try apps '
        'instantly, and deploy them on managed infrastructure.',
    ),
    (
        '/build-publish-earn',
        'Build, Publish, Earn',
        'Build AI apps on RocketRide, publish them to the Marketplace, and earn '
        'from every run. Bring your own pipeline, reach customers, get paid.',
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
    (
        '/extension',
        'Extension',
        'Build and run RocketRide pipelines inside your editor with the IDE extension.',
    ),
    (
        '/sdk',
        'SDK',
        'Client SDKs for Python and TypeScript. Execute pipelines, move data, and monitor runs from your own code.',
    ),
    (
        '/blog',
        'Blog',
        'Product updates, engineering deep dives, and stories from the RocketRide team.',
    ),
    (
        '/events',
        'Events',
        'Meet the RocketRide team at conferences, webinars, and community events.',
    ),
    (
        '/about',
        'About Us',
        'Who we are and why we are building RocketRide — AI infrastructure from prototype to production.',
    ),
    (
        '/careers',
        'Careers',
        'Join the team building RocketRide. Open roles across engineering, product, and go-to-market.',
    ),
    (
        '/contact',
        'Contact',
        'Get in touch with the RocketRide team — sales, support, and partnership inquiries.',
    ),
]

# Bare route list — kept as the module's public surface for route
# registration and the sitemap.
PUBLIC_ROUTES = [route for route, _, _ in PUBLIC_ROUTE_MANIFEST]

# Served but not advertised. These stay registered above (typing the URL or
# hard-reloading must keep working) while being excluded from /sitemap.xml and
# /llms.txt: /oss and /mcp are `unlisted` in the client route manifest
# (routes.ts stamps them noindex — listing them here would hand crawlers the
# very URLs the client tells them to drop), and /store is the legacy alias the
# client canonicalizes to /marketplace, so listing it publishes a duplicate of
# its own canonical.
UNLISTED_ROUTES = frozenset({'/oss', '/mcp', '/store'})

# The advertised subset — what /sitemap.xml and /llms.txt enumerate.
LISTED_ROUTE_MANIFEST = [entry for entry in PUBLIC_ROUTE_MANIFEST if entry[0] not in UNLISTED_ROUTES]
LISTED_ROUTES = [route for route, _, _ in LISTED_ROUTE_MANIFEST]

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


# =============================================================================
# APP-BUNDLE AUTHORIZATION (SaaS only)
# =============================================================================
# OSS is single-tenant — every app bundle is public. SaaS gates each bundle
# behind the caller's per-app permission: the browser carries the user token in
# an /apps-scoped cookie (minted by apps_session), and apps_static validates it
# and checks that the caller can load <app_id> before serving any file.

# The cookie the browser attaches to every /apps/* fetch (set by apps_session).
_APP_COOKIE = 'rr_apps_token'

# Sliding permission cache: sha256('<token>.<app_id>') -> {auth: bool, expiry}.
# DENIALS are cached too — an unauthorized caller hammering denied apps is then
# served from cache instead of a DB walk per file (a cheap-DoS guard). Every
# reference slides the entry 5 min forward. Only the permission DECISION is
# cached; token validity is (cheaply) re-derived inside _resolve_app_access.
_APP_AUTH_TTL = 300.0
_app_auth_cache: dict = {}


def _is_saas() -> bool:
    """True when the loaded account edition gates app bundles (SaaS)."""
    from ai.account import account

    return 'saas' in getattr(account, 'capabilities', ())


def _app_field(entry, name: str):
    """One field off a catalog entry (dict or pydantic model)."""
    return entry.get(name) if isinstance(entry, dict) else getattr(entry, name, None)


async def _apps_for_token(token: str) -> list:
    """The caller-visible app manifest entries — the shell's own resolution.

    An authenticated caller gets their full entitled set; an anonymous caller
    (or an unverifiable token) gets the PUBLIC set only — so public apps (the
    pre-auth landing/home) resolve without a session, private ones do not.
    """
    from ai.account import account

    info = None
    if token:
        try:
            info = await account.authenticate(token)
        except Exception:
            info = None
    # authenticate() returns an (int, str) error tuple on failure — treat any
    # non-AccountInfo as anonymous rather than a hard deny.
    if info is not None and hasattr(info, 'userId'):
        # AccountInfo carries ONE selected organization (singular field); the
        # resolver wants a list. A plural-field lookup here always returned []
        # and silently dropped every org/team entitlement.
        org = getattr(info, 'organization', None)
        organizations = [org.model_dump() if hasattr(org, 'model_dump') else org] if org else []
        sys_perms = list(getattr(info, 'sysPermissions', []) or [])
        try:
            return await account.get_apps_for_user(info.userId, organizations, sys_perms)
        except TypeError:
            # Older signature without sys_permissions.
            return await account.get_apps_for_user(info.userId, organizations)
    return await account.get_public_apps()


async def _resolve_app_access(token: str, app_id: str) -> bool:
    """Uncached: may the caller load ``app_id``'s bundle?

    The served directory IS the app id (the build emits
    ``dist/server/static/apps/<app_id>/``), so the first path segment of an
    ``/apps/...`` request is the app id we authorize. Defers to the same account
    resolver the store listing uses, so every gate (audience, binding state,
    requiredPermissions) folds into one boolean — an app the caller can't see is
    an app they can't fetch.
    """
    apps = await _apps_for_token(token)
    return any(_app_field(a, 'id') == app_id for a in apps)


async def _app_entry_info(token: str, app_id: str) -> Optional[dict]:
    """The resolution document of one app for one caller, or None.

    "What will be served": the SAME manifest entry the shell's connect
    resolves (scope-walk winner), reduced to the safe subset and the
    versioned entry URL clients would construct from it. Deliberately
    minimal — no org ids, no build metadata, no developer facts — because
    anonymous callers reach this. A visible entry WITHOUT a registry
    version (a dev-overlay-only preview) returns None: nothing versioned
    would serve, and the probe must say so. The same holds for a version
    the caller cannot actually fetch (unbuilt or unentitled) — the answer
    is resolved against the SAME servable map ``_serve_versioned`` uses, so
    the probe can never advertise an entry URL that would 404.
    """
    for entry in await _apps_for_token(token):
        if _app_field(entry, 'id') != app_id:
            continue
        registry_version = _app_field(entry, 'registryVersion')
        if not registry_version:
            return None
        version = int(registry_version)
        if version not in await _version_dirs_for(token, app_id, want=version):
            return None
        return {
            'appId': app_id,
            'name': _app_field(entry, 'name') or app_id,
            'version': str(_app_field(entry, 'version') or ''),
            'registryVersion': version,
            'entry': f'/apps/{app_id}/v{version}/remoteEntry.js',
        }
    return None


async def _authorize_app(token: str, app_id: str) -> bool:
    """Cached wrapper over _resolve_app_access (sliding 5-min window).

    Anonymous (empty token) is a VALID caller for public bundles, so it is
    cached too — the key folds the empty token.
    """
    if not app_id:
        return False
    key = hashlib.sha256(f'{token}.{app_id}'.encode('utf-8')).hexdigest()
    now = time.time()
    hit = _app_auth_cache.get(key)
    if hit is not None and hit['expiry'] > now:
        hit['expiry'] = now + _APP_AUTH_TTL  # slide on reference
        return hit['auth']
    auth = await _resolve_app_access(token, app_id)
    _app_auth_cache[key] = {'auth': auth, 'expiry': now + _APP_AUTH_TTL}
    # Bounded for real: expired entries go first, and if a flood of DISTINCT
    # random tokens fills the map inside one TTL window (nothing expired to
    # drop), evict the soonest-to-expire entries down to the cap — with the
    # sliding TTL, soonest-expiry is least-recently-referenced, so this is
    # LRU-shaped and the map can never exceed the cap.
    if len(_app_auth_cache) > 4096:
        for k in [k for k, v in _app_auth_cache.items() if v['expiry'] <= now]:
            _app_auth_cache.pop(k, None)
        if len(_app_auth_cache) > 4096:
            for k in sorted(_app_auth_cache, key=lambda k: _app_auth_cache[k]['expiry'])[: len(_app_auth_cache) - 4096]:
                _app_auth_cache.pop(k, None)
    return auth


# =============================================================================
# VERSIONED APP SERVING — store-backed, immutable per version
# =============================================================================
# /apps/<appId>/v<N>/<rest> streams the registry version's built dist/ tree
# from the STORE (deployed and seeded apps alike — bundles serve versioned
# ONLY; the static tree below is for app ASSETS like icons/readmes). Bytes
# are IMMUTABLE per version, so caching is aggressive; the entitlement
# VERDICT is cached with a HARD expiry — deliberately never slid — so a
# pulled publish stops serving within minutes no matter how hot the traffic
# is. The reverse move (a publish that ADDS a version — deploy, fleet bump)
# converges immediately instead: a request for a version MISSING from a
# warm map forces one re-resolution, refractory-limited below.

_VERSION_SEG = re.compile(r'^v(\d{1,9})$')
_APP_ID_SEG = re.compile(r'^[A-Za-z0-9_][A-Za-z0-9_.\-]*$')
_IMMUTABLE_CACHE = 'private, max-age=31536000, immutable'
# sha256('<token>.<app_id>') -> {'dirs': {version: dist_dir}, 'expiry',
# 'resolvedAt', 'floor'} — HARD expiry (contrast _app_auth_cache's sliding
# window).
_version_dir_cache: dict = {}
# BASE floor between miss-forced re-resolutions of one caller's map: a map
# younger than its key's CURRENT floor answers as-is even when it lacks the
# requested version. A FRUITLESS forced walk (the wanted version still
# absent afterwards) doubles the key's floor, capped at the hard expiry; a
# walk that satisfies the caller resets it to this base — so a real publish
# (forward, backward, or several bumps inside one window) converges on the
# first ask, while a nonexistent-version prober decays to one DB walk per
# minutes per key.
_VERSION_MISS_REFRACTORY = 5.0


async def _version_dirs_for(token: str, app_id: str, want: Optional[int] = None) -> dict:
    """Hard-expiry cached: registry version -> servable dist dir for a caller.

    SaaS resolves the caller's entitled set (anonymous = public only);
    OSS resolves every built version (open serving — single-tenant).

    ``want`` is the version the caller is about to look up: a warm map that
    LACKS it is re-resolved on the spot (bounded by the key's escalating
    refractory floor — see _VERSION_MISS_REFRACTORY) rather than answered
    stale — so a fresh publish/fleet bump serves as soon as clients ask for
    the new version instead of 404ing until the hard expiry. Entitlement
    stays conservative both ways: the refresh can only ADD what the DB now
    grants, and revocation still converges on the hard expiry as before.
    """
    key = hashlib.sha256(f'{token}.{app_id}'.encode('utf-8')).hexdigest()
    now = time.time()
    hit = _version_dir_cache.get(key)
    if hit is not None and hit['expiry'] > now:  # no slide — HARD expiry
        # A hit only answers when it can satisfy the caller: an absent
        # ``want`` on a map old enough to re-resolve falls through to a
        # fresh DB walk below (the miss-refresh); a map younger than the
        # key's current floor answers stale to keep the miss path from
        # becoming a per-request walk.
        if want is None or want in hit['dirs'] or now - hit['resolvedAt'] < hit['floor']:
            return hit['dirs']

    from ai.account import account
    from ai.account.app_deploy import entitled_version_dirs, open_version_dirs

    if _is_saas():
        info = None
        if token:
            try:
                info = await account.authenticate(token)
            except Exception:
                info = None
        if info is not None and not hasattr(info, 'userId'):
            info = None  # authenticate() returns an error tuple on failure
        dirs = await entitled_version_dirs(info, app_id)
    else:
        dirs = await open_version_dirs(app_id)

    # The key's NEXT floor: a miss-forced walk that still lacks the wanted
    # version was fruitless — double the floor (capped at the TTL) so a
    # prober decays; any walk that satisfies the caller (or a plain
    # cold/expired resolution) resets to the base, so a real publish always
    # converges on the first ask.
    fruitless = hit is not None and hit['expiry'] > now and want is not None and want not in dirs
    floor = min(hit['floor'] * 2, _APP_AUTH_TTL) if fruitless else _VERSION_MISS_REFRACTORY
    _version_dir_cache[key] = {'dirs': dirs, 'expiry': now + _APP_AUTH_TTL, 'resolvedAt': now, 'floor': floor}
    # Bounded like _app_auth_cache: expired first, then soonest-to-expire.
    if len(_version_dir_cache) > 4096:
        for k in [k for k, v in _version_dir_cache.items() if v['expiry'] <= now]:
            _version_dir_cache.pop(k, None)
        if len(_version_dir_cache) > 4096:
            overflow = len(_version_dir_cache) - 4096
            for k in sorted(_version_dir_cache, key=lambda k: _version_dir_cache[k]['expiry'])[:overflow]:
                _version_dir_cache.pop(k, None)
    return dirs


async def _serve_versioned(request: Request, app_id: str, version: int, rest: list) -> Response:
    """Stream one immutable file of a version's built dist tree.

    ONE answer (404) for unauthorized, unbuilt, and absent alike — the
    route must not be an existence oracle for private versions. The dist
    mapping is the only store surface reachable here: ``source/`` and
    ``bundle/`` live outside every dir this resolver returns.
    """
    # Path discipline: these segments become STORE paths.
    if not _APP_ID_SEG.match(app_id):
        raise HTTPException(status_code=404, detail='Not found')
    for seg in rest:
        if not seg or seg in ('.', '..') or '\\' in seg or ':' in seg:
            raise HTTPException(status_code=404, detail='Not found')

    dirs = await _version_dirs_for(request.cookies.get(_APP_COOKIE, ''), app_id, want=version)
    dist_dir = dirs.get(version)
    if not dist_dir:
        raise HTTPException(status_code=404, detail='Not found')

    from ai.account.store import Store

    try:
        data = await Store.instance()._store.read_bytes(f'{dist_dir}/{"/".join(rest)}')
    except Exception:
        raise HTTPException(status_code=404, detail='Not found')
    media_type = mimetypes.guess_type(rest[-1])[0] or 'application/octet-stream'
    return Response(content=data, media_type=media_type, headers={'Cache-Control': _IMMUTABLE_CACHE})


async def apps_session(request: Request):
    """Mint the /apps auth cookie from the caller's Authorization header.

    The token is VALIDATED before any cookie is set: an unauthenticated
    cross-site POST could otherwise plant an attacker's token as the victim's
    /apps cookie (SameSite=Lax restricts when a cookie is SENT, not whether a
    Set-Cookie response is accepted), and later same-site bundle fetches would
    authorize as the attacker. apps_static re-validates on every serve — this
    is defense in depth, not the only gate. Called by the shell right after a
    successful connect, so a valid session always mints cleanly.
    """
    from ai.account import account

    auth = request.headers.get('authorization', '')
    token = auth[7:].strip() if auth[:7].lower() == 'bearer ' else auth.strip()
    if not token:
        return JSONResponse({'ok': False})
    try:
        info = await account.authenticate(token)
    except Exception:
        info = None
    # authenticate() returns an (int, str) error tuple on failure.
    if info is None or not hasattr(info, 'userId'):
        raise HTTPException(status_code=401, detail='Invalid token')
    # This cookie carries a bearer token, so it must be Secure on any HTTPS
    # path. request.url.scheme is the TRUSTED scheme of the direct connection
    # (https only on a genuine TLS socket); X-Forwarded-Proto is client-settable
    # and may therefore only UPGRADE the cookie to Secure — a real request
    # behind a TLS-terminating proxy arrives as http with X-Forwarded-Proto:
    # https. It must NEVER downgrade: an attacker sending `X-Forwarded-Proto:
    # http` on a genuine https request cannot strip Secure and coax the browser
    # into replaying the token over plaintext. Take the first hop of a possibly
    # comma-joined header (client, proxy1, proxy2).
    forwarded = request.headers.get('x-forwarded-proto', '').split(',')[0].strip().lower()
    secure = request.url.scheme == 'https' or forwarded == 'https'
    resp = JSONResponse({'ok': True})
    resp.set_cookie(
        key=_APP_COOKIE,
        value=token,
        path='/apps',
        httponly=True,
        secure=secure,
        samesite='lax',
    )
    return resp


async def apps_static(request: Request):
    """
    Serve MF remote app bundles (versioned, store-backed) + app assets.

    Handles ``GET /apps/{path}``. Three shapes:

    - ``<appId>/v<N>/<rest>`` — VERSIONED serving, the ONLY bundle path:
      the registry version's built ``dist/`` tree streamed from the STORE,
      immutable per version. Entitlement enforced per request (SaaS; OSS is
      open) through a HARD-expiry verdict cache. There is no unversioned
      bundle serving of any kind — clients construct versioned URLs from
      the version numbers the wire carries.
    - ``<appId>`` (bare, no version, no file) — RESOLUTION INFO: a small
      JSON document saying what a bundle fetch would serve this caller
      (see ``_app_entry_info``). The deploy smoke test's probe.
    - anything else — the static assets tree on disk: the icons/readmes the
      app manifests point at (``/apps/<dir>/icon.svg``).

    Raises:
        HTTPException: 404 if file not found, 503 if apps dir missing.
    """
    # "/apps/rocketride.pipeBuilder/remoteEntry.js" → rocketride.pipeBuilder/remoteEntry.js
    raw_path = request.url.path.lstrip('/')
    if raw_path.startswith('apps/'):
        raw_path = raw_path[len('apps/') :]

    if not raw_path:
        raise HTTPException(status_code=404, detail='Not found')

    # Versioned store-backed serving — takes the path BEFORE any disk
    # resolution: /apps/<appId>/v<N>/... never maps to the static tree.
    parts = [p for p in raw_path.split('/') if p]
    if len(parts) >= 3:
        version_seg = _VERSION_SEG.match(parts[1])
        if version_seg:
            return await _serve_versioned(request, parts[0], int(version_seg.group(1)), parts[2:])

    # Resolution info — a BARE app id (no version, no file) answers with what
    # a bundle fetch WOULD serve this caller: the deploy smoke test's probe
    # and a one-curl ops answer to "which version am I getting?". Resolution
    # runs under the same identity as serving (the /apps cookie, anonymous
    # without it). A miss falls through to the static tree, which never
    # served a bare directory — the same 404 as before, so this is not an
    # existence oracle for apps the caller cannot see.
    if len(parts) == 1 and _APP_ID_SEG.match(parts[0]):
        info = await _app_entry_info(request.cookies.get(_APP_COOKIE, ''), parts[0])
        if info is not None:
            # Mutable resolution facts — never let a client pin them.
            return JSONResponse(info, headers={'Cache-Control': 'no-cache, must-revalidate'})

    # Apps haven't been built/copied yet — surface a clearer signal.
    if not os.path.isdir(_apps_root):
        raise HTTPException(status_code=503, detail='App bundles not built. Run the app build/copy step.')
    # Resolve BEFORE authorizing, and refuse traversal outright — no SPA
    # fallback here (these are JS/CSS assets). The authorized app id must come
    # from the RESOLVED location: deriving it from the raw path let
    # `a/../b/file` authorize as app `a` while serving app `b`'s file,
    # bypassing the per-app gate for every private bundle.
    try:
        file_path = (Path(_apps_root) / raw_path).resolve()
        root_path = Path(_apps_root).resolve()
        if not file_path.is_relative_to(root_path):
            raise HTTPException(status_code=404, detail='Not found')
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(status_code=404, detail='Not found')

    # SaaS gates each bundle behind the caller's per-app permission; OSS serves
    # freely (single-tenant). The directory IS the app id, so the resolved
    # path's first segment under the root is what we authorize. The user token
    # rides an /apps-scoped cookie minted by apps_session.
    if _is_saas():
        rel_parts = file_path.relative_to(root_path).parts
        app_id = rel_parts[0] if rel_parts else ''
        token = request.cookies.get(_APP_COOKIE, '')
        if not await _authorize_app(token, app_id):
            raise HTTPException(status_code=403, detail=f'Not authorized for app {app_id}')

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
    entries = ''.join(f'  <url><loc>{escape(base_url + route)}</loc></url>\n' for route in LISTED_ROUTES)

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

    One bullet per ``LISTED_ROUTE_MANIFEST`` entry plus a pointer at the
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
        f'- [{title}]({base_url}{route}): {description}\n' for route, title, description in LISTED_ROUTE_MANIFEST
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
