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
        """
        Initialize the MemoryDriver and its run-scoped memory store.
        
        Creates a new MemoryStore instance and assigns it to self._store for storing keyed memory for the driver instance.
        """
        self._store = MemoryStore()

    # ------------------------------------------------------------------
    # ToolsBase hooks
    # ------------------------------------------------------------------

    def _tool_query(self) -> List[Dict[str, Any]]:
        """
        Provide tool descriptors for all available memory operations.
        
        Returns:
            List[Dict[str, Any]]: A list of descriptor objects where each object contains
            'name' (tool name), 'description' (tool description), and 'inputSchema' (input schema or
            empty dict).
        """
        return [
            {
                'name': td['name'],
                'description': td['description'],
                'inputSchema': td.get('input_schema', {}),
            }
            for td in TOOL_DESCRIPTORS
        ]

    def _tool_validate(self, *, tool_name: str, input_obj: Any) -> None:
        """
        Validate that the specified tool name is a supported memory tool and that the input is a JSON object.
        
        Parameters:
            tool_name (str): Fully-qualified tool name; must start with 'memory.'.
            input_obj (Any): The tool input payload; must be a dict representing a JSON object.
        
        Raises:
            ValueError: If `tool_name` is not a string starting with 'memory.' or if `input_obj` is not a dict.
        """
        if not isinstance(tool_name, str) or not tool_name.startswith(_MEMORY_PREFIX):
            raise ValueError(f'Unknown tool {tool_name!r}')
        if not isinstance(input_obj, dict):
            raise ValueError('Tool input must be a JSON object')

    def _tool_invoke(self, *, tool_name: str, input_obj: Any) -> Any:
        """
        Dispatches a validated memory tool call to the underlying MemoryStore.
        
        If `input_obj` is not a mapping, it is replaced with an empty dict before validation. Validates `tool_name` and `input_obj` and forwards the call to the store's dispatcher.
        
        Parameters:
        	tool_name (str): The fully qualified tool name (must start with 'memory.').
        	input_obj (Any): The tool input; non-dict values will be treated as an empty dict.
        
        Returns:
        	Any: The result returned by the MemoryStore dispatch for the given tool.
        
        Raises:
        	ValueError: If `tool_name` is not a known memory tool or if `input_obj` is not a JSON object after normalization.
        """
        if not isinstance(input_obj, dict):
            input_obj = {}
        self._tool_validate(tool_name=tool_name, input_obj=input_obj)
        return self._store.dispatch(tool_name, input_obj)
