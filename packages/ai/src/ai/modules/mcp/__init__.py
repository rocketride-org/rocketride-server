# Copyright 2026 Aparavi Software AG. MIT License.
"""In-process Streamable-HTTP MCP server module."""

import contextlib
import json
import logging
import os
from typing import Any, Dict, Optional

from starlette.routing import Mount
from mcp.server.streamable_http_manager import StreamableHTTPSessionManager

from ai.constants import CONST_DEFAULT_WEB_HOST
from ai.web import oauth_resource

from . import auth
from . import identity
from .engine import make_engine_client
from .handlers import build_mcp_server
from .registry import TaskRegistry

logger = logging.getLogger(__name__)

_MOUNT_PATH = '/mcp'


def _base_url_from_uri(uri: str) -> str:
    """Normalize a configured ``rocketride_uri`` to its HTTP(S) origin.

    Mirrors ``WsEngineClient.base_url`` exactly (ws(s):// -> http(s)://, no
    trailing slash) but works from the raw configured string, so callers that
    only need the origin -- not a connected client -- don't have to build one.
    """
    uri = uri or ''
    if uri.startswith('ws://'):
        uri = 'http://' + uri[len('ws://') :]
    elif uri.startswith('wss://'):
        uri = 'https://' + uri[len('wss://') :]
    return uri.rstrip('/')


def _make_engine_factory(config: Dict[str, Any]) -> Any:
    """Build the zero-arg engine-client factory closure.

    Two paths, chosen per call by ``identity.CALLER_AUTH``:

    - Set (a per-request caller credential is bound, see ``handle_mcp``): a
      FRESH client is built from ``{**config, 'rocketride_auth': auth}`` --
      never cached -- and appended to the ``identity.REQUEST_CLIENTS`` bucket
      when one is bound, so ``handle_mcp`` can close it after the request.
    - Unset: the pre-integrations lazy-singleton path, unchanged -- the first
      call builds one long-lived client from ``config`` alone and every later
      call (with CALLER_AUTH still unset) returns that same instance.

    The mutable singleton state is exposed as ``factory._state`` so
    `initModule`'s shutdown hook can still close the shared client without a
    second closure variable escaping this function.
    """
    _state: Dict[str, Any] = {'client': None}

    def factory() -> Any:
        caller_auth = identity.CALLER_AUTH.get()
        if caller_auth is not None:
            client = make_engine_client({**config, 'rocketride_auth': caller_auth})
            bucket = identity.REQUEST_CLIENTS.get()
            if bucket is not None:
                bucket.append(client)
            return client
        if _state['client'] is None:
            _state['client'] = make_engine_client(config)
        return _state['client']

    factory._state = _state
    return factory


def _bind_host(server: 'Any', config: Dict[str, Any]) -> str:
    """Return the server's configured bind host.

    Reads the configured value rather than the resolved address — a hostname
    that merely *resolves* to loopback is not treated as loopback. An empty or
    absent host means bind-all in most ASGI stacks, so it is never coerced to
    a loopback literal.

    Args:
        server: The WebServer (or test double) that may carry a ``config``.
        config: Module configuration dict, used as a fallback.

    Returns:
        str: The configured host, or ``''`` when unset.
    """
    server_config = getattr(server, 'config', None) or {}
    # The fallback MUST be the same constant WebServer binds with (server.py):
    # a divergent copy here fails open — the guard would answer 'localhost'
    # while the server binds something wider, and is_loopback_bind() would
    # wave MCP_DEV_NO_AUTH through on a publicly reachable bind.
    host = server_config.get('host', config.get('host', CONST_DEFAULT_WEB_HOST))
    return str(host) if host is not None else ''


def initModule(server: 'Any', config: Dict[str, Any]) -> None:
    """Mount the Streamable-HTTP MCP endpoint on the engine web server.

    Builds a lazy-singleton EngineClient (deferred until first request so
    missing credentials don't crash the engine at boot; used whenever a
    request carries no caller credential -- see ``_make_engine_factory``),
    wires a stateless StreamableHTTPSessionManager at ``/mcp``, runs its
    lifespan across app startup/shutdown, and applies the auth seam.

    Args:
        server: The WebServer (or FakeServer in tests) providing ``.app``
            and optional public-path registration hooks.
        config: Module configuration dict. Recognised keys:

            - ``mcp_dev_no_auth`` (bool): skip auth for ``/mcp`` in dev.
    """
    # ------------------------------------------------------------------
    # 1. Hoisted TaskRegistry
    # Created before the engine factory so the same registry instance is
    # handed to build_mcp_server below.
    # ------------------------------------------------------------------
    task_registry = TaskRegistry()

    # ------------------------------------------------------------------
    # 2. Engine client factory
    # Deferring make_engine_client means missing ROCKETRIDE_URI/AUTH env
    # vars don't raise ValueError at engine boot — only on first request.
    # Per-caller requests (identity.CALLER_AUTH set by handle_mcp below) get
    # a fresh client instead of the shared singleton — see _make_engine_factory.
    # ------------------------------------------------------------------
    engine_factory = _make_engine_factory(config)

    # ------------------------------------------------------------------
    # 3. Build MCP server + stateless StreamableHTTP session manager
    # engine_origin is read straight from the configured URI (not built via
    # engine_factory()) so widget CSP stamping never has to construct --
    # and, on the per-caller path, bucket for later close -- a whole
    # EngineClient just to read a string. See handlers.py's docstring.
    # ------------------------------------------------------------------
    _configured_uri = config.get('rocketride_uri') or os.environ.get('ROCKETRIDE_URI') or ''
    engine_origin = _base_url_from_uri(_configured_uri) if _configured_uri else None
    mcp_server = build_mcp_server(engine_factory, task_registry, engine_origin=engine_origin)

    session_manager = StreamableHTTPSessionManager(
        app=mcp_server,
        event_store=None,
        json_response=False,
        stateless=True,
    )

    # ------------------------------------------------------------------
    # 4. Mount the raw ASGI handler at /mcp
    # app.add_api_route / add_route expect FastAPI callables with Request
    # signatures; a raw ASGI app must be mounted via starlette.routing.Mount.
    #
    # The audience guard runs first: a Zitadel token must be stamped for the
    # MCP project, or it does not reach the session manager. Static API keys
    # and credential-less dev requests pass straight through — see auth.py.
    # ------------------------------------------------------------------
    bind_host = _bind_host(server, config)

    async def _reject(send: Any, message: str) -> None:
        """Send a 401 carrying the discovery challenge, in raw ASGI."""
        body = json.dumps({'error': message}).encode()
        await send(
            {
                'type': 'http.response.start',
                'status': 401,
                'headers': [
                    (b'content-type', b'application/json'),
                    (
                        b'www-authenticate',
                        oauth_resource.www_authenticate_value(error='invalid_token', description=message).encode(
                            'latin-1'
                        ),
                    ),
                    (b'content-length', str(len(body)).encode()),
                ],
            }
        )
        await send({'type': 'http.response.body', 'body': body})

    async def handle_mcp(scope: Any, receive: Any, send: Any) -> None:
        # AuthMiddleware is a BaseHTTPMiddleware, which only wraps 'http'
        # scopes — a websocket routed here by Mount would arrive with no
        # authentication having run at all. The transport is HTTP/SSE only,
        # so refuse anything else rather than hand it to the session manager.
        if scope.get('type') != 'http':
            if scope.get('type') == 'websocket':
                await send({'type': 'websocket.close', 'code': 1008})
            return

        denial = auth.authorize(scope, bind_host=bind_host)
        if denial is not None:
            await _reject(send, denial)
            return

        # Only past the auth gate does the stashed credential (if any) become
        # the per-request caller identity — presence of mcp_credential alone
        # does not imply an authorized request (auth.authorize stashes it on
        # rejected requests too, but those never reach here).
        caller_auth = identity.credential_from_scope(scope)
        auth_token = identity.CALLER_AUTH.set(caller_auth)
        # Bind the bucket to a local name and pass THAT object to .set() --
        # draining `bucket` below (rather than calling REQUEST_CLIENTS.get()
        # again) means a downstream .set() (e.g. a nested/re-entrant call
        # sharing this context) can never swap the ContextVar out from under
        # the drain and orphan the clients engine_factory() actually appended
        # into this request's bucket.
        bucket: list = []
        clients_token = identity.REQUEST_CLIENTS.set(bucket)
        try:
            await session_manager.handle_request(scope, receive, send)
        finally:
            # `pending` carries a cancellation (or other non-Exception
            # BaseException) delivered while closing a client. Catching it
            # per-client keeps the drain going instead of abandoning the rest
            # of `bucket`, and stashing it here — rather than letting it
            # propagate immediately — means the ContextVar resets in the
            # inner `finally` below are never skipped by an in-flight
            # cancellation. It is re-raised once cleanup has fully run so the
            # caller's cancellation still lands.
            pending: Optional[BaseException] = None
            try:
                for client in bucket:
                    try:
                        await client.close()
                    except Exception:  # noqa: BLE001 - one failed close must not skip the rest
                        logger.exception('failed to close per-request MCP engine client')
                    except BaseException as exc:  # noqa: BLE001 - see `pending` note above
                        logger.warning('per-request MCP engine client close interrupted by %r; continuing drain', exc)
                        pending = exc
            finally:
                identity.REQUEST_CLIENTS.reset(clients_token)
                identity.CALLER_AUTH.reset(auth_token)
            if pending is not None:
                raise pending

    server.app.router.routes.append(Mount(_MOUNT_PATH, app=handle_mcp))

    # ------------------------------------------------------------------
    # 5. Session-manager lifespan + engine-client teardown
    #
    # Strategy: register via app.router.add_event_handler for the
    # FakeServer case (no custom lifespan → router events fire).
    # For the real WebServer (which uses a custom _lifespan context that
    # does NOT fire router events), we chain into _user_startup/_user_shutdown
    # so the manager's run() context spans the app lifetime correctly.
    # ------------------------------------------------------------------
    _stack = contextlib.AsyncExitStack()
    # Idempotency: hooks are registered on BOTH the router events and the
    # _user_startup/_user_shutdown slots below. A server that fires both
    # paths must not enter session_manager.run() twice or double-close the
    # shared engine client.
    _lifecycle = {'started': False, 'stopped': False}

    async def _startup() -> None:
        if _lifecycle['started']:
            return
        # Flag only after the transition succeeds: a failed enter must leave
        # the other lifecycle path free to retry instead of returning early
        # against a session manager that never actually started.
        await _stack.enter_async_context(session_manager.run())
        _lifecycle['started'] = True

    async def _shutdown() -> None:
        if _lifecycle['stopped']:
            return
        # Stop the session manager first so in-flight requests drain, then
        # release the shared engine client. try/finally guarantees the client
        # is closed even if session-manager teardown raises, and that the
        # session-manager context is exited even if client.close() raises.
        # The stopped flag is set only after both complete, so a raising
        # teardown stays retryable from the other lifecycle path.
        try:
            await _stack.aclose()
        finally:
            singleton = engine_factory._state['client']
            if singleton is not None:
                await singleton.close()
        _lifecycle['stopped'] = True

    # Always register on the router — fires when there is no custom lifespan
    # (FakeServer / plain FastAPI).
    server.app.router.add_event_handler('startup', _startup)
    server.app.router.add_event_handler('shutdown', _shutdown)

    # Real WebServer: also chain into the user startup/shutdown slots so the
    # session manager's run() context actually fires through _lifespan.
    #
    # Ordering contract: this snapshots whatever is currently in
    # _user_startup/_user_shutdown and wraps it, so chaining is strictly
    # additive — the previous hook (if any) still runs, just before/after
    # ours. This only holds as long as every later registrant does the same
    # snapshot-and-wrap dance. If a future overlay (e.g. a SaaS module
    # composing modules after `mcp`) ever ASSIGNS `_user_startup`/
    # `_user_shutdown` directly instead of chaining through the existing
    # value, it would silently clobber the closures below and the MCP
    # session-manager lifespan (and engine-client teardown) would stop
    # firing. `mcp` must keep being registered so it composes with, not
    # after-and-blind-to, whatever is already installed.
    if hasattr(server, '_user_startup') or hasattr(server, '_user_shutdown'):
        _prev_startup = getattr(server, '_user_startup', None)
        _prev_shutdown = getattr(server, '_user_shutdown', None)

        async def _chained_startup() -> None:
            await _startup()
            if _prev_startup is not None:
                await _prev_startup()

        async def _chained_shutdown() -> None:
            # finally: a failing earlier hook must not leave the session
            # manager and shared EngineClient open during partial shutdown.
            try:
                if _prev_shutdown is not None:
                    await _prev_shutdown()
            finally:
                await _shutdown()

        server._user_startup = _chained_startup
        server._user_shutdown = _chained_shutdown

    # ------------------------------------------------------------------
    # 6. Auth seam
    #
    # /mcp is an OAuth 2.0 protected resource. Publish its RFC 9728 metadata
    # document first — that document is public by necessity, since it is what
    # an unauthenticated client reads in order to discover which authorization
    # server to log in against. Registering it through add_route(public=True)
    # is what places it on the auth middleware's bypass list.
    #
    # Then apply the dev bypass, which is about /mcp itself, not the document.
    # Real WebServer: _public_paths is the backing list; we append and
    #   invalidate the compiled-regex cache.
    # FakeServer / test double: keeps a plain `public` set.
    # ------------------------------------------------------------------
    if hasattr(server, 'add_route'):
        oauth_resource.register_routes(server)

    dev_no_auth = bool(config.get('mcp_dev_no_auth')) or os.environ.get('MCP_DEV_NO_AUTH') == '1'
    if dev_no_auth:
        # Loopback-only: an unauthenticated /mcp on a public bind hands the
        # whole tool surface (pipeline execution, store access) to anyone who
        # can reach it. Refuse the bypass (auth stays on) rather than fail
        # engine boot.
        if not auth.is_loopback_bind(bind_host):
            logger.warning(
                'MCP_DEV_NO_AUTH ignored: server binds %s (non-loopback); /mcp stays authenticated',
                bind_host or '<unset/bind-all>',
            )
            dev_no_auth = False
    if dev_no_auth:
        if hasattr(server, '_public_paths'):
            server._public_paths.append(_MOUNT_PATH)
            # Invalidate the compiled-regex cache so the next is_public_route()
            # call re-builds from the updated list.
            if hasattr(server, '_compiled_public_paths'):
                server._compiled_public_paths = None
        if hasattr(server, 'public'):
            server.public.add(_MOUNT_PATH)
