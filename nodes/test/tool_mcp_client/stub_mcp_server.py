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

If ``STUB_MCP_TOOLS_FILE`` names a readable JSON file holding a list of tool
definitions, that list is re-read on every ``tools/list`` and ``tools/call``,
so a test can add or rename tools while the server keeps running (the
catalog-staleness scenario of issue #1402). Otherwise the static ``TOOLS`` list
above is served.

``STUB_MCP_PAGE_SIZE=<n>`` makes ``tools/list`` return at most ``n`` tools per
page with a ``nextCursor``. The stub's cursor is the next offset as a string; a
client must treat it as opaque. A cursor that is not an integer, or that is below
0 or above the tool count, answers ``-32602``.

Three more options, for agent tests that launch the server from a command line
(the MCP client node passes it no environment):

- ``--tools-file PATH`` does what ``STUB_MCP_TOOLS_FILE`` does; the variable wins.
- ``--calls-log PATH`` appends one JSON line ``{"name", "arguments"}`` per
  ``tools/call`` of a known tool, so a test can read exactly which tools ran.
- A tool entry may carry ``"_stub_result": <any JSON>``. ``tools/list`` strips
  every key that starts with ``_``, and ``tools/call`` returns that value as
  ``structuredContent``, and as JSON text in ``content``, as the MCP spec asks
  of a tool that returns structured content.
"""

import argparse
import json
import os
import sys

_ARGS = argparse.Namespace(tools_file=None, calls_log=None)

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


def _current_tools():
    """Return the live tool list: the JSON file if configured, else ``TOOLS``."""
    path = os.environ.get('STUB_MCP_TOOLS_FILE') or _ARGS.tools_file
    if path:
        try:
            with open(path, 'r', encoding='utf-8') as f:
                tools = json.load(f)
            if isinstance(tools, list):
                return tools
        except (OSError, ValueError):
            pass
    return TOOLS


def _listed(tool):
    """The tool as tools/list shows it: without the stub's own ``_`` keys."""
    return {k: v for k, v in tool.items() if not k.startswith('_')} if isinstance(tool, dict) else tool


def _log_call(name, arguments):
    if not _ARGS.calls_log:
        return
    with open(_ARGS.calls_log, 'a', encoding='utf-8') as f:
        f.write(json.dumps({'name': name, 'arguments': arguments}, ensure_ascii=False) + '\n')
        f.flush()


def _page_size():
    """Return the configured tools/list page size, or 0 for a single complete page."""
    raw = os.environ.get('STUB_MCP_PAGE_SIZE', '')
    try:
        size = int(raw) if raw else 0
    except ValueError:
        size = 0
    return size if size > 0 else 0


def _invalid_cursor(msg_id, cursor):
    return {'jsonrpc': '2.0', 'id': msg_id, 'error': {'code': -32602, 'message': f'Invalid cursor: {cursor!r}'}}


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
        tools = [_listed(t) for t in _current_tools()]
        page_size = _page_size()
        if not page_size:
            return {'jsonrpc': '2.0', 'id': msg_id, 'result': {'tools': tools}}
        cursor = params.get('cursor')
        try:
            offset = int(cursor) if cursor is not None else 0
        except (TypeError, ValueError):
            return _invalid_cursor(msg_id, cursor)
        if offset < 0 or offset > len(tools):
            return _invalid_cursor(msg_id, cursor)
        result = {'tools': tools[offset : offset + page_size]}
        if offset + page_size < len(tools):
            result['nextCursor'] = str(offset + page_size)
        return {'jsonrpc': '2.0', 'id': msg_id, 'result': result}

    if method == 'tools/call':
        name = params.get('name')
        arguments = params.get('arguments', {})
        known = {t['name']: t for t in _current_tools()}
        if name not in known:
            return {
                'jsonrpc': '2.0',
                'id': msg_id,
                'error': {'code': -32602, 'message': f'Tool {name} not found'},
            }
        _log_call(name, arguments)
        # Echo back exactly what we received so tests can assert on it.
        result = {
            'content': [{'type': 'text', 'text': f'called {name}'}],
            'received_arguments': arguments,
        }
        if '_stub_result' in known[name]:
            canned = known[name]['_stub_result']
            result['content'] = [{'type': 'text', 'text': json.dumps(canned, ensure_ascii=False)}]
            result['structuredContent'] = canned
        return {'jsonrpc': '2.0', 'id': msg_id, 'result': result}

    return {
        'jsonrpc': '2.0',
        'id': msg_id,
        'error': {'code': -32601, 'message': f'Method not found: {method}'},
    }


def main():
    global _ARGS
    parser = argparse.ArgumentParser(description='Minimal stdio MCP server for tests.')
    parser.add_argument('--tools-file', default=None, help='JSON file with the tool list (STUB_MCP_TOOLS_FILE wins)')
    parser.add_argument('--calls-log', default=None, help='append one JSON line per tools/call to this file')
    _ARGS = parser.parse_args()
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
