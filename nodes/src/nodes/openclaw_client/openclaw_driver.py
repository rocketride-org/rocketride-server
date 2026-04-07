"""
OpenClaw tool-provider driver.

Implements `tool.query`, `tool.validate`, and `tool.invoke` by delegating to a
pre-initialized OpenClaw client provided by `IGlobal`.
"""

from __future__ import annotations

from typing import Any, Callable, Dict, List

from ai.common.tools import ToolsBase


class OpenClawDriver(ToolsBase):
    def __init__(
        self,
        *,
        server_name: str,
        tools: List[Dict[str, Any]],
        invoke_fn: Callable[[str, Dict[str, Any], str], Any],
        session_key: str = 'main',
    ):
        self._server_name = (server_name or '').strip() or 'openclaw'
        self._session_key = session_key

        # Build lookup dicts: namespaced name -> tool descriptor
        self._tools_by_namespaced: Dict[str, Dict[str, Any]] = {}
        self._tools_by_bare: Dict[str, Dict[str, Any]] = {}
        for t in tools:
            bare_name = t.get('name', '')
            if not bare_name:
                continue
            namespaced = f'{self._server_name}.{bare_name}'
            descriptor: Dict[str, Any] = {
                'name': namespaced,
                'description': t.get('description', ''),
                'inputSchema': t.get('inputSchema') or {'type': 'object', 'additionalProperties': True},
            }
            self._tools_by_namespaced[namespaced] = descriptor
            self._tools_by_bare[bare_name] = t

        self._invoke_fn = invoke_fn

    # ------------------------------------------------------------------
    # ToolsBase hooks
    # ------------------------------------------------------------------

    def _tool_query(self) -> List[ToolsBase.ToolDescriptor]:
        return list(self._tools_by_namespaced.values())

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
        namespaced = f'{server_name}.{bare_tool}'
        descriptor = self._tools_by_namespaced.get(namespaced)
        if descriptor is None:
            raise ValueError(f'Unknown tool {tool_name}')

        schema = descriptor.get('inputSchema', {})
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
        _server_name, bare_tool = self._split_tool_name(tool_name)
        if input_obj is None:
            arguments: Dict[str, Any] = {}
        elif isinstance(input_obj, dict):
            arguments = {k: v for k, v in input_obj.items() if k not in self._FRAMEWORK_KEYS}
        else:
            raise ValueError('Tool input must be a JSON object (dict)')

        return self._invoke_fn(bare_tool, arguments, self._session_key)
