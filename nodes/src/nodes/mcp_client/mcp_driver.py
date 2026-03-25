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

    def _get_known_tool_names(self) -> set:
        return {t['name'] for t in self._list_namespaced_tools() if isinstance(t, dict) and 'name' in t}

    def _tool_query(self) -> List[ToolsBase.ToolDescriptor]:
        return self._list_namespaced_tools()

    @staticmethod
    def _split_tool_name(tool_name: str) -> tuple[str, str]:
        s = (tool_name or '').strip()
        if '.' not in s:
            raise ValueError(f'Tool name must be namespaced as `server.tool`; got {tool_name!r}')
        server, bare = s.split('.', 1)
        server = server.strip()
        bare = bare.strip()
        if not server or not bare:
            raise ValueError(f'Tool name must be namespaced as `server.tool`; got {tool_name!r}')
        return server, bare

    def _tool_validate(self, *, tool_name: str, input_obj: Any) -> None:  # noqa: ANN401
        server_name, bare_tool = self._split_tool_name(tool_name)
        tool = self._get_tool(server_name, bare_tool)
        if tool is None:
            raise ValueError(f'Unknown tool {tool_name}')

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

    _FRAMEWORK_KEYS = frozenset({'security_context'})

    def _tool_invoke(self, *, tool_name: str, input_obj: Any) -> Any:  # noqa: ANN401
        server_name, bare_tool = self._split_tool_name(tool_name)
        if input_obj is None:
            arguments: Dict[str, Any] = {}
        elif isinstance(input_obj, dict):
            arguments = {k: v for k, v in input_obj.items() if k not in self._FRAMEWORK_KEYS}
        else:
            raise ValueError('Tool input must be a JSON object (dict)')

        return self._call_tool(server_name, bare_tool, arguments)

