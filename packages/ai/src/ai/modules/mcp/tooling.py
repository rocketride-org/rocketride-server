# Copyright 2026 Aparavi Software AG. MIT License.
"""Tool dispatch registry for the MCP tool surface.

``ToolRegistry.register(name, description, schema)`` is a decorator that
records a handler under ``name``. ``tools/__init__.register_all(registry)``
calls each tool module's ``register(registry)`` to populate one shared
registry; ``server.py`` builds the MCP ``list_tools``/``call_tool`` handlers
from it (``tools()`` for listing, ``handler(name)`` for dispatch).
"""

from typing import Callable, Dict, List, NamedTuple, Optional

import mcp.types as types


class _ToolEntry(NamedTuple):
    description: str
    schema: dict
    handler: Callable
    ui_resource_uri: Optional[str] = None


class ToolRegistry:
    """Registry of named tools: description, JSON input schema, and handler."""

    def __init__(self) -> None:
        self._entries: Dict[str, _ToolEntry] = {}

    def register(
        self,
        name: str,
        description: str,
        schema: dict,
        *,
        ui_resource_uri: Optional[str] = None,
    ) -> Callable[[Callable], Callable]:
        """Return a decorator that registers ``fn`` as the handler for ``name``.

        ``ui_resource_uri`` links the tool to an MCP Apps widget (emitted as
        ``_meta.ui.resourceUri``; see apps.py). Hosts without the UI extension
        ignore it.
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
        ]

    def handler(self, name: str) -> Optional[Callable]:
        """Return the handler registered for ``name``, or ``None``."""
        entry = self._entries.get(name)
        return entry.handler if entry is not None else None

    def names(self) -> List[str]:
        """Return the names of all registered tools."""
        return list(self._entries.keys())
