"""
mcp_client tool-provider driver.

Implements `tool.query`, `tool.validate`, and `tool.invoke` by delegating to a
pre-initialized MCP client / cache provided by `IGlobal`.
"""

from __future__ import annotations

from typing import Any, Callable, Dict, List

from ai.common.tools import ToolsBase


class McpDriver(ToolsBase):
    def __init__(
        self,
        *,
        server_name: str,
        list_namespaced_tools: Callable[[], List[Dict[str, Any]]],
        get_tool: Callable[[str, str], Any],
        call_tool: Callable[[str, str, Dict[str, Any]], Dict[str, Any]],
    ):
        """
        Initialize the MCP Driver.
        """
        self._server_name = (server_name or '').strip() or 'mcp'
        self._list_namespaced_tools = list_namespaced_tools
        self._get_tool = get_tool
        self._call_tool = call_tool

    def _tool_query(self) -> List[Dict[str, Any]]:
        return self._list_namespaced_tools()

    def _tool_validate(self, *, server_name: str, tool_name: str, input_obj: Any) -> None:  # noqa: ANN401
        tool = self._get_tool(server_name, tool_name)
        if tool is None:
            raise ValueError(f'Unknown tool {server_name}.{tool_name}')

        schema = getattr(tool, 'inputSchema', None) or {}
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
            arguments: Dict[str, Any] = {}
        elif isinstance(input_obj, dict):
            arguments = input_obj
        else:
            raise ValueError('Tool input must be a JSON object (dict)')

        return self._call_tool(server_name, tool_name, arguments)

