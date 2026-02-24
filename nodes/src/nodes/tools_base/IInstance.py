# =============================================================================
# Aparavi Engine
# =============================================================================
# MIT License
# Copyright (c) 2024 Aparavi Inc.
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in
# all copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.
# =============================================================================

"""
Tool base class (provider-agnostic invoke boundary).

This package is intentionally framework/provider agnostic. It will be used by
tool provider nodes (for example `mcp_client`) to standardize behavior
behind the control-plane invoke seam:

    instance.invoke('tool', IInvokeTool.*)

Step 1 scaffolding: this class is a placeholder. Step 2 will implement routing
for `tool.query`, `tool.validate`, and `tool.invoke`.
"""

from __future__ import annotations

from typing import Any, Dict, List, Tuple

from rocketlib import IInstanceBase


class IInstanceGenericTools(IInstanceBase):
    """
    Base class for tool-provider nodes.

    Implements the control-plane invoke seam for tools:

    - `tool.query`: returns/augments tool discovery list
    - `tool.validate`: validates tool input (provider-specific)
    - `tool.invoke`: executes tool call (provider-specific)

    Tool names are expected to be namespaced: `<serverName>.<toolName>`.
    """

    def invoke(self, param: Any) -> Any:  # noqa: ANN401
        op = _get_field(param, 'op')
        if not isinstance(op, str) or not op:
            raise ValueError('tools_base: invoke param must include a non-empty string field `op`')

        match op:
            case 'tool.query':
                tools = self._tool_query()
                # Convention in `IInvokeTool.Query`: populate `tools` array.
                existing = _get_field(param, 'tools')
                if isinstance(existing, list):
                    existing.extend(tools)
                    _set_field(param, 'tools', existing)
                    return param
                return tools

            case 'tool.validate':
                tool_name = _get_field(param, 'tool_name')
                input_obj = _get_field(param, 'input')
                server_name, bare_tool = _split_namespaced_tool_name(tool_name)
                self._tool_validate(server_name=server_name, tool_name=bare_tool, input_obj=input_obj)
                return {'valid': True, 'tool_name': tool_name}

            case 'tool.invoke':
                tool_name = _get_field(param, 'tool_name')
                input_obj = _get_field(param, 'input')
                server_name, bare_tool = _split_namespaced_tool_name(tool_name)
                output = self._tool_invoke(server_name=server_name, tool_name=bare_tool, input_obj=input_obj)
                # Convention in `IInvokeTool.Invoke`: set `output` on the param.
                _set_field(param, 'output', output)
                return param

            case _:
                raise ValueError(f'tools_base: invoke operation {op} is not defined')

    # ------------------------------------------------------------------
    # Provider hooks (override in concrete tool provider nodes)
    # ------------------------------------------------------------------
    def _tool_query(self) -> List[Dict[str, Any]]:
        """Return a list of tool descriptors for discovery."""
        raise NotImplementedError('tools_base: _tool_query() must be implemented by tool provider')

    def _tool_validate(self, *, server_name: str, tool_name: str, input_obj: Any) -> None:  # noqa: ANN401
        """Validate tool input; raise on invalid input."""
        raise NotImplementedError('tools_base: _tool_validate() must be implemented by tool provider')

    def _tool_invoke(self, *, server_name: str, tool_name: str, input_obj: Any) -> Any:  # noqa: ANN401
        """Execute tool call and return output."""
        raise NotImplementedError('tools_base: _tool_invoke() must be implemented by tool provider')

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


def _split_namespaced_tool_name(tool_name: Any) -> Tuple[str, str]:  # noqa: ANN401
    if not isinstance(tool_name, str) or not tool_name.strip():
        raise ValueError('tools_base: tool_name must be a non-empty string')
    s = tool_name.strip()
    if '.' not in s:
        raise ValueError(
            'tools_base: tool_name must be namespaced as `<serverName>.<toolName>`; '
            f'got {tool_name!r}'
        )
    server_name, bare_tool = s.split('.', 1)
    server_name = server_name.strip()
    bare_tool = bare_tool.strip()
    if not server_name or not bare_tool:
        raise ValueError(
            'tools_base: tool_name must be namespaced as `<serverName>.<toolName>`; '
            f'got {tool_name!r}'
        )
    return server_name, bare_tool
