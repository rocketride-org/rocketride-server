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
Per-user dev overlay — the live-manifest mechanism for app development.

A developer's inner loop points THEIR shell at a locally built (or cloud
dev-built) app bundle by registering a ``moduleId -> entry URL`` override
via ``rrext_app_submission.register_dev``. The overlay is:

- **Per user.** Entries registered by one user are applied only to that
  user's app manifest and pushed only to that user's connections —
  multi-tenant safe on SaaS. The OSS local engine has a single implicit
  user (``'local'``), so its overlay is effectively engine-wide.
- **Ephemeral.** Entries are dropped when the registering connection
  disconnects, and in any case expire ``_IDLE_TTL_SECONDS`` after their
  last registration (the watch manager re-registers on every rebuild, so
  active dev sessions stay alive indefinitely).

This is platform infrastructure, not marketplace: it lives in the shared
account package so the OSS engine supports local app development without
SaaS. Consumers:

- SaaS ``account_service.get_authentication_result`` and the OSS
  ``_read_apps_json`` apply ``apply_overlay()`` to the app list they
  assemble.
- ``TaskServer._dapbase_on_disconnected`` calls ``drop_connection()``.
- ``cmd_app`` (OSS base) and the SaaS ``app_handler`` both route the
  ``register_dev`` subcommand to ``handle_register_dev()``.
"""

import time
from typing import Any, Dict, List

from rocketlib import debug

# =============================================================================
# STATE
# =============================================================================

# Idle cap: an entry not re-registered within this window is expired even if
# the registering connection is still open (the dev session went stale).
_IDLE_TTL_SECONDS = 30 * 60

# The overlay itself: {user_id: {module_id: entry}}. Each entry carries:
#   module_id     — MF container name the override applies to
#   url           — dev remoteEntry.js URL the shell should load instead
#   app_id        — app id (falls back to module_id when not supplied)
#   connection_id — the registering connection (for disconnect expiry)
#   expires_at    — monotonic-ish wall-clock expiry (idle cap)
_overlay: Dict[str, Dict[str, Dict[str, Any]]] = {}


# =============================================================================
# CORE OPERATIONS
# =============================================================================


def register(user_id: str, connection_id: Any, module_id: str, url: str, app_id: str) -> None:
    """
    Insert or refresh a dev overlay entry for one user.

    Args:
        user_id:       Owner of the overlay bucket.
        connection_id: Registering connection (drives disconnect expiry).
        module_id:     MF container name to override.
        url:           Dev remoteEntry.js URL.
        app_id:        App id the module belongs to.
    """
    bucket = _overlay.setdefault(user_id, {})
    bucket[module_id] = {
        'module_id': module_id,
        'url': url,
        'app_id': app_id,
        'connection_id': connection_id,
        'expires_at': time.time() + _IDLE_TTL_SECONDS,
    }
    debug(f'[dev_overlay] registered {module_id} -> {url} for user {user_id}')


def unregister(user_id: str, module_id: str) -> bool:
    """
    Remove one overlay entry for a user.

    Args:
        user_id:   Owner of the overlay bucket.
        module_id: MF container name to remove.

    Returns:
        True when an entry was actually removed.
    """
    bucket = _overlay.get(user_id)
    if not bucket:
        return False
    removed = bucket.pop(module_id, None) is not None
    if removed and not bucket:
        _overlay.pop(user_id, None)
    if removed:
        debug(f'[dev_overlay] unregistered {module_id} for user {user_id}')
    return removed


def entries_for(user_id: str) -> List[Dict[str, Any]]:
    """
    Return the live overlay entries for a user, pruning expired ones.

    Args:
        user_id: Owner of the overlay bucket.

    Returns:
        List of entry dicts (possibly empty).
    """
    bucket = _overlay.get(user_id)
    if not bucket:
        return []
    # Lazy idle-cap pruning: drop entries whose last registration is stale
    now = time.time()
    stale = [mid for mid, e in bucket.items() if e.get('expires_at', 0) <= now]
    for mid in stale:
        bucket.pop(mid, None)
        debug(f'[dev_overlay] expired {mid} for user {user_id} (idle cap)')
    if not bucket:
        _overlay.pop(user_id, None)
        return []
    return list(bucket.values())


def drop_connection(user_id: str, connection_id: Any) -> bool:
    """
    Drop all overlay entries a specific connection registered — called from
    the server's disconnect cleanup so a closed dev session cannot leave a
    stale bundle in the user's manifest.

    Args:
        user_id:       Owner of the overlay bucket.
        connection_id: The disconnecting connection.

    Returns:
        True when at least one entry was removed (callers push a refresh).
    """
    bucket = _overlay.get(user_id)
    if not bucket:
        return False
    doomed = [mid for mid, e in bucket.items() if e.get('connection_id') == connection_id]
    for mid in doomed:
        bucket.pop(mid, None)
        debug(f'[dev_overlay] dropped {mid} for user {user_id} (connection closed)')
    if not bucket:
        _overlay.pop(user_id, None)
    return bool(doomed)


# =============================================================================
# MANIFEST APPLICATION
# =============================================================================


def apply_overlay(user_id: str, apps: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """
    Apply a user's overlay to an assembled app list.

    Entries matching an existing app (by moduleId) replace that app's
    ``entry`` URL and flag it ``dev: True``. Entries with no matching app
    append a minimal synthetic manifest entry so a brand-new app under
    development is loadable before it is ever published.

    Args:
        user_id: Whose overlay to apply.
        apps:    Assembled app manifest entries (server dict shape).

    Returns:
        A new list with overrides applied (input list is not mutated).
    """
    entries = entries_for(user_id)
    if not entries:
        return apps

    by_module = {e['module_id']: e for e in entries}
    matched: set = set()

    # Replace entry URLs on matching apps
    out: List[Dict[str, Any]] = []
    for app in apps:
        entry = by_module.get(app.get('moduleId'))
        if entry:
            app = {**app, 'entry': entry['url'], 'dev': True}
            matched.add(entry['module_id'])
        out.append(app)

    # Append synthetic entries for overlay modules with no published app
    for module_id, entry in by_module.items():
        if module_id in matched:
            continue
        out.append(
            {
                'id': entry['app_id'],
                'moduleId': module_id,
                'name': entry['app_id'],
                'description': 'Local development app',
                'entry': entry['url'],
                'dev': True,
                'authenticated': False,
                'public': False,
                'appStatus': 'dev',
                'onDesktop': True,
            }
        )
    return out


# =============================================================================
# PUSH — targeted refresh to ONE user's connections
# =============================================================================


async def push_refresh(server: Any, user_id: str, source: str) -> None:
    """
    Push the refreshed app manifest to every open connection of ONE user.

    Data first, signal second: on SaaS the account is rebuilt and pushed
    via ``push_account_update`` (overlay applied inside the assembly); on
    OSS (no DB-backed account service) the connection's ``AccountInfo.apps``
    is rebuilt in place from apps.json (overlay applied inside) and pushed
    as ``apaext_account``. Then a ``shell:manifestRefresh`` event tells
    consumers WHY the manifest moved.

    Args:
        server:  TaskServer instance (holds the connection registry).
        user_id: The only user whose connections receive the push.
        source:  Refresh reason ('dev-overlay', 'expiry', 'publish', ...).
    """
    from ai.account import account

    # ── Data: rebuilt account payload ────────────────────────────────────
    if getattr(account, '_service', None) is not None:
        # SaaS: one rebuild+push per connection of this user
        try:
            await server.push_account_update(user_id)
        except Exception as exc:
            debug(f'[dev_overlay] push_account_update failed for {user_id}: {exc}')
    else:
        # OSS: rebuild the apps list directly (single implicit user)
        for conn in list(server._connections.values()):
            info = getattr(conn, '_account_info', None)
            if not info or info.userId != user_id:
                continue
            try:
                apps = await account.get_apps_for_user(user_id, [])
                # Mirror the OSS authenticate() decoration: everything is
                # free and on the desktop on a local engine.
                info.apps = [
                    {**a, 'appStatus': a.get('appStatus', 'free'), 'onDesktop': True} for a in apps if a.get('id')
                ]
                await conn.send_event('apaext_account', body=info.to_connect_result())
            except Exception as exc:
                debug(f'[dev_overlay] OSS account push failed: {exc}')

    # ── Signal: why the manifest moved ───────────────────────────────────
    for conn in list(server._connections.values()):
        info = getattr(conn, '_account_info', None)
        if not info or info.userId != user_id:
            continue
        try:
            await conn.send_event('shell:manifestRefresh', body={'source': source})
        except Exception as exc:
            debug(f'[dev_overlay] manifestRefresh push failed: {exc}')


# =============================================================================
# DAP HANDLER — rrext_app_submission.register_dev
# =============================================================================


async def handle_register_dev(conn: Any, request: Dict[str, Any]) -> Dict[str, Any]:
    """
    Handle the ``register_dev`` subcommand for BOTH platform flavours.

    SaaS routes here from ``app_handler._handle_submission`` (already
    Zitadel-authenticated); the OSS base routes here from
    ``Account.handle_app`` before its marketplace NotImplementedError, so
    local app development works without SaaS.

    Args (DAP ``arguments``):
        moduleId:   MF container name to override (required).
        url:        Dev remoteEntry.js URL (required unless unregistering).
        appId:      Owning app id (defaults to moduleId).
        unregister: True to remove the override instead.

    Returns:
        DAP response with ``{registered}`` or ``{unregistered}``.
    """
    # Any authenticated identity may hold a personal overlay — but an
    # identity there must be (the overlay is keyed by it).
    info = getattr(conn, '_account_info', None)
    if not info or not getattr(info, 'userId', None):
        return conn.build_error(request, 'register_dev requires an authenticated connection')
    user_id = info.userId

    args = request.get('arguments', {}) or {}
    module_id = args.get('moduleId', '')
    if not module_id:
        return conn.build_error(request, 'moduleId is required')

    # ── Unregister ───────────────────────────────────────────────────────
    if args.get('unregister', False):
        removed = unregister(user_id, module_id)
        if removed:
            await push_refresh(conn._server, user_id, source='dev-overlay')
        return conn.build_response(request, body={'unregistered': module_id})

    # ── Register / refresh ───────────────────────────────────────────────
    url = args.get('url', '')
    if not url:
        return conn.build_error(request, 'moduleId and url are required')
    if not (url.startswith('http://') or url.startswith('https://') or url.startswith('/')):
        return conn.build_error(request, 'url must be http(s) or server-relative')

    register(user_id, conn.get_connection_id(), module_id, url, args.get('appId', module_id))
    await push_refresh(conn._server, user_id, source='dev-overlay')
    return conn.build_response(request, body={'registered': module_id})
