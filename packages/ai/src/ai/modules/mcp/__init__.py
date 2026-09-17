# Copyright 2026 Aparavi Software AG. MIT License.
"""In-process Streamable-HTTP MCP server module."""

import contextlib
import json
import logging
import os
from typing import Any, Dict, Optional, Tuple
from urllib.parse import urlsplit

from starlette.routing import Mount, Route
from mcp.server.streamable_http_manager import StreamableHTTPSessionManager

from ai.constants import CONST_DEFAULT_WEB_HOST, CONST_DEFAULT_WEB_PORT
from ai.web import oauth_resource

from . import auth
from . import identity
from .engine import make_engine_client
from .handlers import build_mcp_server
from .registry import TaskRegistry

logger = logging.getLogger(__name__)

_MOUNT_PATH = '/mcp'

# The request paths an MCP client may address: the advertised resource
# identifier (bare, no slash -- what spec clients POST to) and its slash form.
_ENDPOINT_PATHS = (_MOUNT_PATH, _MOUNT_PATH + '/')

# Representative paths fed through ``is_public_route`` at startup. The endpoint
# paths alone are not enough: public entries are PATTERNS (compiled with
# Starlette's ``compile_path``), so ``/mcp/{path}`` or ``/mcp/{rest:path}``
# would make AuthMiddleware skip requests the Mount still forwards to
# ``handle_mcp`` -- without ever matching ``/mcp`` or ``/mcp/`` themselves.
# One single-segment and one multi-segment descendant catch both shapes.
_PUBLIC_PROBE_PATHS = _ENDPOINT_PATHS + (
    _MOUNT_PATH + '/probe',
    _MOUNT_PATH + '/probe/nested',
)

# Engine URI schemes that put the caller's credential on the wire in the clear:
# ``handle_mcp`` hands that credential to ``WsEngineClient``, which sends it in
# the first DAP ``auth`` message.
_CLEARTEXT_SCHEMES = ('ws://', 'http://')


class _AsgiEndpoint:
    """Hand a raw ASGI callable to a Starlette ``Route``.

    ``Route`` wraps a plain function as a ``request -> response`` endpoint;
    any other callable is served as an ASGI app, method-agnostic.
    """

    def __init__(self, app: Any) -> None:
        self._app = app

    async def __call__(self, scope: Any, receive: Any, send: Any) -> None:
        await self._app(scope, receive, send)


def _claims_mcp_path(path: Optional[str]) -> bool:
    """Report whether a registered route path lies in the MCP namespace."""
    return bool(path) and (path == _MOUNT_PATH or path.startswith(_MOUNT_PATH + '/'))


def _refuse_existing_claimants(server: Any) -> None:
    """Fail engine boot if anything already owns or opens the MCP paths.

    ``WebServer.add_route`` rejects duplicate ``(method, path)`` pairs, but
    the endpoint below is registered straight onto the router, so that check
    never sees a clash. A route at ``/mcp`` would shadow the bare endpoint
    (a GET-only page answers ``POST /mcp`` with 405), and a public pattern
    matching it -- or any of its DESCENDANTS, since the Mount forwards
    ``/mcp/anything`` to ``handle_mcp`` just the same -- would make
    AuthMiddleware skip those MCP requests.

    Public entries are patterns, not literals, so the endpoint paths are
    probed alongside representative descendants (``_PUBLIC_PROBE_PATHS``).

    Raises:
        RuntimeError: naming the claimant(s).
    """
    claimants = sorted({p for p in (getattr(r, 'path', None) for r in server.app.router.routes) if _claims_mcp_path(p)})
    is_public = getattr(server, 'is_public_route', None)
    if is_public is not None:
        claimants += [f'public:{p}' for p in _PUBLIC_PROBE_PATHS if is_public(p)]
    if claimants:
        raise RuntimeError(
            f'{_MOUNT_PATH} and {_MOUNT_PATH}/* are reserved for the MCP API, but already claimed by: '
            + ', '.join(claimants)
        )


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


def _host_is_configured(server: 'Any', config: Dict[str, Any]) -> bool:
    """Report whether a bind host was set anywhere, or merely defaulted.

    ``CONST_DEFAULT_WEB_HOST`` is ``'localhost'``, so an engine that never sets
    a host is judged loopback and quietly behaves as a *local* engine. That is
    correct on a laptop and a silent misconfiguration in a deployment, and the
    two are indistinguishable from the resolved host alone -- hence this flag,
    which is what makes the startup log able to say which one it is looking at.

    Args:
        server: The WebServer (or test double) that may carry a ``config``.
        config: Module configuration dict.

    Returns:
        bool: True when ``host`` is present in either config.
    """
    server_config = getattr(server, 'config', None) or {}
    return 'host' in server_config or 'host' in config


def _bind_port(server: 'Any', config: Dict[str, Any]) -> int:
    """Return the server's configured port, with the same fallback as WebServer.

    Args:
        server: The WebServer (or test double) that may carry a ``config``.
        config: Module configuration dict, used as a fallback.

    Returns:
        int: The configured port (``CONST_DEFAULT_WEB_PORT`` when unset).
    """
    server_config = getattr(server, 'config', None) or {}
    return int(server_config.get('port', config.get('port', CONST_DEFAULT_WEB_PORT)))


def _redacted_uri(uri: str) -> str:
    """Drop userinfo, query and fragment from a URI so it is safe to log."""
    parts = urlsplit(uri if '://' in uri else '//' + uri)
    scheme = f'{parts.scheme}://' if parts.scheme else ''
    return f'{scheme}{parts.netloc.rpartition("@")[2]}{parts.path}'


def _refuse_cleartext_engine_uri(uri: str, source_value: str, source_name: str) -> None:
    """Fail boot when a non-loopback engine URI would travel in the clear.

    ``handle_mcp`` binds the CALLER's credential to the per-request engine
    client, and ``WsEngineClient`` sends it in the first DAP ``auth`` frame. On
    ``ws://`` that frame is plaintext on the wire, so every MCP caller's API key
    or OAuth token is exposed to anything on the path. A loopback engine never
    leaves the host, so cleartext stays allowed there -- this is only ever
    called for a non-loopback bind.

    Args:
        uri: The resolved engine URI.
        source_value: The value the operator actually set (which may be an
            ``http://`` resource identifier the URI was derived from).
        source_name: The variable that value came from, for the message.

    Raises:
        RuntimeError: naming the offending value and where it came from.
    """
    if not uri.startswith(_CLEARTEXT_SCHEMES):
        return
    raise RuntimeError(
        f'MCP refuses a cleartext engine transport on a non-loopback bind: {source_name}='
        f'{_redacted_uri(source_value)} resolves to {_redacted_uri(uri)}. The caller credential is sent to '
        'the engine in the first DAP auth message, so it must not ride an unencrypted connection -- use '
        'wss:// (or an https:// resource identifier).'
    )


def _resolve_engine_uri(config: Dict[str, Any], bind_host: str, bind_port: int) -> Tuple[str, str]:
    """Resolve the engine URI the MCP tools connect back to.

    The single source for this value: the shared and per-caller engine
    clients, the widget CSP origin and the user-facing upload/dropper links
    all derive from what this returns. Rules, first match wins:

    1. ``explicit`` -- ``config['rocketride_uri']`` or env ``ROCKETRIDE_URI``,
       used as-is.
    2. ``loopback default`` -- a loopback-only bind talks to this engine
       itself, ``ws://<host>:<port>``, so an unconfigured laptop engine never
       silently drives RocketRide's cloud. ``localhost`` maps to
       ``127.0.0.1`` (uvicorn binds a non-literal host as IPv4); ``::1`` is
       bracketed.
    3. ``public default`` -- any other bind (including bind-all / unset) uses
       the public origin of the MCP resource identifier: path dropped,
       ``https`` -> ``wss``, ``http`` -> ``ws``.

    A non-loopback bind additionally requires ENCRYPTED transport: the caller's
    own credential is handed to the engine client, so a ``ws://``/``http://``
    value -- explicit or derived -- is refused rather than quietly used. See
    ``_refuse_cleartext_engine_uri``.

    Args:
        config: Module configuration dict.
        bind_host: The configured bind host (see ``_bind_host``).
        bind_port: The configured bind port (see ``_bind_port``).

    Returns:
        Tuple[str, str]: The URI and the name of the rule that chose it.

    Raises:
        RuntimeError: on a non-loopback bind with a cleartext engine URI.
    """
    loopback = auth.is_loopback_bind(bind_host)
    explicit = config.get('rocketride_uri') or os.environ.get('ROCKETRIDE_URI')
    if explicit:
        if not loopback:
            source_name = 'rocketride_uri' if config.get('rocketride_uri') else 'ROCKETRIDE_URI'
            _refuse_cleartext_engine_uri(explicit, explicit, source_name)
        return explicit, 'explicit'
    if loopback:
        host = '[::1]' if bind_host == '::1' else '127.0.0.1'
        return f'ws://{host}:{bind_port}', 'loopback default'
    resource = oauth_resource.resource_identifier()
    parts = urlsplit(resource)
    scheme = {'https': 'wss', 'http': 'ws'}.get(parts.scheme, parts.scheme)
    uri = f'{scheme}://{parts.netloc.rpartition("@")[2]}'
    _refuse_cleartext_engine_uri(uri, resource, oauth_resource.ENV_RESOURCE)
    return uri, 'public default'


def _log_bind_mode(bind_host: str, local_engine: bool, host_configured: bool) -> None:
    """Log the bind mode MCP resolved, and what that mode grants.

    ``auth.is_loopback_bind`` judges the CONFIGURED host by name, and the
    fallback that host defaults to is ``CONST_DEFAULT_WEB_HOST`` --
    ``'localhost'``. A deployment that never sets ``host`` therefore lands in
    local mode: the dev bypass becomes available, ``send_files`` is listed
    (host-filesystem access), and engine clients forward this process's SDK
    env as the caller's env. None of that is visible from behaviour until
    something goes wrong, so it is stated outright in the first lines of the
    log instead.

    The loopback-BY-FALLBACK case -- local privileges granted because nobody
    said otherwise, rather than because someone asked -- is the silent
    misconfiguration, and is warned about rather than merely noted.

    Args:
        bind_host: The configured bind host (see ``_bind_host``).
        local_engine: The resolved mode (see ``auth.is_loopback_bind``).
        host_configured: Whether a host was set anywhere, or merely defaulted.
    """
    shown = bind_host or '<unset/bind-all>'
    if local_engine:
        logger.info(
            'MCP bind mode: local/loopback (host=%s) -- MCP_DEV_NO_AUTH bypass available, send_files listed '
            '(host filesystem), engine SDK env forwarded as caller env',
            shown,
        )
    else:
        logger.info(
            'MCP bind mode: public/deployed (host=%s) -- MCP_DEV_NO_AUTH bypass refused, send_files not listed, '
            'no engine SDK env forwarded to callers',
            shown,
        )
    if local_engine and not host_configured:
        logger.warning(
            'MCP bind mode is local/loopback only because no host is configured (defaulted to %r). If this is a '
            'deployed engine, set host explicitly: it is currently granting local-engine privileges.',
            CONST_DEFAULT_WEB_HOST,
        )


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

            - ``mcp_dev_no_auth`` (bool): skip auth for ``/mcp`` and
              ``/mcp/`` in dev (loopback binds only).

    Raises:
        RuntimeError: If a route already claims ``/mcp`` or ``/mcp/*``, if a
            public pattern already matches the endpoint or any of its
            descendants, or if a non-loopback bind resolves a cleartext
            (``ws://``/``http://``) engine URI.
    """
    # ------------------------------------------------------------------
    # 1. Hoisted TaskRegistry
    # Created before the engine factory so the same registry instance is
    # handed to build_mcp_server below.
    # ------------------------------------------------------------------
    _refuse_existing_claimants(server)
    task_registry = TaskRegistry()

    # ------------------------------------------------------------------
    # 2. Engine URI + client factory
    # The URI and local_engine are resolved ONCE, here, where the bind
    # host/port are known, and injected into a copy of config so every client
    # the factory builds (shared or per-caller) uses exactly these values.
    # Deferring make_engine_client means a missing ROCKETRIDE_AUTH/APIKEY
    # doesn't raise ValueError at engine boot — only on first request.
    # Per-caller requests (identity.CALLER_AUTH set by handle_mcp below) get
    # a fresh client instead of the shared singleton — see _make_engine_factory.
    # ------------------------------------------------------------------
    bind_host = _bind_host(server, config)
    # Local engine: loopback-only bind, so the engine host is the caller's own
    # machine. Decided once here; gates the host-filesystem tools and whether
    # engine clients forward this process's SDK env (see make_engine_client).
    local_engine = auth.is_loopback_bind(bind_host)
    # The bypass decision is made ONCE, here, and reused by both the public-path
    # registration below and auth.authorize -- see auth.dev_bypass_active.
    dev_no_auth = auth.dev_bypass_active(config, bind_host)
    _log_bind_mode(bind_host, local_engine, _host_is_configured(server, config))
    engine_uri, engine_uri_rule = _resolve_engine_uri(config, bind_host, _bind_port(server, config))
    logger.info('MCP engine URI: %s (%s)', _redacted_uri(engine_uri), engine_uri_rule)
    config = {**config, 'rocketride_uri': engine_uri, 'local_engine': local_engine}
    engine_factory = _make_engine_factory(config)

    # ------------------------------------------------------------------
    # 3. Build MCP server + stateless StreamableHTTP session manager
    # engine_origin is derived from the resolved URI string (not built via
    # engine_factory()) so widget CSP stamping never has to construct --
    # and, on the per-caller path, bucket for later close -- a whole
    # EngineClient just to read a string. See handlers.py's docstring.
    # ------------------------------------------------------------------
    engine_origin = _base_url_from_uri(engine_uri)
    mcp_server = build_mcp_server(engine_factory, task_registry, engine_origin=engine_origin, local_engine=local_engine)

    session_manager = StreamableHTTPSessionManager(
        app=mcp_server,
        event_store=None,
        json_response=False,
        stateless=True,
    )

    # ------------------------------------------------------------------
    # 4. Route the raw ASGI handler at /mcp and /mcp/
    # app.add_api_route / add_route expect FastAPI callables with Request
    # signatures, so the handler goes straight onto the router. A Mount only
    # matches /mcp/..., and bare /mcp -- the advertised resource identifier
    # spec clients POST to -- would otherwise get a 307 to /mcp/ (or be
    # shadowed by any route at /mcp), so an exact, method-agnostic Route
    # serves the bare path too. The session manager is path-agnostic, so
    # both forms behave identically.
    #
    # The audience guard runs first: a Zitadel token must be stamped for the
    # MCP project, or it does not reach the session manager. Static API keys
    # and credential-less dev requests pass straight through — see auth.py.
    # ------------------------------------------------------------------

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

        denial = auth.authorize(scope, bind_host=bind_host, dev_bypass=dev_no_auth)
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
    server.app.router.routes.append(Route(_MOUNT_PATH, endpoint=_AsgiEndpoint(handle_mcp), include_in_schema=False))

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

    # dev_no_auth was decided once in section 2 via auth.dev_bypass_active --
    # the same answer handle_mcp passes to auth.authorize. Asking for the
    # bypass on a public bind is refused (auth stays on) rather than failing
    # engine boot, so say so instead of leaving the setting looking effective.
    if auth.dev_bypass_requested(config) and not dev_no_auth:
        logger.warning(
            'MCP_DEV_NO_AUTH ignored: server binds %s (non-loopback); /mcp stays authenticated',
            bind_host or '<unset/bind-all>',
        )
    if dev_no_auth:
        # Exactly the two endpoint paths -- never a /mcp/{path} pattern, and
        # never outside this loopback-only branch.
        if hasattr(server, '_public_paths'):
            server._public_paths.extend(_ENDPOINT_PATHS)
            # Invalidate the compiled-regex cache so the next is_public_route()
            # call re-builds from the updated list.
            if hasattr(server, '_compiled_public_paths'):
                server._compiled_public_paths = None
        if hasattr(server, 'public'):
            server.public.update(_ENDPOINT_PATHS)
