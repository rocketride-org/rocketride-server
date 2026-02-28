"""
Tool provider base abstraction.

This is the shared base class for tool-provider nodes that expose tools over the
engine control-plane invoke seam:

  instance.invoke("tool", IInvokeTool.*)

Providers implement three hooks:
- `_tool_query`: return tool descriptors for discovery
- `_tool_validate`: validate tool input
- `_tool_invoke`: execute tool call and return output

Shared routing logic for `tool.query`, `tool.validate`, and `tool.invoke` lives
in `ToolsBase.invoke()`.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any, Dict, List, TypedDict


class ToolsBase(ABC):
    """
    Base class for tool-provider nodes.

    Implements the control-plane invoke seam for tools:

    - `tool.query`: returns/augments tool discovery list
    - `tool.validate`: validates tool input (provider-specific)
    - `tool.invoke`: executes tool call (provider-specific)

    Tool names are expected to be namespaced: `<serverName>.<toolName>`.
    """

    class ToolDescriptor(TypedDict, total=False):
        """
        Canonical tool descriptor returned by `tool.query`.

        A stable descriptor contract
        lets framework drivers bind tools with correct names, descriptions, and JSON
        schemas so the LLM emits the right argument keys (e.g. `query` instead of `input`).
        """

        name: str
        description: str
        input_schema: Dict[str, Any]
        output_schema: Dict[str, Any]

    def handle_invoke(self, param: Any) -> Any:  # noqa: ANN401
        """
        Handle a tool control-plane operation.

        This is the driver-facing entrypoint. Node `IInstance.invoke(...)` should
        typically delegate to this method.
        """
        op = _get_field(param, 'op')
        if not isinstance(op, str) or not op:
            raise ValueError('tools: invoke param must include a non-empty string field `op`')

        match op:
            case 'tool.query':
                tools = self._tool_query()
                existing = _get_field(param, 'tools')
                if isinstance(existing, list):
                    existing.extend(tools)
                    _set_field(param, 'tools', existing)
                    return param
                return tools

            case 'tool.validate':
                tool_name = _get_field(param, 'tool_name')
                input_obj = _get_field(param, 'input')
                if not isinstance(tool_name, str) or not tool_name.strip():
                    raise ValueError('tools: tool_name must be a non-empty string')
                self._tool_validate(tool_name=tool_name.strip(), input_obj=input_obj)
                return {'valid': True, 'tool_name': tool_name}

            case 'tool.invoke':
                tool_name = _get_field(param, 'tool_name')
                input_obj = _get_field(param, 'input')
                if not isinstance(tool_name, str) or not tool_name.strip():
                    raise ValueError('tools: tool_name must be a non-empty string')
                output = self._tool_invoke(tool_name=tool_name.strip(), input_obj=input_obj)
                # Convention in `IInvokeTool.Invoke`: set `output` on the param.
                _set_field(param, 'output', output)
                return param

            case _:
                raise ValueError(f'tools: invoke operation {op} is not defined')

    def invoke(self, param: Any) -> Any:  # noqa: ANN401
        """Alias for `handle_invoke()`."""
        return self.handle_invoke(param)

    # ------------------------------------------------------------------
    # Provider hooks (override in concrete tool provider nodes)
    # ------------------------------------------------------------------
    @abstractmethod
    def _tool_query(self) -> List['ToolsBase.ToolDescriptor']:
        """Return a list of tool descriptors for discovery."""
        raise NotImplementedError

    @abstractmethod
    def _tool_validate(self, *, tool_name: str, input_obj: Any) -> None:  # noqa: ANN401
        """Validate tool input; raise on invalid input."""
        raise NotImplementedError

    @abstractmethod
    def _tool_invoke(self, *, tool_name: str, input_obj: Any) -> Any:  # noqa: ANN401
        """Execute tool call and return output."""
        raise NotImplementedError


def _get_field(obj: Any, name: str) -> Any:  # noqa: ANN401
    if obj is None:
        return None
    if isinstance(obj, dict):
        return obj.get(name)
    return getattr(obj, name, None)


def _set_field(obj: Any, name: str, value: Any) -> None:  # noqa: ANN401
    if obj is None:
        return
    if isinstance(obj, dict):
        obj[name] = value
        return
    try:
        setattr(obj, name, value)
    except Exception:
        # Best-effort: if the object is immutable, ignore.
        pass
