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

from __future__ import annotations

import asyncio
import json
import sys
from typing import Any, Dict, List

from mcp.server.lowlevel import Server
import mcp.server.stdio
import mcp.types as types

from rocketride import RocketRideClient

from .config import load_settings
from .prompts import list_prompts, get_prompt
from .resources import list_resources, read_resource
from .tools import get_tools, format_tools, execute_tool

# Global client instance
_client: RocketRideClient | None = None


def _format_result_text(name: str, filepath: str, result: Dict[str, Any]) -> str:
    text_lines: List[str] = []
    text_lines.append(f'Sent data to pipeline: {name} (filepath: {filepath})')
    if isinstance(result, dict):
        texts = result.get('text')
        appended: str | None = None
        if isinstance(texts, list):
            appended = '\n\n'.join([t for t in texts if isinstance(t, str)])
        elif isinstance(texts, str):
            appended = texts
        else:
            try:
                appended = json.dumps(result, ensure_ascii=False)
            except (TypeError, ValueError):
                appended = None
        if appended:
            text_lines.append(appended)
    return '\n\n'.join(text_lines)


async def _dynamic_tools() -> List[Dict[str, Any]]:
    if _client is None:
        raise RuntimeError('Client is not connected')
    tasks = await get_tools(_client)
    return format_tools(tasks)


async def _handle_call(tool_name: str, arguments: Dict[str, Any]) -> Dict[str, Any]:
    if _client is None:
        raise RuntimeError('Client is not connected')
    filepath = (arguments or {}).get('filepath')
    exec_resp = await execute_tool(client=_client, filepath=filepath, name=tool_name)
    status = exec_resp.get('status', 200)
    is_error = status >= 400
    result_obj = exec_resp.get('result') if not is_error else None
    if not is_error:
        text = _format_result_text(tool_name, str(filepath), result_obj or {})
    else:
        text = f'Failed to send data to pipeline: {tool_name} (filepath: {filepath})'
    return {
        'isError': is_error,
        'content': [{'type': 'text', 'text': text}],
        'structuredContent': {'result': result_obj},
    }


async def run_server() -> None:
    """Start and run the MCP stdio server."""
    global _client
    settings = load_settings()

    # Connect client once at startup
    _client = RocketRideClient(uri=settings.uri, auth=settings.apikey)
    try:
        await _client.connect()
    except Exception as e:
        raise RuntimeError(f'Failed to connect to RocketRide: {e}') from e

    async def on_list_tools(ctx: Any, params: types.PaginatedRequestParams | None) -> types.ListToolsResult:
        """Return MCP tool descriptors for all running RocketRide pipelines."""
        entries = await _dynamic_tools()
        tools: list[types.Tool] = []
        for entry in entries:
            tools.append(
                types.Tool(
                    name=entry['name'],
                    description=entry.get('description', ''),
                    input_schema=entry.get('inputSchema', {'type': 'object'}),
                )
            )
        return types.ListToolsResult(tools=tools)

    async def on_call_tool(ctx: Any, params: types.CallToolRequestParams) -> types.CallToolResult:
        """Execute a pipeline tool by name with the given arguments."""
        resp = await _handle_call(params.name, dict(params.arguments or {}))
        return types.CallToolResult(
            content=[types.TextContent(type='text', text=resp['content'][0]['text'])],
            structured_content=resp.get('structuredContent'),
            is_error=bool(resp.get('isError')),
        )

    # --- Resources -----------------------------------------------------------

    async def on_list_resources(ctx: Any, params: types.PaginatedRequestParams | None) -> types.ListResourcesResult:
        """Return the catalogue of available RocketRide MCP resources."""
        return types.ListResourcesResult(resources=await list_resources(_client))

    async def on_read_resource(ctx: Any, params: types.ReadResourceRequestParams) -> types.ReadResourceResult:
        """Fetch the JSON payload for the requested resource URI."""
        text = await read_resource(_client, str(params.uri))
        return types.ReadResourceResult(
            contents=[types.TextResourceContents(uri=params.uri, mime_type='application/json', text=text)]
        )

    # --- Prompts -------------------------------------------------------------

    async def on_list_prompts(ctx: Any, params: types.PaginatedRequestParams | None) -> types.ListPromptsResult:
        """Return all available MCP prompt templates."""
        return types.ListPromptsResult(prompts=list_prompts())

    async def on_get_prompt(ctx: Any, params: types.GetPromptRequestParams) -> types.GetPromptResult:
        """Render a prompt template with the supplied arguments."""
        return get_prompt(params.name, dict(params.arguments or {}))

    server = Server(
        'rocketride-mcp',
        version='0.1.0',
        on_list_tools=on_list_tools,
        on_call_tool=on_call_tool,
        on_list_resources=on_list_resources,
        on_read_resource=on_read_resource,
        on_list_prompts=on_list_prompts,
        on_get_prompt=on_get_prompt,
    )

    try:
        async with mcp.server.stdio.stdio_server() as (read_stream, write_stream):
            await server.run(read_stream, write_stream, server.create_initialization_options())
    finally:
        # Disconnect client on shutdown
        if _client:
            await _client.disconnect()


def main() -> None:
    """Entry point for the rocketride-mcp server."""
    # stdout carries the MCP protocol; the deprecation notice goes to stderr.
    print(
        'rocketride-mcp is deprecated: the RocketRide engine ships a built-in HTTP MCP server '
        'at https://api.rocketride.ai/mcp (self-hosted: http://<host>:5565/mcp). '
        'See https://docs.rocketride.org/connect/mcp/http',
        file=sys.stderr,
    )
    try:
        asyncio.run(run_server())
    except KeyboardInterrupt:
        pass


if __name__ == '__main__':
    main()
