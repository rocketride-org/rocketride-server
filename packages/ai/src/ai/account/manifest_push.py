# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================
"""
Targeted app-manifest refresh to ONE user's connections.

Used by the build and publish flows to tell a user's open shells that the
app manifest moved (new build finished, version published). Extracted from
the retired dev-overlay module: publish refreshes are platform behavior,
not a dev feature, and they outlive the dev overlay's removal.
"""

from typing import Any

from rocketlib import debug


async def push_account(server: Any, user_id: str) -> None:
    """
    Push the rebuilt account payload to every open connection of ONE user.

    On SaaS the account is rebuilt and pushed via ``push_account_update``;
    on OSS (no DB-backed account service) the connection's
    ``AccountInfo.apps`` is rebuilt in place — decorated by the account
    layer with the user's real desktop — and pushed as ``apaext_account``.
    The desktop writes (``desktop_add`` / ``desktop_remove``) call this
    directly: the manifest did not move, only the user's membership did.

    Args:
        server:  TaskServer instance (holds the connection registry).
        user_id: The only user whose connections receive the push.
    """
    from ai.account import account

    if getattr(account, '_service', None) is not None:
        # SaaS: one rebuild+push per connection of this user
        try:
            await server.push_account_update(user_id)
        except Exception as exc:
            debug(f'[manifest_push] push_account_update failed for {user_id}: {exc}')
    else:
        # OSS: rebuild the apps list directly (single implicit user).
        # One rebuild serves every connection: the list depends only on
        # user_id, and each rebuild re-walks the deployment registry and
        # mints a signed URL per deployed app.
        try:
            apps = await account.get_apps_for_user(user_id, [])
        except Exception as exc:
            debug(f'[manifest_push] OSS apps rebuild failed: {exc}')
            apps = None
        for conn in list(server._connections.values()):
            info = getattr(conn, '_account_info', None)
            if apps is None or not info or info.userId != user_id:
                continue
            try:
                # The OSS authenticate() decoration already rode in with the
                # rebuilt list (free + the user's real desktop membership).
                info.apps = [a for a in apps if a.get('id')]
                await conn.send_event('apaext_account', body=info.to_push_result())
            except Exception as exc:
                debug(f'[manifest_push] OSS account push failed: {exc}')


async def push_refresh(server: Any, user_id: str, source: str) -> None:
    """
    Push the refreshed app manifest to every open connection of ONE user.

    Data first, signal second: ``push_account`` rebuilds and pushes the
    account payload, then a ``shell:manifestRefresh`` event tells consumers
    WHY the manifest moved.

    Args:
        server:  TaskServer instance (holds the connection registry).
        user_id: The only user whose connections receive the push.
        source:  Refresh reason ('app-build', 'app-publish', ...).
    """
    # -- Data: rebuilt account payload ---------------------------------------
    await push_account(server, user_id)

    # -- Signal: why the manifest moved ---------------------------------------
    for conn in list(server._connections.values()):
        info = getattr(conn, '_account_info', None)
        if not info or info.userId != user_id:
            continue
        try:
            await conn.send_event('shell:manifestRefresh', body={'source': source})
        except Exception as exc:
            debug(f'[manifest_push] manifestRefresh push failed: {exc}')
