# Copyright 2026 Aparavi Software AG. MIT License.
"""MCP resources: deployments and server status.

`rocketride://nodes` is removed -- superseded by the `list_components` tool
and the static Skills map (knowledge lives in Skills, not a resource).
"""

import asyncio
import json
from typing import List

import mcp.types as types

from .engine import EngineClient
from .tools._common import DEFAULT_TIMEOUT_SECONDS

# Public: handlers.py keys its per-URI cache TTLs off these — a renamed
# URI must fail loudly there, not silently fall through to ttl_ms=0.
PIPELINES_URI = 'rocketride://pipelines'
STATUS_URI = 'rocketride://status'


def list_resources() -> List[types.Resource]:
    return [
        types.Resource(
            uri=PIPELINES_URI,
            name='Deployments',
            description='Deployments registered on the connected RocketRide server',
            mime_type='application/json',
        ),
        types.Resource(
            uri=STATUS_URI,
            name='Server Status',
            description='Current RocketRide server status and running tasks',
            mime_type='application/json',
        ),
    ]


async def read_resource(engine: EngineClient, uri: str) -> str:
    # Same seam bound the tool handlers use (tools/_common.py): a wedged or
    # half-open engine WS must fail the read promptly, not hold the request
    # open unbounded. TimeoutError propagates — resource reads have no in-band
    # error envelope, so the SDK surfaces it as a request error.
    uri = str(uri)
    if uri == PIPELINES_URI:
        return json.dumps(await asyncio.wait_for(engine.deploy_list(), timeout=DEFAULT_TIMEOUT_SECONDS))
    if uri == STATUS_URI:
        tasks = await asyncio.wait_for(engine.list_tasks(), timeout=DEFAULT_TIMEOUT_SECONDS)
        names = [t.get('name') for t in tasks if t.get('name')]
        # Count ALL running tasks; `pipelines` lists only the resolvable names.
        return json.dumps({'connected': True, 'pipeline_count': len(tasks), 'pipelines': names})
    raise ValueError(f'Unknown resource: {uri}')
