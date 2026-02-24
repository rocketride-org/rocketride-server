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
MCP tool client node instance.

This node will implement the tool invocation surface used by agents:
    instance.invoke('tool', IInvokeTool.*)

"""

from __future__ import annotations

from typing import Any

from nodes.tools_base import IInstanceGenericTools

from .IGlobal import IGlobal


class IInstance(IInstanceGenericTools):
    IGlobal: IGlobal

    # Step 2: inherit base `invoke()` routing and provide provider hooks later.
    # Step 3 will implement these hooks to back tool calls with MCP over STDIO.

    def _tool_query(self):  # noqa: ANN201
        return self.IGlobal.list_namespaced_tools()

    def _tool_validate(self, *, server_name: str, tool_name: str, input_obj: Any) -> None:  # noqa: ANN401
        tool = self.IGlobal.get_tool(server_name=server_name, tool_name=tool_name)
        if tool is None:
            raise ValueError(f'Unknown tool {server_name}.{tool_name}')

        schema = tool.inputSchema or {}
        if not isinstance(schema, dict):
            return
        required = schema.get('required', [])
        if not required:
            return
        if not isinstance(input_obj, dict):
            raise ValueError(f'Tool input must be an object; required fields={required}')
        missing = [k for k in required if k not in input_obj]
        if missing:
            raise ValueError(f'Tool input missing required fields: {missing}')

    def _tool_invoke(self, *, server_name: str, tool_name: str, input_obj: Any) -> Any:  # noqa: ANN401
        if input_obj is None:
            arguments = {}
        elif isinstance(input_obj, dict):
            arguments = input_obj
        else:
            raise ValueError('Tool input must be a JSON object (dict)')

        result = self.IGlobal.call_tool(server_name=server_name, tool_name=tool_name, arguments=arguments)
        return result

