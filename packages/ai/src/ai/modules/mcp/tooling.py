# Copyright 2026 Aparavi Software AG. MIT License.
"""Tool dispatch registry for the MCP tool surface.

``ToolRegistry.register(name, description, schema)`` is a decorator that
records a handler under ``name``. ``tools/__init__.register_all(registry)``
calls each tool module's ``register(registry)`` to populate one shared
registry; ``server.py`` builds the MCP ``list_tools``/``call_tool`` handlers
from it (``tools()`` for listing, ``handler(name)`` for dispatch).

A registry knows whether it serves a *local* engine (one bound to loopback,
so the engine host is the caller's own machine). Tools registered with
``local_engine_only=True`` act on the engine host itself; a registry for a
deployed engine neither lists them nor dispatches to them -- ``handler(name)``
returns a refusal that never touches the engine or its arguments.
"""

from typing import Any, Callable, Dict, List, NamedTuple, Optional

import mcp.types as types


class _ToolEntry(NamedTuple):
    description: str
    schema: dict
    handler: Callable
    ui_resource_uri: Optional[str] = None
    local_engine_only: bool = False


def _local_engine_only_refusal(name: str) -> Callable:
    """Build the handler dispatched for a local-engine-only tool on a deployed engine.

    It ignores its client and arguments entirely: nothing about the request
    (e.g. whether a path exists on the engine host) can shape the answer.
    """

    async def _refuse(client: Any, tasks: Any, args: Dict[str, Any]) -> dict:
        return {
            'ok': False,
            'error_type': 'Unavailable',
            'message': f'{name} is only available on a local engine (one bound to loopback).',
            'hint': 'Call list_tools to see the tools this engine offers.',
        }

    return _refuse


class ToolRegistry:
    """Registry of named tools: description, JSON input schema, and handler."""

    def __init__(self, *, local_engine: bool = False) -> None:
        """Create an empty registry.

        Args:
            local_engine: True when the engine is bound to loopback. Defaults
                to False so a caller that does not decide gets the deployed
                (fail-closed) surface, without ``local_engine_only`` tools.
        """
        self._entries: Dict[str, _ToolEntry] = {}
        self._local_engine = local_engine

    def _offered(self, entry: _ToolEntry) -> bool:
        return self._local_engine or not entry.local_engine_only

    def register(
        self,
        name: str,
        description: str,
        schema: dict,
        *,
        ui_resource_uri: Optional[str] = None,
        local_engine_only: bool = False,
    ) -> Callable[[Callable], Callable]:
        """Return a decorator that registers ``fn`` as the handler for ``name``.

        ``ui_resource_uri`` links the tool to an MCP Apps widget (emitted as
        ``_meta.ui.resourceUri``; see apps.py). Hosts without the UI extension
        ignore it. ``local_engine_only`` hides the tool, and refuses calls to
        it, unless this registry serves a local engine.
        """

        def _decorator(fn: Callable) -> Callable:
            if name in self._entries:
                # A silent overwrite makes the first tool vanish from list_tools
                # with nothing pointing at the cause; fail at import time.
                raise ValueError(f'Duplicate tool registration: {name}')
            self._entries[name] = _ToolEntry(
                description=description,
                schema=schema,
                handler=fn,
                ui_resource_uri=ui_resource_uri,
                local_engine_only=local_engine_only,
            )
            return fn

        return _decorator

    def tools(self) -> List[types.Tool]:
        """Return the registered tools as MCP ``types.Tool`` descriptors."""
        return [
            types.Tool(
                name=name,
                description=entry.description,
                input_schema=entry.schema,
                meta=({'ui': {'resourceUri': entry.ui_resource_uri}} if entry.ui_resource_uri else None),
            )
            for name, entry in self._entries.items()
            if self._offered(entry)
        ]

    def handler(self, name: str) -> Optional[Callable]:
        """Return the handler registered for ``name``, or ``None``."""
        entry = self._entries.get(name)
        if entry is None:
            return None
        return entry.handler if self._offered(entry) else _local_engine_only_refusal(name)

    def names(self) -> List[str]:
        """Return the names of the tools this registry offers."""
        return [name for name, entry in self._entries.items() if self._offered(entry)]
