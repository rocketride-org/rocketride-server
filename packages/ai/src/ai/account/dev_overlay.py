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
via ``rrext_deploy_app.register_dev`` (the OSS dispatch routes register_dev
only under the ``rrext_deploy_app`` command). The overlay is:

- **Per user.** Entries registered by one user are applied only to that
  user's app manifest and pushed only to that user's connections —
  multi-tenant safe on SaaS. The OSS local engine has a single implicit
  user (``'local'``), so its overlay is effectively engine-wide.
- **Per connection.** Each registering connection owns its own entry per
  module, so several editors (VS Code + Cursor, two windows) can dev-serve
  the same app concurrently without clobbering each other's registration.
  Shells route by the editor's session nonce, or take the newest entry.
- **Ephemeral.** Entries are dropped when the registering connection
  disconnects, and in any case expire ``_IDLE_TTL_SECONDS`` after their
  last registration (the watch manager re-registers on every rebuild, so
  active dev sessions stay alive indefinitely).

This is platform infrastructure, not marketplace: it lives in the shared
account package so the OSS engine supports local app development without
SaaS. Consumers:

- SaaS ``account_service.get_authentication_result`` and the OSS
  assembly paths (``_assemble_apps`` / ``get_public_apps``) apply
  ``apply_overlay()`` to the app list they assemble.
- ``TaskServer._dapbase_on_disconnected`` calls ``drop_connection()``.
- ``cmd_app`` (OSS base) and the SaaS ``app_handler`` both route the
  ``register_dev`` subcommand to ``handle_register_dev()``.
"""

import time
from typing import Any, Dict, List, Optional

from rocketlib import debug

# =============================================================================
# STATE
# =============================================================================

# Idle cap: an entry not re-registered within this window is expired even if
# the registering connection is still open (the dev session went stale).
_IDLE_TTL_SECONDS = 30 * 60

# The overlay itself: {user_id: {module_id: {connection_id: entry}}}. One
# entry PER REGISTERING CONNECTION, not per module: two editors (VS Code +
# Cursor, or two windows) each dev-serving the same app hold independent
# registrations that expire independently — the singleton model made them
# clobber each other's URL on every rebuild, and connected shells looped
# chasing the flip-flopping registration. Each entry carries:
#   module_id     — MF container name the override applies to
#   url           — dev remoteEntry.js URL the shell should load instead
#   app_id        — app id (falls back to module_id when not supplied)
#   connection_id — the registering connection (for disconnect expiry)
#   session       — the registering editor's session nonce (preview routing)
#   registered_at — wall-clock stamp; newest entry is the default pick
#   expires_at    — monotonic-ish wall-clock expiry (idle cap)
_overlay: Dict[str, Dict[str, Dict[Any, Dict[str, Any]]]] = {}


# =============================================================================
# CORE OPERATIONS
# =============================================================================


def register(
    user_id: str,
    connection_id: Any,
    module_id: str,
    url: str,
    app_id: str,
    session: str = '',
    meta: Optional[Dict[str, str]] = None,
) -> None:
    """
    Insert or refresh THIS connection's dev overlay entry for one module.

    Sibling connections' entries for the same module are untouched — each
    editor owns exactly one entry per module and can only ever write its own.

    Args:
        user_id:       Owner of the overlay bucket.
        connection_id: Registering connection (drives disconnect expiry).
        module_id:     MF container name to override.
        url:           Dev remoteEntry.js URL.
        app_id:        App id the module belongs to.
        session:       The registering editor's session nonce ('' when the
                       client predates session routing).
        meta:          Display basics from the app's local manifest
                       ('name'/'description'/'appVersion'/'icon' data URI) —
                       consumed by the SYNTHETIC tile of a never-published
                       app so it renders like a store tile; a matched
                       published app keeps its manifest values.
    """
    module_bucket = _overlay.setdefault(user_id, {}).setdefault(module_id, {})
    module_bucket[connection_id] = {
        'module_id': module_id,
        'url': url,
        'app_id': app_id,
        'connection_id': connection_id,
        'session': session,
        'meta': dict(meta) if meta else {},
        'registered_at': time.time(),
        'expires_at': time.time() + _IDLE_TTL_SECONDS,
    }
    debug(f'[dev_overlay] registered {module_id} -> {url} for user {user_id} (conn {connection_id})')


def unregister(user_id: str, module_id: str, connection_id: Any = None) -> bool:
    """
    Remove overlay entries for one module of one user.

    With ``connection_id``, only THAT connection's entry goes — one editor
    unregistering must never tear down a sibling editor's live registration.
    Without it, every connection's entry for the module is removed.

    Args:
        user_id:       Owner of the overlay bucket.
        module_id:     MF container name to remove.
        connection_id: Restrict removal to this connection's entry.

    Returns:
        True when at least one entry was actually removed.
    """
    bucket = _overlay.get(user_id)
    if not bucket:
        return False
    module_bucket = bucket.get(module_id)
    if not module_bucket:
        return False
    if connection_id is None:
        removed = bool(module_bucket)
        bucket.pop(module_id, None)
    else:
        removed = module_bucket.pop(connection_id, None) is not None
        if not module_bucket:
            bucket.pop(module_id, None)
    if not bucket:
        _overlay.pop(user_id, None)
    if removed:
        debug(f'[dev_overlay] unregistered {module_id} for user {user_id} (conn {connection_id})')
    return removed


def entries_for(user_id: str) -> List[Dict[str, Any]]:
    """
    Return the live overlay entries for a user, pruning expired ones.

    Multiple entries may share a module_id (one per registering connection).

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
    out: List[Dict[str, Any]] = []
    for mid in list(bucket.keys()):
        module_bucket = bucket[mid]
        for conn_id in list(module_bucket.keys()):
            if module_bucket[conn_id].get('expires_at', 0) <= now:
                module_bucket.pop(conn_id, None)
                debug(f'[dev_overlay] expired {mid} for user {user_id} (idle cap, conn {conn_id})')
        if not module_bucket:
            bucket.pop(mid, None)
        else:
            out.extend(module_bucket.values())
    if not bucket:
        _overlay.pop(user_id, None)
    return out


def drop_connection(user_id: str, connection_id: Any) -> bool:
    """
    Drop all overlay entries a specific connection registered — called from
    the server's disconnect cleanup so a closed dev session cannot leave a
    stale bundle in the user's manifest. Sibling connections' entries for
    the same modules survive.

    Args:
        user_id:       Owner of the overlay bucket.
        connection_id: The disconnecting connection.

    Returns:
        True when at least one entry was removed (callers push a refresh).
    """
    bucket = _overlay.get(user_id)
    if not bucket:
        return False
    dropped = False
    for mid in list(bucket.keys()):
        module_bucket = bucket[mid]
        if module_bucket.pop(connection_id, None) is not None:
            dropped = True
            debug(f'[dev_overlay] dropped {mid} for user {user_id} (connection closed)')
        if not module_bucket:
            bucket.pop(mid, None)
    if not bucket:
        _overlay.pop(user_id, None)
    return dropped


# =============================================================================
# MANIFEST APPLICATION
# =============================================================================


def drop_user(user_id: str) -> bool:
    """
    Drop EVERY overlay entry for a user, regardless of registering connection.

    Called on an org switch: the bucket is keyed by ``user_id`` with no org
    stamp, so a reconnect alone will not clear it and ``apply_overlay`` would
    keep re-applying the previous org's dev bundles onto the new org's manifest
    on every rebuild. Emptying the bucket is the only reliable clear.

    Args:
        user_id: Owner of the overlay bucket.

    Returns:
        True when the bucket held at least one entry (callers push a refresh).
    """
    bucket = _overlay.pop(user_id, None)
    if bucket:
        debug(f'[dev_overlay] dropped all {len(bucket)} entries for user {user_id} (org switch)')
    return bool(bucket)


def apply_overlay(user_id: str, apps: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """
    Apply a user's overlay to an assembled app list.

    Modules matching an existing app (by moduleId) replace that app's
    ``entry`` URL and flag it ``dev: True``; modules with no matching app
    append a minimal synthetic manifest entry so a brand-new app under
    development is loadable before it is ever published.

    A module may carry SEVERAL live registrations (one per editor session).
    Every one rides along as ``devEntries`` — newest first — so shells can
    route a preview to the editor that launched it (session nonce match);
    ``entry`` carries the newest registration as the default for shells
    with no session affinity.

    Args:
        user_id: Whose overlay to apply.
        apps:    Assembled app manifest entries (server dict shape).

    Returns:
        A new list with overrides applied (input list is not mutated).
    """
    entries = entries_for(user_id)
    if not entries:
        return apps

    # Group per module, newest registration first
    by_module: Dict[str, List[Dict[str, Any]]] = {}
    for e in entries:
        by_module.setdefault(e['module_id'], []).append(e)
    for group in by_module.values():
        group.sort(key=lambda e: e.get('registered_at', 0), reverse=True)

    def wire_entries(group: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """Client-facing devEntries rows (camelCase, newest first)."""
        return [
            {'url': e['url'], 'session': e.get('session', ''), 'registeredAt': e.get('registered_at', 0)} for e in group
        ]

    matched: set = set()

    # Replace entry URLs on matching apps (newest registration is the default)
    out: List[Dict[str, Any]] = []
    for app in apps:
        group = by_module.get(app.get('moduleId'))
        if group:
            app = {**app, 'entry': group[0]['url'], 'dev': True, 'devEntries': wire_entries(group)}
            matched.add(group[0]['module_id'])
        out.append(app)

    # Append synthetic entries for overlay modules with no published app.
    # The registering editor supplies the app's local manifest basics
    # (register_dev meta) so the tile renders like a store tile — name,
    # description, icon, semver — instead of a bare id; the fallbacks
    # serve registrations from clients that predate the meta fields.
    for module_id, group in by_module.items():
        if module_id in matched:
            continue
        newest = group[0]
        meta = newest.get('meta') or {}
        out.append(
            {
                'id': newest['app_id'],
                'moduleId': module_id,
                'name': meta.get('name') or newest['app_id'],
                'description': meta.get('description') or 'Local development app',
                'icon': meta.get('icon') or '',
                'version': meta.get('appVersion') or '',
                'entry': newest['url'],
                'dev': True,
                'devEntries': wire_entries(group),
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
        # One rebuild serves every connection: the list depends only on
        # user_id, and each rebuild re-walks the deployment registry and
        # mints a signed URL per deployed app.
        try:
            apps = await account.get_apps_for_user(user_id, [])
        except Exception as exc:
            debug(f'[dev_overlay] OSS apps rebuild failed: {exc}')
            apps = None
        for conn in list(server._connections.values()):
            info = getattr(conn, '_account_info', None)
            if apps is None or not info or info.userId != user_id:
                continue
            # Skip task-scoped connections (see push_account_update): never push
            # a full-user rebuild onto a pk_/tk_ socket.
            if (getattr(info, 'auth', '') or '').startswith(('pk_', 'tk_')):
                continue
            try:
                # Mirror the OSS authenticate() decoration: everything is
                # free and on the desktop on a local engine.
                info.apps = [
                    {**a, 'appStatus': a.get('appStatus', 'free'), 'onDesktop': True} for a in apps if a.get('id')
                ]
                await conn.send_event('apaext_account', body=info.to_push_result())
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
# DAP HANDLER — rrext_deploy_app.register_dev
# =============================================================================

# Display-metadata caps. Oversize or malformed values are DROPPED, never
# fatal — the metadata is cosmetic (the synthetic tile's face) and a stale
# or hand-rolled client must still be able to register its dev server.
_META_TEXT_CAPS = {'name': 200, 'description': 2000, 'appVersion': 100}
# 256 KiB icon file, base64-inflated (4/3) plus the data: header.
_META_ICON_MAX_CHARS = 400_000


def _sanitize_meta(args: Dict[str, Any]) -> Dict[str, str]:
    """The registration's display metadata — capped, typed, best-effort."""
    meta: Dict[str, str] = {}
    for key, cap in _META_TEXT_CAPS.items():
        value = args.get(key)
        if isinstance(value, str) and value.strip() and len(value) <= cap:
            meta[key] = value.strip()
    icon = args.get('icon')
    if isinstance(icon, str) and icon.startswith('data:image/') and len(icon) <= _META_ICON_MAX_CHARS:
        meta['icon'] = icon
    return meta


async def handle_register_dev(conn: Any, request: Dict[str, Any]) -> Dict[str, Any]:
    """
    Handle the ``register_dev`` subcommand for BOTH platform flavours.

    SaaS routes here from ``app_handler._handle_submission`` (already
    Zitadel-authenticated); the OSS base routes here from
    ``Account.handle_app`` before its marketplace NotImplementedError, so
    local app development works without SaaS.

    Args (DAP ``arguments``):
        moduleId:    MF container name to override (required).
        url:         Dev remoteEntry.js URL (required unless unregistering).
        appId:       Owning app id (defaults to moduleId).
        session:     The editor's session nonce (routes previews launched
                     from that editor to ITS registration; optional).
        name:        Display name from the app's local manifest (optional).
        description: Manifest description (optional).
        appVersion:  Manifest semver for the tile's version line (optional).
        icon:        Manifest icon as a data:image/ URI, ≤ 400k chars
                     (optional). All four feed the SYNTHETIC tile of a
                     never-published app; invalid values are dropped.
        unregister:  True to remove THIS connection's override instead.

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
        # Connection-scoped: one editor closing its panel must never tear
        # down a sibling editor's live registration for the same module.
        removed = unregister(user_id, module_id, conn.get_connection_id())
        if removed:
            await push_refresh(conn._server, user_id, source='dev-overlay')
        return conn.build_response(request, body={'unregistered': module_id})

    # ── Register / refresh ───────────────────────────────────────────────
    url = args.get('url', '')
    if not url:
        return conn.build_error(request, 'moduleId and url are required')
    if not (url.startswith('http://') or url.startswith('https://') or url.startswith('/')):
        return conn.build_error(request, 'url must be http(s) or server-relative')

    register(
        user_id,
        conn.get_connection_id(),
        module_id,
        url,
        args.get('appId', module_id),
        session=str(args.get('session', '') or ''),
        meta=_sanitize_meta(args),
    )
    await push_refresh(conn._server, user_id, source='dev-overlay')
    return conn.build_response(request, body={'registered': module_id})
