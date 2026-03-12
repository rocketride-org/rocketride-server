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

from rocketlib.filters import APERR, Ec


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

    def _owns_tool(self, tool_name: str) -> bool:
        """
        Determine whether this provider exposes a tool with the given name.
        
        Returns:
            True if the provider exposes a tool named `tool_name`, False otherwise.
        """
        return any(
            (td.get('name') if isinstance(td, dict) else getattr(td, 'name', None)) == tool_name
            for td in self._tool_query()
        )

    def handle_invoke(self, param: Any) -> Any:  # noqa: ANN401
        """
        Dispatch a tool control-plane operation described by `param`.
        
        Parameters:
            param (Any): Control-plane object (commonly a dict) that must include an 'op' string and may include:
                - 'tools' (list): aggregated list for 'tool.query'
                - 'tool_name' (str) and 'input' (Any): used by 'tool.validate' and 'tool.invoke'
                The function may read from and write to fields on this object.
        
        Behavior:
            - 'tool.query': appends this provider's tool descriptors to `param['tools']` if present and raises APERR(Ec.PreventDefault, ...)
              to signal continuation of the discovery chain.
            - 'tool.validate': validates that `tool_name` is owned by this provider, calls the provider's validation hook,
              and returns {'valid': True, 'tool_name': tool_name} on success. If the tool is not owned, raises APERR(Ec.PreventDefault, ...).
            - 'tool.invoke': validates that `tool_name` is owned by this provider, calls the provider's invoke hook,
              sets `param['output']` to the hook result, and returns `param`. If the tool is not owned, raises APERR(Ec.PreventDefault, ...).
        
        Returns:
            Any: For 'tool.validate' returns a dict with validation result; for 'tool.invoke' returns the (possibly mutated) `param` object;
            'tool.query' does not return (it raises to continue the chain).
        
        Raises:
            ValueError: if 'op' is missing, empty, or not a defined operation, or if 'tool_name' is missing/invalid for validate/invoke.
            APERR(Ec.PreventDefault, ...): used to delegate handling to the next node when discovery should continue or when the provider does not own a requested tool.
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
                # Signal PreventDefault so cb_control continues to the
                # next tool node in the chain — each node appends its
                # tools to the shared param.tools list.
                raise APERR(Ec.PreventDefault, 'tool.query: continue chain')

            case 'tool.validate':
                tool_name = _get_field(param, 'tool_name')
                input_obj = _get_field(param, 'input')
                if not isinstance(tool_name, str) or not tool_name.strip():
                    raise ValueError('tools: tool_name must be a non-empty string')
                if not self._owns_tool(tool_name.strip()):
                    raise APERR(Ec.PreventDefault, f'tool.validate: {tool_name} not owned')
                self._tool_validate(tool_name=tool_name.strip(), input_obj=input_obj)
                return {'valid': True, 'tool_name': tool_name}

            case 'tool.invoke':
                tool_name = _get_field(param, 'tool_name')
                input_obj = _get_field(param, 'input')
                if not isinstance(tool_name, str) or not tool_name.strip():
                    raise ValueError('tools: tool_name must be a non-empty string')
                if not self._owns_tool(tool_name.strip()):
                    raise APERR(Ec.PreventDefault, f'tool.invoke: {tool_name} not owned')
                output = self._tool_invoke(tool_name=tool_name.strip(), input_obj=input_obj)
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
