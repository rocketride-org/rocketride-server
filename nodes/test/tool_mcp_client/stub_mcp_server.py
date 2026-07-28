#!/usr/bin/env python3
# =============================================================================
# RocketRide Engine
# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
Minimal stdio MCP server for testing tool_mcp_client.

Speaks line-delimited JSON-RPC over stdin/stdout (the same transport
``McpStdioClient`` drives). It intentionally exposes zero-argument tools in the
two degenerate shapes we care about, plus a normal tool as a control:

- ``no_schema_tool``    — tool advertised with NO ``inputSchema`` key at all.
- ``empty_props_tool``  — tool with an explicit ``{'type':'object','properties':{}}``.
- ``echo_tool``         — tool with a real required argument.

``tools/call`` echoes back the exact ``arguments`` object the server received
under ``received_arguments`` so tests can assert that the synthesized no-op
placeholder (``rr_no_args``) is stripped before the call reaches the server.
"""

import json
import sys

TOOLS = [
    {
        'name': 'no_schema_tool',
        'description': 'Zero-argument tool advertised with no inputSchema.',
        # NOTE: deliberately omit 'inputSchema' entirely.
    },
    {
        'name': 'empty_props_tool',
        'description': 'Zero-argument tool with an explicit empty properties map.',
        'inputSchema': {'type': 'object', 'properties': {}},
    },
    {
        'name': 'echo_tool',
        'description': 'Control tool that takes a real required argument.',
        'inputSchema': {
            'type': 'object',
            'properties': {'msg': {'type': 'string', 'description': 'Message to echo'}},
            'required': ['msg'],
        },
    },
]


def _write(msg):
    sys.stdout.write(json.dumps(msg, ensure_ascii=False) + '\n')
    sys.stdout.flush()


def _handle(msg):
    """Return a JSON-RPC response dict, or None for notifications."""
    if not isinstance(msg, dict):
        return None
    method = msg.get('method')
    msg_id = msg.get('id')
    params = msg.get('params') or {}

    # Notifications carry no id and expect no response.
    if msg_id is None:
        return None

    if method == 'initialize':
        return {
            'jsonrpc': '2.0',
            'id': msg_id,
            'result': {
                'protocolVersion': params.get('protocolVersion', '2024-11-05'),
                'capabilities': {'tools': {}},
                'serverInfo': {'name': 'stub-mcp', 'version': '0.1.0'},
            },
        }

    if method == 'tools/list':
        return {'jsonrpc': '2.0', 'id': msg_id, 'result': {'tools': TOOLS}}

    if method == 'tools/call':
        name = params.get('name')
        arguments = params.get('arguments', {})
        known = {t['name'] for t in TOOLS}
        if name not in known:
            return {
                'jsonrpc': '2.0',
                'id': msg_id,
                'error': {'code': -32602, 'message': f'Tool {name} not found'},
            }
        # Echo back exactly what we received so tests can assert on it.
        return {
            'jsonrpc': '2.0',
            'id': msg_id,
            'result': {
                'content': [{'type': 'text', 'text': f'called {name}'}],
                'received_arguments': arguments,
            },
        }

    return {
        'jsonrpc': '2.0',
        'id': msg_id,
        'error': {'code': -32601, 'message': f'Method not found: {method}'},
    }


def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except Exception:
            continue
        response = _handle(msg)
        if response is not None:
            _write(response)


if __name__ == '__main__':
    main()
