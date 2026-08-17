# Copyright 2026 Aparavi Software AG. MIT License.
"""Assemble the low-level MCP Server: registry-based tool dispatch + resources.

Tools are no longer a dynamic per-pipeline surface. A single `ToolRegistry` is
built once per server and populated by `tools.register_all`; `list_tools`
returns its contents and `call_tool` dispatches to its handlers. There is no
prompt surface -- "knowledge lives in Skills," not MCP prompts.
"""

import json
import logging
from importlib.metadata import PackageNotFoundError, version as _pkg_version
from pathlib import Path
from typing import Callable, Optional

import mcp.types as types
from mcp.server.lowlevel import Server
from mcp.shared.exceptions import MCPError

from .cache_policy import (
    CACHE_SCOPE,
    PIPELINES_READ_TTL_MS,
    RESOURCES_LIST_TTL_MS,
    STATUS_READ_TTL_MS,
    TOOLS_TTL_MS,
    UI_READ_TTL_MS,
)
from .engine import EngineClient
from .errors import HardError, normalize_error
from .registry import TaskRegistry
from .tooling import ToolRegistry
from . import apps as apps_mod
from . import resources as resources_mod
from . import tools as tools_pkg

logger = logging.getLogger(__name__)

# `ai` is not published as an installable distribution -- it ships as source
# copied into `dist/server/ai` by the builder, never `pip install`-ed under
# any name (see packages/ai/scripts/tasks.js). `importlib.metadata.version`
# therefore always raises here today; the lookup is kept (rather than a bare
# constant) so this starts reporting a real version for free if `ai` -- or a
# renamed successor -- is ever packaged as a proper distribution.
try:
    _SERVER_VERSION = _pkg_version('ai')
except PackageNotFoundError:
    _SERVER_VERSION = '0.0.0'


def build_mcp_server(
    engine_factory: Callable[[], EngineClient],
    task_registry: Optional[TaskRegistry] = None,
    *,
    registry: Optional[ToolRegistry] = None,
    apps_dir: Optional[Path] = None,
    engine_origin: Optional[str] = None,
) -> Server:
    """Build and return a low-level MCP Server wired with tools and resources.

    Args:
        engine_factory: Zero-arg callable returning an EngineClient. In production
            this is `__init__._make_engine_factory`'s closure, which takes one of
            two paths per call depending on `identity.CALLER_AUTH`:
              - Unset: the pre-integrations lazy SINGLETON. The first call
                constructs one long-lived `WsEngineClient` and every later call
                (with CALLER_AUTH still unset) returns that same instance, so
                those handlers share one client for the life of the process.
                Concurrent `/mcp` requests on this path multiplex a single
                underlying `RocketRideClient` WS connection — the client's
                connect lock only guards the one-time `connect()` race, it does
                not serialize or correlate concurrent in-flight requests.
              - Set (a per-request caller credential is bound by `handle_mcp`):
                a FRESH client is built for that caller and returned uncached;
                `handle_mcp` closes it once the request completes.
        task_registry: Optional pre-built `TaskRegistry`. When omitted, a fresh
            registry is created here (back-compat for callers/tests that don't
            need a pre-populated one).
        registry: Optional pre-built `ToolRegistry`. Keyword-only test seam --
            production callers never pass this; when omitted (the normal case),
            a fresh registry is built here via `tools.register_all`.
        apps_dir: Optional override for the directory MCP Apps widget HTML is
            read from. Keyword-only test seam like `registry`; production
            callers never pass this, and `apps.py` falls back to the built
            `apps/dist` directory when omitted.
        engine_origin: The engine's HTTP(S) origin, precomputed by the caller
            from its configured `rocketride_uri` (see `__init__._base_url_from_uri`),
            for widget CSP stamping in `_on_list_resources`. Reading the
            configured URI directly here -- rather than calling
            `engine_factory().base_url` -- avoids building (and, on the
            per-caller path above, leaking into the request's close bucket) a
            whole EngineClient just to read a string.

    Returns:
        A configured mcp.server.lowlevel.Server ready to run.
    """
    if registry is None:
        registry = ToolRegistry()
        tools_pkg.register_all(registry)
    task_registry = task_registry if task_registry is not None else TaskRegistry()

    async def _on_list_tools(ctx, params: types.PaginatedRequestParams | None) -> types.ListToolsResult:
        return types.ListToolsResult(
            tools=registry.tools(),
            ttl_ms=TOOLS_TTL_MS,
            cache_scope=CACHE_SCOPE,
        )

    async def _on_call_tool(ctx, params: types.CallToolRequestParams) -> types.CallToolResult:
        name, arguments = params.name, dict(params.arguments or {})
        handler = registry.handler(name)
        if handler is None:
            result = {
                'ok': False,
                'error_type': 'UnknownTool',
                'message': f'Unknown tool: {name}',
                'hint': f'Call list_tools to see the {len(registry.names())} available tool(s).',
            }
        else:
            try:
                result = await handler(engine_factory(), task_registry, arguments)
            except HardError as exc:
                # v2 maps arbitrary exceptions to a generic -32603 'Internal server
                # error', which would swallow the message agents need (connection
                # lost, auth failed). MCPError carries it to the wire verbatim.
                raise MCPError(types.INTERNAL_ERROR, exc.message) from exc
            except Exception as exc:  # noqa: BLE001 - normalized below
                try:
                    result = normalize_error(exc)
                    # Normalized failures are expected agent behavior (missing
                    # args, validation rejections) — warn without a traceback
                    # so real hard failures stand out in the error log.
                    logger.warning('MCP tool %r returned a normalized error: %s', name, type(exc).__name__)
                except HardError as hard_exc:
                    logger.exception('Hard failure in MCP tool %r', name)
                    # normalize_error itself reclassifies some exceptions (by type
                    # name) into HardError -- that raise happens from *inside* this
                    # except block, so it is not seen by the `except HardError`
                    # clause above (a new exception raised in an except suite is
                    # never matched against sibling clauses of the same try). Map
                    # it here too, for the same reason: preserve the message
                    # instead of letting v2's catch-all reduce it to "Internal
                    # server error".
                    raise MCPError(types.INTERNAL_ERROR, hard_exc.message) from hard_exc
        # Round-trip one sanitized payload for both fields: default=str
        # coerces any non-JSON value (datetime/bytes) in the text path, and
        # json.loads of that same text guarantees structured_content can't
        # crash SDK serialization or diverge from the text content.
        text = json.dumps(result, default=str)
        return types.CallToolResult(
            content=[types.TextContent(type='text', text=text)],
            structured_content=json.loads(text),
            # Derived from the in-band contract: hosts can detect a failed
            # call without parsing the body, while the envelope still carries
            # the message/hint the agent self-corrects from.
            is_error=not result.get('ok', False),
        )

    async def _on_list_resources(ctx, params: types.PaginatedRequestParams | None) -> types.ListResourcesResult:
        return types.ListResourcesResult(
            resources=resources_mod.list_resources() + apps_mod.list_ui_resources(apps_dir, engine_origin),
            ttl_ms=RESOURCES_LIST_TTL_MS,
            cache_scope=CACHE_SCOPE,
        )

    async def _on_read_resource(ctx, params: types.ReadResourceRequestParams) -> types.ReadResourceResult:
        uri_str = str(params.uri)
        ui_html = apps_mod.read_ui_resource(uri_str, apps_dir)
        if ui_html is not None:
            return types.ReadResourceResult(
                contents=[types.TextResourceContents(uri=params.uri, mime_type=apps_mod.UI_MIME_TYPE, text=ui_html)],
                ttl_ms=UI_READ_TTL_MS,
                cache_scope=CACHE_SCOPE,
            )
        text = await resources_mod.read_resource(engine_factory(), uri_str)
        # Per-URI cache TTL: status is live state (no caching), pipelines reflect running
        # tasks (30s), unknown URIs default to uncached (0) for safety.
        if uri_str == resources_mod.STATUS_URI:
            ttl_ms = STATUS_READ_TTL_MS
        elif uri_str == resources_mod.PIPELINES_URI:
            ttl_ms = PIPELINES_READ_TTL_MS
        else:
            ttl_ms = 0
        return types.ReadResourceResult(
            contents=[types.TextResourceContents(uri=params.uri, mime_type='application/json', text=text)],
            ttl_ms=ttl_ms,
            cache_scope=CACHE_SCOPE,
        )

    server = Server(
        'rocketride-mcp',
        version=_SERVER_VERSION,
        on_list_tools=_on_list_tools,
        on_call_tool=_on_call_tool,
        on_list_resources=_on_list_resources,
        on_read_resource=_on_read_resource,
    )

    if apps_mod.available_apps(apps_dir):
        server.extensions[apps_mod.UI_EXTENSION_ID] = apps_mod.extension_capability()

    return server
