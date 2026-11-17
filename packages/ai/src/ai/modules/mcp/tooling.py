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

Each production tool also passes ``hints=ToolHints(...)``, the three annotation
booleans plus the reason for them (``tests/test_tool_contract.py`` enforces it
over ``register_all``), and may pass ``always_load=True`` to ask Claude Code to
load it upfront under tool search.
"""

from dataclasses import dataclass
from typing import Any, Callable, Dict, List, NamedTuple, Optional

import mcp.types as types

# Claude Code reads this tool _meta key to load a tool upfront under tool search.
ALWAYS_LOAD_META_KEY = 'anthropic/alwaysLoad'


@dataclass(frozen=True)
class ToolHints:
    """The three annotation booleans every hosted tool must declare, plus the reason.

    OpenAI's plugin review requires explicit ``readOnlyHint``, ``destructiveHint``
    and ``openWorldHint`` on every tool and asks for a justification per value in
    its submission form. ``reason`` keeps that justification beside the values it
    explains; it is not sent on the wire (``ToolAnnotations`` has no such field).
    """

    read_only: bool
    destructive: bool
    open_world: bool
    reason: str

    def __post_init__(self) -> None:
        if self.read_only and self.destructive:
            raise ValueError('a read-only tool cannot also be destructive')
        if not self.reason.strip():
            raise ValueError('reason is required')

    @classmethod
    def reads(cls, reason: str) -> 'ToolHints':
        """Build the hints for a tool that retrieves or computes and changes nothing."""
        return cls(read_only=True, destructive=False, open_world=False, reason=reason)

    def to_annotations(self) -> types.ToolAnnotations:
        """Return the wire form: the three booleans, nothing else."""
        return types.ToolAnnotations(
            read_only_hint=self.read_only,
            destructive_hint=self.destructive,
            open_world_hint=self.open_world,
        )


class _ToolEntry(NamedTuple):
    description: str
    schema: dict
    handler: Callable
    ui_resource_uri: Optional[str] = None
    local_engine_only: bool = False
    hints: Optional[ToolHints] = None
    always_load: Optional[bool] = None


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
        hints: Optional[ToolHints] = None,
        always_load: Optional[bool] = None,
    ) -> Callable[[Callable], Callable]:
        """Return a decorator that registers ``fn`` as the handler for ``name``.

        ``ui_resource_uri`` links the tool to an MCP Apps widget (emitted as
        ``_meta.ui.resourceUri``; see apps.py). Hosts without the UI extension
        ignore it. ``local_engine_only`` hides the tool, and refuses calls to
        it, unless this registry serves a local engine. ``hints`` becomes the
        tool's ``annotations``; it must hold for every input form the tool
        accepts. ``always_load`` is emitted as ``_meta["anthropic/alwaysLoad"]``.
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
                hints=hints,
                always_load=always_load,
            )
            return fn

        return _decorator

    def tools(self) -> List[types.Tool]:
        """Return the registered tools as MCP ``types.Tool`` descriptors."""
        return [self._descriptor(name, entry) for name, entry in self._entries.items() if self._offered(entry)]

    def _descriptor(self, name: str, entry: _ToolEntry) -> types.Tool:
        meta: Dict[str, Any] = {}
        if entry.ui_resource_uri:
            meta['ui'] = {'resourceUri': entry.ui_resource_uri}
        if entry.always_load is not None:
            meta[ALWAYS_LOAD_META_KEY] = entry.always_load
        return types.Tool(
            name=name,
            description=entry.description,
            input_schema=entry.schema,
            annotations=entry.hints.to_annotations() if entry.hints else None,
            meta=meta or None,
        )

    def hints(self, name: str) -> Optional[ToolHints]:
        """Return the hints registered for ``name`` (offered or not), or ``None``."""
        entry = self._entries.get(name)
        return entry.hints if entry else None

    def handler(self, name: str) -> Optional[Callable]:
        """Return the handler registered for ``name``, or ``None``."""
        entry = self._entries.get(name)
        if entry is None:
            return None
        return entry.handler if self._offered(entry) else _local_engine_only_refusal(name)

    def names(self) -> List[str]:
        """Return the names of the tools this registry offers."""
        return [name for name, entry in self._entries.items() if self._offered(entry)]
