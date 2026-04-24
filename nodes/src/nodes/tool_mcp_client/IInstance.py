# =============================================================================
# RocketRide Engine
# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
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

Uses the dynamic tools escape hatch — tools are discovered at runtime from
the external MCP server, not declared with @tool_function decorators.
"""

from __future__ import annotations

from typing import Any, Dict

from rocketlib import IInstanceBase

from .IGlobal import IGlobal

_FRAMEWORK_KEYS = frozenset({'security_context'})


class IInstance(IInstanceBase):
    IGlobal: IGlobal

    def _tool_query_dynamic(self) -> list:
        """Return tools discovered from the MCP server."""
        return self.IGlobal.list_namespaced_tools()

    def _tool_invoke_dynamic(self, *, tool_name: str, input_obj: Any) -> Any:
        """Dispatch a tool call to the MCP server."""
        server_name, bare_tool = _split_tool_name(tool_name)
        if input_obj is None:
            arguments: Dict[str, Any] = {}
        elif isinstance(input_obj, dict):
            arguments = {k: v for k, v in input_obj.items() if k not in _FRAMEWORK_KEYS}
            # Some agent framework paths wrap tool args as {"input": {...}}.
            # MCP servers with strict schemas (additionalProperties: false)
            # reject the wrapper, so unwrap it to match the tool's schema.
            if 'input' in arguments and isinstance(arguments['input'], dict):
                inner = arguments['input']
                extras = {k: v for k, v in arguments.items() if k != 'input'}
                arguments = {**inner, **extras}
        else:
            raise ValueError('Tool input must be a JSON object (dict)')
        return self.IGlobal.call_tool(server_name=server_name, tool_name=bare_tool, arguments=arguments)


def _split_tool_name(tool_name: str) -> tuple[str, str]:
    """Split ``'server.tool'`` into ``('server', 'tool')``."""
    s = (tool_name or '').strip()
    if '.' not in s:
        raise ValueError(f'Tool name must be namespaced as `server.tool`; got {tool_name!r}')
    server, bare = s.split('.', 1)
    server = server.strip()
    bare = bare.strip()
    if not server or not bare:
        raise ValueError(f'Tool name must be namespaced as `server.tool`; got {tool_name!r}')
    return server, bare
