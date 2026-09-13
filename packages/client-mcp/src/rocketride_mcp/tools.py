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
import os
import urllib.parse
from pathlib import Path
from typing import Any, Dict, List, Optional

import httpx

from rocketride import RocketRideClient

# Remote MCP clients cannot place files on the server's disk, so every tool
# accepts inline content or a URL in addition to a local filepath.
_ONE_OF_HINT = 'Provide exactly one of filepath, content, or url.'
_MAX_URL_BYTES = 50 * 1024 * 1024
_URL_FETCH_TIMEOUT = 30.0


def _input_schema() -> Dict[str, Any]:
    """Return the shared JSON schema for pipeline tool arguments."""
    return {
        'type': 'object',
        'properties': {
            'filepath': {
                'type': 'string',
                'description': f'Path to a local file on the machine running the MCP server. {_ONE_OF_HINT}',
            },
            'content': {
                'type': 'string',
                'description': f'Inline text to process, sent to the pipeline as UTF-8 bytes. {_ONE_OF_HINT}',
            },
            'url': {
                'type': 'string',
                'description': f'http(s) URL to download and process (max 50 MB). {_ONE_OF_HINT}',
            },
            'filename': {
                'type': 'string',
                'description': (
                    'Optional display name for the data. Defaults to the file basename for filepath, '
                    '"content.txt" for content, and the URL basename for url.'
                ),
            },
        },
        'required': [],
    }


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
                'inputSchema': _input_schema(),
            }
        )

    for tool in _get_convenience_tools():
        formatted.append(tool)
    return formatted


async def _fetch_url(url: str) -> Dict[str, Any]:
    """Download a URL body, capped at 50 MB. Returns {'data': bytes} or an error dict."""
    try:
        async with httpx.AsyncClient(follow_redirects=True, timeout=_URL_FETCH_TIMEOUT) as http_client:
            async with http_client.stream('GET', url) as response:
                response.raise_for_status()
                declared = response.headers.get('content-length') or ''
                if declared.strip().isdigit() and int(declared) > _MAX_URL_BYTES:
                    return {'error': 'URL content exceeds 50 MB limit', 'status': 400}
                chunks: List[bytes] = []
                total = 0
                async for chunk in response.aiter_bytes():
                    total += len(chunk)
                    if total > _MAX_URL_BYTES:
                        return {'error': 'URL content exceeds 50 MB limit', 'status': 400}
                    chunks.append(chunk)
        return {'data': b''.join(chunks)}
    except httpx.HTTPStatusError as e:
        return {'error': f'Failed to fetch URL: HTTP {e.response.status_code}', 'status': 502}
    except Exception as e:
        reason = str(e).strip().splitlines()[0] if str(e).strip() else type(e).__name__
        return {'error': f'Failed to fetch URL: {reason[:200]}', 'status': 502}


async def execute_tool(
    *,
    client: RocketRideClient,
    name: Optional[str],
    filepath: Optional[str] = None,
    content: Optional[str] = None,
    url: Optional[str] = None,
    filename: Optional[str] = None,
) -> Dict[str, Any]:
    """Execute a tool by sending data to a running pipeline.

    The data comes from exactly one of a local ``filepath``, inline ``content``,
    or a downloadable ``url``. It is sent to a running pipeline (by token) or to
    a convenience pipeline that is started on-the-fly.
    """
    supplied = [v for v in (filepath, content, url) if isinstance(v, str) and v.strip()]
    if len(supplied) != 1:
        return {'error': 'Provide exactly one of filepath, content, or url', 'status': 400}

    requested_name = (filename or '').strip()
    resolved_path: Optional[str] = None

    if isinstance(filepath, str) and filepath.strip():
        source = 'filepath'
        filepath = filepath.strip()
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

        effective_name = requested_name or os.path.basename(resolved_path)
    elif isinstance(content, str) and content.strip():
        source = 'content'
        effective_name = requested_name or 'content.txt'
    else:
        source = 'url'
        url = (url or '').strip()
        if urllib.parse.urlparse(url).scheme not in ('http', 'https'):
            return {'error': 'URL must be http or https', 'status': 400}
        effective_name = requested_name or os.path.basename(urllib.parse.urlparse(url).path or '') or 'download'

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

    objinfo: Dict[str, Any] = {'name': effective_name}
    if source == 'filepath':
        with open(str(resolved_path), 'rb') as f:
            binary_data = f.read()
        objinfo['filepath'] = resolved_path
    elif source == 'url':
        fetched = await _fetch_url(str(url))
        if 'data' not in fetched:
            return fetched
        binary_data = fetched['data']
        # Deliberately not placed in objinfo: the engine parses an objinfo
        # 'url' field as a pipe source and rejects the https scheme.
    else:
        binary_data = (content or '').encode('utf-8')

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
                    objinfo=objinfo,
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
            objinfo=objinfo,
        )

    response: Dict[str, Any] = {'status': 200, 'result': result, 'name': name, 'filename': effective_name}
    if source == 'filepath':
        response['filepath'] = resolved_path
    elif source == 'url':
        response['url'] = url
    return response


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
                    'description': f'Convenience tool: {name.replace("_", " ")}. {_ONE_OF_HINT}',
                    'inputSchema': _input_schema(),
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
