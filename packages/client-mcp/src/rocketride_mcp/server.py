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
from .services import fetch_services
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


# ---------------------------------------------------------------------------
# Resource URIs
# ---------------------------------------------------------------------------
_SERVICES_URI = 'rocketride://services'


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

    # ------------------------------------------------------------------
    # Tools
    # ------------------------------------------------------------------
    _SERVICE_CATALOG_TOOL = 'get_service_catalog'

    @server.list_tools()  # type: ignore[untyped-decorator,no-untyped-call]
    async def list_tools() -> list[types.Tool]:
        tools: list[types.Tool] = [
            types.Tool(
                name=_SERVICE_CATALOG_TOOL,
                description=(
                    'Get the live RocketRide node service catalog from the running engine. '
                    'Returns every available pipeline node, its profiles, config fields, '
                    'lane types, and capabilities. Call this tool FIRST before building '
                    'or modifying any RocketRide pipeline.'
                ),
                inputSchema={'type': 'object', 'properties': {}, 'required': []},
            ),
        ]
        entries = await _dynamic_tools()
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
        if name == _SERVICE_CATALOG_TOOL:
            if _client is None:
                raise RuntimeError('Client is not connected')
            content = await fetch_services(_client)
            if not content:
                raise RuntimeError('Service catalog is not available — engine may not be running')
            return [types.TextContent(type='text', text=content)]

        resp = await _handle_call(name, arguments or {})
        if resp.get('isError'):
            raise RuntimeError(resp['content'][0]['text'])
        return [types.TextContent(type='text', text=resp['content'][0]['text'])]

    # ------------------------------------------------------------------
    # Resources: live service catalog from the running engine
    # ------------------------------------------------------------------
    @server.list_resources()  # type: ignore[untyped-decorator,no-untyped-call]
    async def list_resources() -> list[types.Resource]:
        return [
            types.Resource(
                uri=_SERVICES_URI,
                name='RocketRide Live Service Catalog',
                description=(
                    'Live node definitions from the running RocketRide engine. '
                    'Includes every available node, its profiles, config schemas, '
                    'and lane types. Always reflects what is currently deployed.'
                ),
                mimeType='text/markdown',
            ),
        ]

    @server.read_resource()  # type: ignore[untyped-decorator]
    async def read_resource(uri: str) -> str:
        if uri == _SERVICES_URI:
            if _client is None:
                raise RuntimeError('Client is not connected')
            content = await fetch_services(_client)
            if content:
                return content
            raise ValueError('Service catalog is not available')

        raise ValueError(f'Unknown resource: {uri}')

    # ------------------------------------------------------------------
    # Prompts: pipeline-building workflow
    # ------------------------------------------------------------------
    @server.list_prompts()  # type: ignore[untyped-decorator,no-untyped-call]
    async def list_prompts() -> list[types.Prompt]:
        return [
            types.Prompt(
                name='build-pipeline',
                description=(
                    'Build a RocketRide data processing pipeline from a natural '
                    'language description. Uses the live service catalog from the '
                    'running engine to generate a .pipe file and SDK code.'
                ),
                arguments=[
                    types.PromptArgument(
                        name='description',
                        description='Natural language description of what the pipeline should do',
                        required=True,
                    ),
                ],
            ),
        ]

    @server.get_prompt()  # type: ignore[untyped-decorator]
    async def get_prompt(
        name: str, arguments: dict[str, str] | None
    ) -> types.GetPromptResult:
        if name != 'build-pipeline':
            raise ValueError(f'Unknown prompt: {name}')

        user_description = (arguments or {}).get('description', '')

        # Gather live services from engine
        services_text = ''
        if _client:
            services_text = await fetch_services(_client) or ''

        messages: list[types.PromptMessage] = [
            types.PromptMessage(
                role='user',
                content=types.TextContent(
                    type='text',
                    text=(
                        f'Build a RocketRide pipeline for the following request:\n\n'
                        f'{user_description}\n\n'
                        f'---\n\n'
                        f'Use the following live service catalog to generate a '
                        f'correct .pipe file and SDK code.\n\n'
                        f'## Live Service Catalog\n\n{services_text}'
                    ),
                ),
            ),
        ]

        return types.GetPromptResult(
            description='Build a RocketRide pipeline',
            messages=messages,
        )

    # ------------------------------------------------------------------
    # Run
    # ------------------------------------------------------------------
    try:
        async with mcp.server.stdio.stdio_server() as (read_stream, write_stream):
            await server.run(
                read_stream,
                write_stream,
                InitializationOptions(
                    server_name='rocketride-mcp',
                    server_version='1.1.0',
                    capabilities=server.get_capabilities(
                        notification_options=NotificationOptions(),
                        experimental_capabilities={},
                    ),
                ),
            )
    finally:
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
