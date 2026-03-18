# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
Memory tool-provider driver.

Implements ``tool.query``, ``tool.validate``, and ``tool.invoke`` by exposing
five keyed-memory tools (put, get, peek, list, clear) backed by a run-scoped
``MemoryStore``.
"""

from __future__ import annotations

from typing import Any, Dict, List

from ai.common.tools import ToolsBase

from .memory import MemoryStore, TOOL_DESCRIPTORS

_MEMORY_PREFIX = 'memory.'


class MemoryDriver(ToolsBase):
    """Tool-provider driver that exposes keyed memory operations.

    Implements the :class:`ToolsBase` interface so the engine can discover,
    validate, and invoke memory tools (``memory.put``, ``memory.get``, etc.)
    via the standard ``tool.*`` control-plane protocol.
    """

    def __init__(self) -> None:
        self._store = MemoryStore()

    # ------------------------------------------------------------------
    # ToolsBase hooks
    # ------------------------------------------------------------------

    def _tool_query(self) -> List[Dict[str, Any]]:
        """Return tool descriptors for all memory operations."""
        return list(TOOL_DESCRIPTORS)

    def _tool_validate(self, *, tool_name: str, input_obj: Any) -> None:
        """Validate that the tool name is a known ``memory.*`` operation."""
        if not isinstance(tool_name, str) or not tool_name.startswith(_MEMORY_PREFIX):
            raise ValueError(f'Unknown tool {tool_name!r}')
        if not isinstance(input_obj, dict):
            raise ValueError('Tool input must be a JSON object')

    def _tool_invoke(self, *, tool_name: str, input_obj: Any) -> Any:
        """Validate and dispatch a memory tool call to the store."""
        if not isinstance(input_obj, dict):
            input_obj = {}
        self._tool_validate(tool_name=tool_name, input_obj=input_obj)
        return self._store.dispatch(tool_name, input_obj)
