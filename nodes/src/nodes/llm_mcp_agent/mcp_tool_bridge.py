# =============================================================================
# MIT License
# Copyright (c) 2024 RocketRide Inc.
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
Convert MCP tool definitions (JSON Schema ``inputSchema``) into LangChain
``StructuredTool`` instances with dynamically generated Pydantic models.

Tool names are prefixed with ``{server_name}__`` to avoid collisions when
multiple MCP servers expose tools with the same name.

NOTE: ``langchain_core`` and ``pydantic`` are NOT imported at module level.
They are installed by ``depends()`` in IGlobal.beginGlobal() which runs
*after* the engine loads this module.
"""

import logging
from typing import Any, Optional

from .mcp_client import McpServerConnection

_log = logging.getLogger(__name__)

# JSON Schema type → Python type
_TYPE_MAP: dict[str, type] = {
    'string': str,
    'number': float,
    'integer': int,
    'boolean': bool,
    'array': list,
    'object': dict,
}


def _json_schema_to_pydantic(schema: dict[str, Any], model_name: str):
    """Build a Pydantic BaseModel from an MCP tool's ``inputSchema``."""
    from pydantic import BaseModel, Field, create_model

    properties = schema.get('properties', {})
    required = set(schema.get('required', []))

    field_defs: dict[str, Any] = {}
    for prop_name, prop_schema in properties.items():
        py_type = _TYPE_MAP.get(prop_schema.get('type', 'string'), str)
        description = prop_schema.get('description', '')

        if prop_name in required:
            field_defs[prop_name] = (py_type, Field(description=description))
        else:
            default = prop_schema.get('default')
            field_defs[prop_name] = (
                Optional[py_type],
                Field(default=default, description=description),
            )

    if not field_defs:
        # Tool takes no arguments — empty model
        field_defs['_placeholder'] = (
            Optional[str],
            Field(default=None, description='(no arguments)'),
        )

    return create_model(model_name, **field_defs)


def _make_tool_runner(server: McpServerConnection, original_name: str):
    """Create a closure that calls the MCP tool via the server connection."""
    def _run(**kwargs: Any) -> str:
        # Remove placeholder field if present
        kwargs.pop('_placeholder', None)
        return server.call_tool(original_name, kwargs)
    return _run


def mcp_tools_to_langchain(server: McpServerConnection) -> list:
    """Convert all tools from an MCP server into LangChain StructuredTools.

    Each tool is prefixed with ``{server.name}__`` to avoid name collisions
    across multiple MCP servers.  The ``_run`` closure strips the prefix
    before calling the server.
    """
    from langchain_core.tools import StructuredTool

    tools: list = []

    for mcp_tool in server.get_tools():
        prefixed_name = f'{server.name}__{mcp_tool.name}'
        description = mcp_tool.description or mcp_tool.name

        # Build Pydantic args schema from the MCP tool's inputSchema
        input_schema = {}
        if mcp_tool.inputSchema and isinstance(mcp_tool.inputSchema, dict):
            input_schema = mcp_tool.inputSchema

        model_name = ''.join(
            part.capitalize() for part in prefixed_name.replace('__', '_').split('_')
        ) + 'Input'

        try:
            args_schema = _json_schema_to_pydantic(input_schema, model_name)
        except Exception as exc:
            _log.warning(
                '[%s] Skipping tool %s — failed to build schema: %s',
                server.name, mcp_tool.name, exc,
            )
            continue

        tool = StructuredTool(
            name=prefixed_name,
            description=f'[{server.name}] {description}',
            func=_make_tool_runner(server, mcp_tool.name),
            args_schema=args_schema,
        )
        tools.append(tool)
        _log.debug('[%s] Registered tool %s → %s', server.name, mcp_tool.name, prefixed_name)

    return tools
