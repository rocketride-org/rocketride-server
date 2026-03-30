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
from typing import Any, Dict, List

from mcp.server.lowlevel import Server, NotificationOptions
from mcp.server.models import InitializationOptions
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

    server = Server('rocketride-mcp')

    @server.list_tools()  # type: ignore[untyped-decorator,no-untyped-call]
    async def list_tools() -> list[types.Tool]:
        entries = await _dynamic_tools()
        tools: list[types.Tool] = []
        for entry in entries:
            tools.append(
                types.Tool(
                    name=entry['name'],
                    description=entry.get('description', ''),
                    inputSchema=entry.get('inputSchema', {'type': 'object'}),
                )
            )
        return tools

    @server.call_tool()  # type: ignore[untyped-decorator]
    async def call_tool(name: str, arguments: dict[str, Any] | None) -> list[types.TextContent]:
        resp = await _handle_call(name, arguments or {})
        if resp.get('isError'):
            raise RuntimeError(resp['content'][0]['text'])
        return [types.TextContent(type='text', text=resp['content'][0]['text'])]

    # --- Resources -----------------------------------------------------------

    @server.list_resources()  # type: ignore[untyped-decorator,no-untyped-call]
    async def handle_list_resources() -> list[types.Resource]:
        return await list_resources(_client)

    @server.read_resource()  # type: ignore[untyped-decorator]
    async def handle_read_resource(uri: Any) -> str:
        return await read_resource(_client, str(uri))

    # --- Prompts -------------------------------------------------------------

    @server.list_prompts()  # type: ignore[untyped-decorator,no-untyped-call]
    async def handle_list_prompts() -> list[types.Prompt]:
        return list_prompts()

    @server.get_prompt()  # type: ignore[untyped-decorator]
    async def handle_get_prompt(name: str, arguments: dict[str, str] | None) -> types.GetPromptResult:
        return get_prompt(name, arguments)

    try:
        async with mcp.server.stdio.stdio_server() as (read_stream, write_stream):
            await server.run(
                read_stream,
                write_stream,
                InitializationOptions(
                    server_name='rocketride-mcp',
                    server_version='0.1.0',
                    capabilities=server.get_capabilities(
                        notification_options=NotificationOptions(),
                        experimental_capabilities={},
                    ),
                ),
            )
    finally:
        # Disconnect client on shutdown
        if _client:
            await _client.disconnect()


def main() -> None:
    """Entry point for the rocketride-mcp server."""
    try:
        asyncio.run(run_server())
    except KeyboardInterrupt:
        pass


if __name__ == '__main__':
    main()
