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

"""MCP Resource handlers exposing RocketRide pipeline definitions and node schemas."""

from __future__ import annotations

import json
from typing import Any, Dict, List

import mcp.types as types
from rocketride import RocketRideClient

from .tools import get_tools

# Canonical resource URIs
URI_PIPELINES = 'rocketride://pipelines'
URI_STATUS = 'rocketride://status'
URI_NODES = 'rocketride://nodes'

_RESOURCES: List[Dict[str, str]] = [
    {
        'uri': URI_PIPELINES,
        'name': 'Pipeline List',
        'description': 'List of all available pipelines on the connected RocketRide server',
        'mimeType': 'application/json',
    },
    {
        'uri': URI_STATUS,
        'name': 'Server Status',
        'description': 'Current RocketRide server status and loaded pipelines',
        'mimeType': 'application/json',
    },
    {
        'uri': URI_NODES,
        'name': 'Node Registry',
        'description': 'Available pipeline node types and their schemas',
        'mimeType': 'application/json',
    },
]


async def list_resources(client: RocketRideClient | None) -> list[types.Resource]:
    """Return the static catalogue of exposed resources.

    The resource list itself is static (three well-known URIs).  The
    *contents* are dynamic and fetched lazily via ``read_resource``.
    Passing *client* keeps the signature forward-compatible for when
    we want to dynamically discover pipeline-specific resources.
    """
    resources: list[types.Resource] = []
    for entry in _RESOURCES:
        resources.append(
            types.Resource(
                uri=entry['uri'],
                name=entry['name'],
                description=entry.get('description'),
                mimeType=entry.get('mimeType'),
            )
        )
    return resources


async def read_resource(client: RocketRideClient | None, uri: str) -> str:
    """Fetch and return the JSON payload for a given resource URI.

    Returns a JSON error payload when the RocketRide client is not
    connected (``client is None``).  Raises ``ValueError`` only for
    unknown URIs.
    """
    uri_str = str(uri)

    if uri_str == URI_PIPELINES:
        return await _read_pipelines(client)
    elif uri_str == URI_STATUS:
        return await _read_status(client)
    elif uri_str == URI_NODES:
        return await _read_nodes(client)
    else:
        raise ValueError(f'Unknown resource URI: {uri_str}')


# ---------------------------------------------------------------------------
# Internal readers
# ---------------------------------------------------------------------------


async def _read_pipelines(client: RocketRideClient | None) -> str:
    """Return a JSON array of pipeline descriptors from the connected server."""
    if client is None:
        return json.dumps({'pipelines': [], 'error': 'Client is not connected'})
    try:
        tasks = await get_tools(client)
        pipelines: List[Dict[str, Any]] = []
        for task in tasks:
            pipelines.append(
                {
                    'name': task.get('name'),
                    'description': task.get('description'),
                }
            )
        return json.dumps({'pipelines': pipelines}, ensure_ascii=False)
    except Exception as exc:
        return json.dumps({'pipelines': [], 'error': str(exc)})


async def _read_status(client: RocketRideClient | None) -> str:
    """Return a JSON object describing the server's health and loaded pipelines."""
    if client is None:
        return json.dumps({'connected': False, 'error': 'Client is not connected'})
    try:
        tasks = await get_tools(client)
        return json.dumps(
            {
                'connected': True,
                'pipeline_count': len(tasks),
                'pipelines': [t.get('name') for t in tasks],
            },
            ensure_ascii=False,
        )
    except Exception as exc:
        return json.dumps({'connected': False, 'error': str(exc)})


async def _read_nodes(client: RocketRideClient | None) -> str:
    """Return a JSON object listing available node types.

    RocketRide exposes node information through the ``rrext_get_nodes``
    command.  If the server doesn't support that command (older versions),
    we fall back to returning an empty registry.
    """
    if client is None:
        return json.dumps({'nodes': [], 'error': 'Client is not connected'})
    try:
        req = client.build_request(command='rrext_get_nodes')
        resp = await client.request(req)
        body = (resp or {}).get('body') or {}
        nodes = body.get('nodes', [])
        if not isinstance(nodes, list):
            nodes = []
        return json.dumps({'nodes': nodes}, ensure_ascii=False)
    except Exception as exc:
        return json.dumps({'nodes': [], 'error': str(exc)})
