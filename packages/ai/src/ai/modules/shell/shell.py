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
``dist/server/static/shell/`` and the versioned files of deployed
artifacts (app bundles, pipe store files) from the file store.

Directory layout:
  - ``static/shell/index.html``              — SPA entry point
  - ``static/shell/static/``                 — JS/CSS bundles
  - ``static/shell/themes/``                 — theme JSON files
  - ``static/shell/favicon.svg``             — favicon

Routes:
  GET  /shell/{file_path}       — shell assets (JS, CSS, themes)
  POST /artifacts/session       — mint the artifact-serving cookie
  GET  /apps/{file_path}        — app versions, store-backed (artifact_static)
  GET  /pipelines/{file_path}   — pipe versions, store-backed (artifact_static)
  GET  /sitemap.xml             — sitemap of the listed public pages (hosted SaaS only)
  GET /robots.txt          — robots policy (+ sitemap pointer on hosted SaaS)
  GET /llms.txt            — llmstxt.org page index (hosted SaaS only)

Public pages themselves (``/`` and every path the page aggregate claims)
are served by ``pages.public_page``; their list comes from published app
manifests (``public_pages``), never from constants here.

The three crawler files key off ``RR_APP_URL`` — the env var that pins the
public base URL of the hosted SaaS deployment. When it is unset (OSS,
self-hosted, desktop and staging engines) /sitemap.xml and /llms.txt return
404 and /robots.txt disallows all crawling, as before public pages (plan
sections 4 and 8); an engine that serves published pages without it warns
once (``warn_published_pages_without_app_url``). Absolute URLs are never
derived from request headers.
"""

import hashlib
import math
import mimetypes
import os
import posixpath
import re
import sys
import time
from pathlib import Path
from typing import Any, Dict, List, Optional
from urllib.parse import quote, urlsplit
from xml.sax.saxutils import escape

from fastapi import HTTPException
from fastapi.responses import FileResponse, JSONResponse, PlainTextResponse, Response

from ai.web import Request
from ai.web.middleware import route_path

from rocketlib import warning

from . import public_pages
from .contract import Page, own_title, page_instant
from .settings import app_url

# Engine binary directory — all static paths are relative to this.
_root_dir = os.path.dirname(sys.executable)

# Shell root: dist/server/static/shell/ — SPA, themes, JS/CSS bundles.
_shell_root = os.path.join(_root_dir, 'static', 'shell')


# Crawler files are cheap to regenerate but change rarely — let shared
# caches hold them for an hour (same max-age convention as task/fetch.py).
CACHE_CONTROL = 'public, max-age=3600'


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


def capture_candidate(request: Request) -> Optional[Path]:
    """Where the prerendered capture for a navigation request is, whether or not the build carries it.

    ``<shell>/_prerender/index.html`` for '/', ``<shell>/_prerender/<route>/index.html``
    otherwise (the layout the CDN's router used). Never for /shell/* paths,
    and never with a query string: an OAuth callback lands on '/' with
    ?code/?state/?error, and invite or verification links carry a token the
    app must read. Crawlers fetch the canonical URL, which has none.

    Args:
        request: The navigation request.

    Returns:
        The capture's path inside ``_prerender``, or None when no capture may
        serve this request.
    """
    path = route_path(request.scope)
    if path.startswith('/shell/') or request.url.query:
        return None
    route = path.strip('/')
    prerender_root = (Path(_shell_root) / '_prerender').resolve()
    relative = '_prerender/index.html'
    if route:
        relative = f'_prerender/{route}/index.html'
    capture = _resolve_safe(_shell_root, relative)
    if capture.is_relative_to(prerender_root):
        return capture
    return None


def _capture_for(request: Request) -> Optional[Path]:
    """The prerendered capture for a navigation request when the build carries it, else None (see ``capture_candidate``)."""
    capture = capture_candidate(request)
    if capture is not None and capture.is_file():
        return capture
    return None


def shell_document_path(request: Request, *, capture: bool = True) -> Path:
    """The HTML document a browser navigating to this path boots from.

    The route's prerendered capture when the shell build carries one (see
    ``_capture_for``) and ``capture`` allows it, else the SPA ``index.html``:
    what ``shell_static`` serves for the same navigation.

    Raises:
        HTTPException: 503 when the shell has not been built.
    """
    index_path = Path(_shell_root) / 'index.html'
    if not index_path.is_file():
        raise HTTPException(status_code=503, detail='Shell UI not built. Run: ./builder shell:build')
    if capture:
        capture_path = _capture_for(request)
        if capture_path:
            return capture_path
    return index_path


async def shell_static(request: Request):
    """
    Serve static files for the shell SPA with client-side routing fallback.

    Handles both ``GET /`` (serves index.html) and ``GET /shell/{path}``
    (strips the prefix and resolves within the shell root directory).

    Args:
        request: Incoming HTTP request.

    Returns:
        FileResponse for the matched file, or the index.html fallback for
        non-asset routes. A /shell/static/* miss or traversal is a 404.

    Raises:
        HTTPException: 404 for a /shell/static/* miss or traversal; 503 if the
            shell has not been built.
    """
    # Not built (or built only partway): say so before any path handling, so
    # asset URLs get the 503 that names the build command instead of a bare 404.
    if not (Path(_shell_root) / 'index.html').is_file():
        raise HTTPException(status_code=503, detail='Shell UI not built. Run: ./builder shell:build')

    # Map the path the router matched (root_path stripped: the one the auth
    # middleware decided on) into the shell directory.
    # "/" → index.html
    # "/shell/static/js/main.js" → static/js/main.js
    # "/shell/themes/dark.json" → themes/dark.json
    raw_path = route_path(request.scope).lstrip('/')

    # Strip the "shell/" prefix for shell-specific routes
    if raw_path.startswith('shell/'):
        raw_path = raw_path[len('shell/') :]

    # Default bare "/" to index.html
    if not raw_path:
        raw_path = 'index.html'

    # Resolve safely within the shell root
    file_path = _resolve_safe(_shell_root, raw_path)

    # Prerendered marketing page, when the shell build carries a capture for
    # this route (see _capture_for). Only '/' reaches here with a non-/shell/
    # path, and a capture is served only if it exists, so no route list is
    # mirrored.
    capture = _capture_for(request)
    if capture is not None:
        return FileResponse(capture)

    # Content-hashed bundles under /shell/static/ are not navigation routes: a
    # miss must 404 rather than fall through to the index.html SPA response
    # below. Behind the immutable, edge-cached /shell/static/* CloudFront
    # behavior, a 200 index.html under a .js/.css URL is cached as
    # HTML-under-a-JS-URL and breaks app boot for every viewer until the cache
    # clears. A real 404 keeps the miss uncacheable as an asset.
    #
    # Decided on the RESOLVED path and BEFORE the serve step: _resolve_safe
    # answers a traversal (e.g. a percent-encoded %2e%2e, which survives edge
    # path matching and is decoded only here) with index.html, so a check after
    # serving would never be reached. Same rule as artifact_static's
    # "resolve before authorizing, refuse traversal".
    #
    # The trigger uses the stripped path, not the raw URL: '/shell//static/x.js',
    # '/shell/%2e/static/x.js' and '/shell/a/../static/x.js' all land in static/
    # but none starts with '/shell/static/'. Two views, either one triggers:
    # the leading segment (catches static/../.. walking out) and the normalized
    # path (catches a walk back in).
    segments = [s for s in raw_path.split('/') if s not in ('', '.')]
    normalized = posixpath.normpath('/' + raw_path).lstrip('/')
    is_static = segments[:1] == ['static'] or normalized.split('/', 1)[0] == 'static'
    if is_static:
        static_root = (Path(_shell_root) / 'static').resolve()
        if not (file_path.is_relative_to(static_root) and file_path.is_file()):
            raise HTTPException(status_code=404, detail='Not found')

    # Serve the file if it exists. Everything under static/ is content-hashed
    # (a new build changes the name), so the browser may keep it for good.
    if file_path.exists() and file_path.is_file():
        if is_static:
            return FileResponse(file_path, headers={'Cache-Control': 'public, max-age=31536000, immutable'})
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
# ARTIFACT SERVING — the identity behind every /apps/* and /pipelines/* fetch
# =============================================================================
# OSS is single-tenant — every version serves openly. SaaS gates each version
# behind the caller's entitlement: the browser carries the user token in a
# cookie (minted by artifacts_session, path '/') and artifact_static resolves
# the caller's servable versions from it before streaming any file.

# The cookie the browser attaches to every artifact fetch (set by artifacts_session).
_APP_COOKIE = 'rr_apps_token'

# The URL prefix each kind serves under -> the registry kind it names.
_KIND_OF_PREFIX = {'apps': 'app', 'pipelines': 'pipe'}

# How long one caller's servable-version verdict stands (HARD expiry, below).
_APP_AUTH_TTL = 300.0


def _is_saas() -> bool:
    """True when the loaded account edition gates artifact serving (SaaS)."""
    from ai.account import account

    return 'saas' in getattr(account, 'capabilities', ())


async def _authenticated(token: str) -> Optional[Any]:
    """The AccountInfo behind a cookie token, or None for anonymous / unverifiable.

    ``authenticate()`` returns an ``(int, str)`` error tuple on failure; any
    non-AccountInfo answer is anonymous rather than a hard deny, so public
    versions resolve without a session.
    """
    from ai.account import account

    if not token:
        return None
    try:
        info = await account.authenticate(token)
    except Exception:
        return None
    return info if hasattr(info, 'userId') else None


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
    from ai.account.base import InventoryUnavailableError

    info = await _authenticated(token)
    if info is not None:
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
            try:
                return await account.get_apps_for_user(info.userId, organizations)
            except InventoryUnavailableError:
                # The registry did not answer: nothing resolves for this caller.
                return []
        except InventoryUnavailableError:
            return []
    return await account.get_public_apps()


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
        if version not in await _version_dirs_for(token, 'app', app_id, want=version):
            return None
        return {
            'appId': app_id,
            'name': _app_field(entry, 'name') or app_id,
            'version': str(_app_field(entry, 'version') or ''),
            'registryVersion': version,
            'entry': f'/apps/{app_id}/v{version}/remoteEntry.js',
        }
    return None


async def _pipe_entry_info(token: str, pipe_id: str) -> Optional[dict]:
    """The resolution document of one pipe for one caller, or None — the app document's shape.

    The version is the publication the published-rung resolver answers the
    caller with (``pipe_deploy.resolve_pipe_version``: the caller's pins, or
    the public row for anonymous), checked against the SAME servable map the
    versioned route uses. ``entry`` is the version's serving root; the store
    files hang off it at the paths the catalog row names.
    """
    from ai.account import account
    from ai.account.pipe_deploy import resolve_pipe_version

    pin = await resolve_pipe_version(await _authenticated(token), pipe_id)
    if pin is None:
        return None
    version = int(pin.version)
    if version not in await _version_dirs_for(token, 'pipe', pipe_id, want=version):
        return None
    name = pipe_id
    try:
        for entry in await account.deployments_versions(pin.deployment.org_id, pipe_id):
            if int(entry.get('version', 0)) == version:
                metadata = entry.get('metadata') if isinstance(entry.get('metadata'), dict) else {}
                manifest = metadata.get('manifest') if isinstance(metadata.get('manifest'), dict) else {}
                name = str(manifest.get('name') or pipe_id)
    except Exception:
        pass  # the name is display only; the version and entry are the answer
    return {
        'pipeId': pipe_id,
        'name': name,
        'version': '',
        'registryVersion': version,
        'entry': f'/pipelines/{pipe_id}/v{version}/',
    }


async def _resolution_of(kind: str, token: str, artifact_id: str) -> Optional[dict]:
    """What a fetch of ``artifact_id`` would serve this caller, per kind, or None."""
    if kind == 'app':
        return await _app_entry_info(token, artifact_id)
    return await _pipe_entry_info(token, artifact_id)


# =============================================================================
# VERSIONED SERVING — store-backed, immutable per version, both kinds
# =============================================================================
# /<prefix>/<id>/v<N>/<rest> streams the registry version's serving tree from
# the STORE (deployed and seeded alike — files serve versioned ONLY; the
# unversioned form redirects to the caller's current version). Bytes are
# IMMUTABLE per version, but the browser cache is capped at an hour so a
# logged-out or revoked caller stops reusing a bundle without asking; the
# entitlement VERDICT is cached with a HARD expiry — deliberately never slid —
# so a pulled publish stops serving within minutes no matter how hot the
# traffic is. The reverse move (a publish that ADDS a version — deploy, fleet
# bump) converges immediately instead: a request for a version MISSING from a
# warm map forces one re-resolution, refractory-limited below.

_VERSION_SEG = re.compile(r'^v(\d{1,9})$')
_APP_ID_SEG = re.compile(r'^[A-Za-z0-9_][A-Za-z0-9_.\-]*$')
_BUNDLE_CACHE = 'private, max-age=3600, immutable'
# sha256('<token>.<kind>.<id>') -> {'dirs': {version: serving_dir}, 'expiry',
# 'resolvedAt', 'floor', 'appId'} — HARD expiry; every deploy change also
# drops the artifact's entries (invalidate_app_serving, keyed by id).
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


async def _version_dirs_for(token: str, kind: str, artifact_id: str, want: Optional[int] = None) -> dict:
    """Hard-expiry cached: registry version -> servable dir for a caller, per kind.

    SaaS resolves the caller's entitled set (anonymous = public only);
    OSS resolves every servable version (open serving — single-tenant).

    ``want`` is the version the caller is about to look up: a warm map that
    LACKS it is re-resolved on the spot (bounded by the key's escalating
    refractory floor — see _VERSION_MISS_REFRACTORY) rather than answered
    stale — so a fresh publish/fleet bump serves as soon as clients ask for
    the new version instead of 404ing until the hard expiry. Entitlement
    stays conservative both ways: the refresh can only ADD what the DB now
    grants, and revocation still converges on the hard expiry as before.
    """
    key = hashlib.sha256(f'{token}.{kind}.{artifact_id}'.encode('utf-8')).hexdigest()
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

    from ai.account.app_deploy import entitled_version_dirs, open_version_dirs

    if _is_saas():
        dirs = await entitled_version_dirs(await _authenticated(token), artifact_id, kind)
    else:
        dirs = await open_version_dirs(artifact_id, kind)

    # The key's NEXT floor: a miss-forced walk that still lacks the wanted
    # version was fruitless — double the floor (capped at the TTL) so a
    # prober decays; any walk that satisfies the caller (or a plain
    # cold/expired resolution) resets to the base, so a real publish always
    # converges on the first ask.
    fruitless = hit is not None and hit['expiry'] > now and want is not None and want not in dirs
    floor = min(hit['floor'] * 2, _APP_AUTH_TTL) if fruitless else _VERSION_MISS_REFRACTORY
    _version_dir_cache[key] = {
        'dirs': dirs,
        'expiry': now + _APP_AUTH_TTL,
        'resolvedAt': now,
        'floor': floor,
        'appId': artifact_id,
    }
    # Bounded: expired first, then soonest-to-expire (the hard expiry makes
    # soonest-expiry the least recently resolved, so this is LRU-shaped).
    if len(_version_dir_cache) > 4096:
        for k in [k for k, v in _version_dir_cache.items() if v['expiry'] <= now]:
            _version_dir_cache.pop(k, None)
        if len(_version_dir_cache) > 4096:
            overflow = len(_version_dir_cache) - 4096
            for k in sorted(_version_dir_cache, key=lambda k: _version_dir_cache[k]['expiry'])[:overflow]:
                _version_dir_cache.pop(k, None)
    return dirs


def invalidate_app_serving(artifact_id: str) -> None:
    """Drop every cached serving verdict for one artifact (app or pipe), across all callers.

    Called on every APP deployment change (``broadcast_app_changed`` — build
    stamps, publish/disable/remove, review transitions): the next request
    for the artifact re-resolves instead of answering from a verdict the
    change made stale. Without it a caller that asked for a version while it
    was still building kept its escalated miss floor after the version
    became servable, 404ing for up to the TTL (#2461); and a disable or
    revocation waited out the hard expiry. In-process only, like the deploy
    events that trigger it. ONE cache keyed by the registry id, so a pipe's
    verdicts drop the same way. The miss floor itself is untouched:
    nonexistent-version probers still decay between changes.
    """
    for key in [k for k, entry in _version_dir_cache.items() if entry.get('appId') == artifact_id]:
        _version_dir_cache.pop(key, None)


def _safe_segments(rest: List[str]) -> None:
    """Refuse path segments that must never become STORE paths or Location echoes.

    Raises:
        HTTPException: 404 on an empty, dot, backslash or drive segment.
    """
    for seg in rest:
        if not seg or seg in ('.', '..') or '\\' in seg or ':' in seg:
            raise HTTPException(status_code=404, detail='Not found')


async def _serve_versioned(request: Request, kind: str, artifact_id: str, version: int, rest: List[str]) -> Response:
    """Stream one immutable file of a version's serving tree, for either kind.

    ONE answer (404) for unauthorized, unbuilt, and absent alike — the
    route must not be an existence oracle for private versions. The serving
    dir (``app_deploy.serving_dir_of``) is the only store surface reachable
    here: an app's ``source/`` and ``bundle/`` live outside every dir the
    resolvers return.
    """
    _safe_segments(rest)
    dirs = await _version_dirs_for(request.cookies.get(_APP_COOKIE, ''), kind, artifact_id, want=version)
    serving_dir = dirs.get(version)
    if not serving_dir:
        raise HTTPException(status_code=404, detail='Not found')

    from ai.account.store import Store

    try:
        data = await Store.instance()._store.read_bytes(f'{serving_dir}/{"/".join(rest)}')
    except Exception:
        raise HTTPException(status_code=404, detail='Not found')
    media_type = mimetypes.guess_type(rest[-1])[0] or 'application/octet-stream'
    headers = {'Cache-Control': _BUNDLE_CACHE}
    if media_type == 'text/html':
        # Pages reach search through the shell; an HTML file of the build (a snapshot's raw template, wherever
        # the manifest put it, .htm or any case included) is never one to index.
        headers['X-Robots-Tag'] = 'noindex'
    return Response(content=data, media_type=media_type, headers=headers)


async def artifacts_session(request: Request):
    """Mint the artifact-serving cookie from the caller's Authorization header.

    The token is VALIDATED before any cookie is set: an unauthenticated
    cross-site POST could otherwise plant an attacker's token as the victim's
    cookie (SameSite=Lax restricts when a cookie is SENT, not whether a
    Set-Cookie response is accepted), and later same-site fetches would
    authorize as the attacker. artifact_static re-validates on every serve —
    this is defense in depth, not the only gate. Called by the shell right
    after a successful connect, so a valid session always mints cleanly. The
    cookie's path is '/': it rides /apps/* and /pipelines/* alike.
    """
    auth = request.headers.get('authorization', '')
    token = auth[7:].strip() if auth[:7].lower() == 'bearer ' else auth.strip()
    if not token:
        return JSONResponse({'ok': False})
    if await _authenticated(token) is None:
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
        path='/',
        httponly=True,
        secure=secure,
        samesite='lax',
    )
    return resp


async def artifact_static(request: Request):
    """
    Serve the files of deployed artifacts: ``GET /apps/{path}`` and ``GET /pipelines/{path}``.

    ONE handler, two prefixes; the prefix names the kind (``_KIND_OF_PREFIX``)
    and the registry row's kind picks the serving dir. Three shapes:

    - ``<id>/v<N>/<rest>`` — VERSIONED serving, the canonical, immutable
      form: the registry version's serving tree (an app's built ``dist/``,
      a pipe's ``store/``) streamed from the STORE. Entitlement enforced per
      request (SaaS; OSS is open) through a HARD-expiry verdict cache.
    - ``<id>/<rest>`` (no version) — a 302 to the caller's CURRENT version
      of that path, ``Cache-Control: no-cache`` so the browser asks again
      after a repoint. Resolved through the same verdict cache.
    - ``<id>`` (bare) — RESOLUTION INFO: a small JSON document saying what a
      fetch would serve this caller (``_resolution_of``). The deploy smoke
      test's probe.

    Every miss is the one 404: the route is no existence oracle.

    Raises:
        HTTPException: 404 for every miss.
    """
    # "/apps/rocketride.home/v7/remoteEntry.js" -> apps, [rocketride.home, v7, remoteEntry.js].
    # The ASGI path is the DECODED one (a file name's own '#', '?' and
    # space); request.url.path re-escapes '#' and '?' and would read the
    # store under the escaped spelling. route_path strips a proxy prefix
    # (root_path) the way the router does.
    prefix, _, rest = route_path(request.scope).lstrip('/').partition('/')
    kind = _KIND_OF_PREFIX.get(prefix)
    parts = [p for p in rest.split('/') if p]
    if kind is None or not parts or not _APP_ID_SEG.match(parts[0]):
        raise HTTPException(status_code=404, detail='Not found')
    artifact_id = parts[0]

    # Versioned store-backed serving: the canonical form.
    if len(parts) >= 2:
        version_seg = _VERSION_SEG.match(parts[1])
        if version_seg:
            if len(parts) == 2:
                raise HTTPException(status_code=404, detail='Not found')
            return await _serve_versioned(request, kind, artifact_id, int(version_seg.group(1)), parts[2:])

    # Resolution runs under the same identity as serving (the cookie,
    # anonymous without it).
    info = await _resolution_of(kind, request.cookies.get(_APP_COOKIE, ''), artifact_id)
    if info is None:
        raise HTTPException(status_code=404, detail='Not found')
    if len(parts) == 1:
        # Mutable resolution facts — never let a client pin them.
        return JSONResponse(info, headers={'Cache-Control': 'no-cache, must-revalidate'})
    _safe_segments(parts[1:])
    # request.url.path is DECODED: each segment is re-encoded as file-name
    # data so a name holding a space or a literal '%' redirects to itself
    location = f'/{prefix}/{artifact_id}/v{info["registryVersion"]}/' + '/'.join(quote(p, safe='') for p in parts[1:])
    return Response(status_code=302, headers={'Location': location, 'Cache-Control': 'no-cache'})


_warned_unindexed = False


def warn_published_pages_without_app_url(old: public_pages.Aggregate, new: public_pages.Aggregate) -> None:
    """Swap listener: warn once that published pages go unindexed for lack of ``RR_APP_URL``.

    Without it robots.txt disallows all crawling and the sitemap and llms.txt
    answer 404, which is right for OSS, desktop and staging engines and a
    silent deindexing for a production engine that lost the setting.

    Args:
        old: The aggregate swapped out (unused).
        new: The aggregate swapped in; the legacy list and an empty map publish nothing.
    """
    global _warned_unindexed
    if _warned_unindexed or not new.serves_published_pages():
        return
    _warned_unindexed = True
    warning(
        '[shell] RR_APP_URL is not set but public pages are published: robots.txt disallows all '
        'crawling and /sitemap.xml and /llms.txt answer 404, so search engines will not index them; '
        'set RR_APP_URL to the public origin on an engine that serves the public site'
    )


def _md(text: str) -> str:
    """One line of llms.txt markdown: whitespace collapsed, link syntax escaped.

    Titles and descriptions are manifest text: collapsing newlines stops an
    injected heading or bullet, escaping brackets stops an injected link.
    """
    text = re.sub(r'\s+', ' ', text or '').strip()
    return text.replace('\\', '\\\\').replace('[', '\\[').replace(']', '\\]')


def sitemap_entries() -> list:
    """``(path, page)`` for every listed public page, sorted by path.

    Unlisted pages (``listed: false``) are served but never advertised.
    """
    from .public_pages import current

    return [(page.path, page) for page in current().pages() if page.listed]


def _lastmod(page: Page) -> str:
    """``<lastmod>``: the UTC date of the page's ``modified``, else ``published``; '' when it declares neither.

    A deploy is not a content change. Falling back to when the app's version
    went live would move every undated page's date on each deploy, and search
    engines stop trusting ``lastmod`` site-wide when it is not accurate.
    """
    declared = page.modified or page.published
    if not declared:
        return ''
    return f'<lastmod>{page_instant(declared).date().isoformat()}</lastmod>'


async def sitemap_xml(request: Request):
    """
    Serve ``/sitemap.xml`` — one ``<url>`` per listed public page.

    Pages come from the page aggregate (published manifests, or the legacy
    list until one declares pages), sorted by path, each with its
    ``<lastmod>`` when known. Absolute URLs come exclusively from
    ``RR_APP_URL``. Deployments without it (OSS, self-hosted, desktop) have
    no public marketing site to index, so the endpoint 404s.

    Args:
        request: Incoming HTTP request.

    Returns:
        Response with an XML urlset and ``application/xml`` content type.

    Raises:
        HTTPException: 404 when ``RR_APP_URL`` is not configured.
    """
    from .public_pages import maybe_refresh

    maybe_refresh()
    base_url = app_url()
    if not base_url:
        raise HTTPException(status_code=404, detail='Not found')

    # escape() guards against XML metacharacters in the configured URL.
    entries = ''.join(
        f'  <url><loc>{escape(base_url + path)}</loc>{_lastmod(page)}</url>\n' for path, page in sitemap_entries()
    )

    xml = (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
        f'{entries}'
        '</urlset>\n'
    )
    return Response(
        content=xml,
        media_type='application/xml',
        headers={'Cache-Control': CACHE_CONTROL},
    )


async def robots_txt(request: Request):
    """
    Serve ``/robots.txt`` — policy depends on the deployment mode.

    Hosted SaaS (``RR_APP_URL`` set): allow all crawlers and point at the
    sitemap, with one named group per rostered crawler (the roster that
    also classifies requesters) plus ``*``; every group carries the same
    rule (RFC 9309), so the policy equals ``*`` alone. Any other engine
    (OSS, self-hosted, desktop, staging) is not the public site: all
    crawling is disallowed, published pages or not (plan section 4).

    Args:
        request: Incoming HTTP request.

    Returns:
        PlainTextResponse with the robots policy.
    """
    from .crawlers import robots_groups

    base_url = app_url()

    if base_url:
        content = f'{robots_groups("Allow: /")}Sitemap: {base_url}/sitemap.xml\n'
    else:
        content = 'User-agent: *\nDisallow: /\n'

    return PlainTextResponse(content, headers={'Cache-Control': CACHE_CONTROL})


def _newest_first(page: Page) -> float:
    """Sort key of an llms.txt section: dated pages newest first, then the undated ones."""
    if page.published:
        return -page_instant(page.published).timestamp()
    return math.inf


async def llms_txt(request: Request):
    """
    Serve ``/llms.txt`` — an llmstxt.org index of the public pages.

    The header from the root owner's ``site`` block (the heading falls back
    to the origin's host: llms.txt requires one), one bullet per listed page
    (title and description from the aggregate), and a final link to
    ``site.docsUrl``. A listed page whose parent path (``/blog`` for
    ``/blog/x``) is a listed page goes in that parent's section, headed by
    its title without the trailing `` | <site.title>``; every other page is
    under ``## Pages``, by path. Sections follow by parent path, each with its
    dated pages newest first, then the rest by path. Same gating as the
    sitemap: absolute URLs come exclusively from ``RR_APP_URL``, and the
    endpoint 404s when it is unset.

    Args:
        request: Incoming HTTP request.

    Returns:
        PlainTextResponse with the llms.txt content.

    Raises:
        HTTPException: 404 when ``RR_APP_URL`` is not configured.
    """
    from .public_pages import current, maybe_refresh

    maybe_refresh()
    base_url = app_url()
    if not base_url:
        raise HTTPException(status_code=404, detail='Not found')

    site = current().site or {}
    heading = _md(site.get('title', ''))
    if not heading:
        heading = urlsplit(base_url).netloc
    lines = [f'# {heading}', '']
    if site.get('blurb'):
        lines += [f'> {_md(site["blurb"])}', '']
    listed = dict(sitemap_entries())
    sections: Dict[str, List[Page]] = {'': []}
    for path, page in listed.items():
        parent = path.rpartition('/')[0]
        section = ''
        if parent in listed:
            section = parent
        sections.setdefault(section, []).append(page)
    for parent in sorted(sections):
        pages = sections[parent]
        if parent:
            lines += ['', f'## {_md(own_title(listed[parent].title, site.get("title", "")))}', '']
            # The stable sort keeps path order among pages with the same key.
            pages.sort(key=_newest_first)
        else:
            lines += ['## Pages', '']
        for page in pages:
            bullet = f'- [{_md(page.title)}]({base_url}{page.path})'
            description = _md(page.description)
            if description:
                bullet = f'{bullet}: {description}'
            lines.append(bullet)
    if site.get('docsUrl'):
        lines += ['', '## Documentation', '', f'- [Docs]({_md(site["docsUrl"])})']
    return PlainTextResponse(
        '\n'.join(lines) + '\n',
        media_type='text/plain; charset=utf-8',
        headers={'Cache-Control': CACHE_CONTROL},
    )
