# =============================================================================
# MIT License
# Copyright (c) 2026 RocketRide, Inc.
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
import os
import urllib.parse
from pathlib import Path
from typing import Any, Dict, List, Optional

from rocketride import RocketRideClient


async def get_tools(client: RocketRideClient) -> List[Dict[str, Any]]:
    """Return list of available tasks for the authenticated user."""
    req = client.build_request(command='rrext_get_tasks')
    resp = await client.request(req)
    body = (resp or {}).get('body') or {}
    raw_tasks = body.get('tasks', [])
    if not isinstance(raw_tasks, list):
        return []
    return [t for t in raw_tasks if isinstance(t, dict)]


def format_tools(tasks: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Convert server task descriptors to MCP tool entries with JSON schema."""
    formatted: List[Dict[str, Any]] = []
    for task in tasks or []:
        name = task.get('name')
        description = task.get('description')
        formatted.append(
            {
                'name': name,
                'description': description,
                'inputSchema': {
                    'type': 'object',
                    'properties': {
                        'filepath': {'type': 'string', 'description': 'Path to file to process'},
                    },
                    'required': ['filepath'],
                },
            }
        )

    for tool in _get_convenience_tools():
        formatted.append(tool)
    return formatted


async def execute_tool(
    *,
    client: RocketRideClient,
    filepath: Optional[str],
    name: Optional[str],
) -> Dict[str, Any]:
    """Execute a tool by sending file bytes to a running pipeline.

    Sends file bytes to a running pipeline (by token) or to a convenience
    pipeline that is started on-the-fly.
    """
    if not filepath:
        return {'error': 'filepath is required', 'status': 400}
    filepath = filepath.strip()
    if not filepath:
        return {'error': 'filepath is required', 'status': 400}
    # Resolve and validate path
    try:
        decoded = urllib.parse.unquote(filepath)
        if decoded.startswith('file://'):
            parsed = urllib.parse.urlparse(decoded)
            decoded = parsed.path or ''
        resolved_path = str(Path(decoded).expanduser().resolve(strict=True))
    except Exception:
        return {'error': 'Invalid filepath', 'status': 400}

    if not Path(resolved_path).is_file():
        return {'error': 'Filepath must point to a file', 'status': 400}

    filename = os.path.basename(resolved_path)

    # Lookup pipeline from running tasks
    pipeline_obj: Optional[Dict[str, Any]] = None
    pipeline_token: Optional[str] = None

    tools = await get_tools(client)
    convenience_tool = False

    for tool in tools:
        if tool.get('name') == name:
            pipeline_obj = tool.get('pipeline')
            pipeline_token = tool.get('token')
            break

    if not pipeline_obj:
        pipeline_obj = _load_convenience_pipeline(name)
        convenience_tool = bool(pipeline_obj)

    if not pipeline_obj:
        return {'error': f'Tool "{name}" not found', 'status': 404}

    with open(resolved_path, 'rb') as f:
        binary_data = f.read()

    if convenience_tool:
        pipeline = await client.use(pipeline=pipeline_obj)
        convenience_token = (pipeline or {}).get('token')
        if not isinstance(convenience_token, str):
            return {'error': 'Failed to start pipeline', 'status': 502}

        # Retry logic for new pipelines
        for attempt in range(5):
            try:
                result = await client.send(
                    convenience_token,
                    binary_data,
                    objinfo={'name': filename, 'filepath': resolved_path},
                )
                break
            except RuntimeError as e:
                # Re-raise if not a connection error or out of retries
                is_conn_err = any(x in str(e) for x in ['Connect call failed', 'Connection refused'])
                if not is_conn_err or attempt == 4:
                    raise e
                await asyncio.sleep(0.5 * (2**attempt))
    else:
        if not isinstance(pipeline_token, str):
            return {'error': 'Pipeline token not available', 'status': 502}
        result = await client.send(
            pipeline_token,
            binary_data,
            objinfo={'name': filename, 'filepath': resolved_path},
        )

    return {'status': 200, 'result': result, 'name': name, 'filepath': resolved_path}


_CONVENIENCE_TOOL_MAPPING = {
    'RocketRide_Document_Processor': 'simpleparser.json',
}


def _get_convenience_tools() -> List[Dict[str, Any]]:
    tools: List[Dict[str, Any]] = []
    for name, filename in _CONVENIENCE_TOOL_MAPPING.items():
        pipeline = _load_pipeline_json(filename)
        if pipeline:
            tools.append(
                {
                    'name': name,
                    'description': f'Convenience tool: {name.replace("_", " ")}',
                    'inputSchema': {
                        'type': 'object',
                        'properties': {
                            'filepath': {'type': 'string', 'description': 'Path to file to process'},
                        },
                        'required': ['filepath'],
                    },
                    'pipeline': pipeline,
                }
            )
    return tools


def _load_convenience_pipeline(tool_name: Optional[str]) -> Optional[Dict[str, Any]]:
    if not tool_name or tool_name not in _CONVENIENCE_TOOL_MAPPING:
        return None
    return _load_pipeline_json(_CONVENIENCE_TOOL_MAPPING[tool_name])


def _load_pipeline_json(filename: str) -> Optional[Dict[str, Any]]:
    try:
        base_dir = Path(__file__).parent / 'pipelines'
        path = base_dir / filename
        with open(path, 'r', encoding='utf-8') as f:
            data: Dict[str, Any] = json.load(f)
        return data
    except Exception:
        return None
